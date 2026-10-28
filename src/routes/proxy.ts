import { Hono } from 'hono'

import { proxyAuth } from '../middleware/auth.js'
import { createErrorResponse, ProviderRequestError } from '../providers/base-provider.js'
import { providerFactory } from '../providers/provider-factory.js'
import { AffinityManager } from '../services/affinity-manager.js'
import { ConcurrencyLimiter } from '../services/concurrency-limiter.js'
import { LoadBalancer } from '../services/load-balancer.js'
import { DbMetricsCollector } from '../services/metrics/db-collector.js'
import { RequestRecorder } from '../services/request-recorder.js'

import type { BaseProvider, StandardizedRequest } from '../providers/base-provider.js'
import type { ResponseRecordingError } from '../services/request-recorder.js'
import type { BackendConfig, ProviderType } from '../types/backend.js'
import type { HonoEnv } from '../types/context.js'
import type { Context } from 'hono'

const proxyApp = new Hono<HonoEnv>()
proxyApp.use('*', proxyAuth)

export function getOrderedBackendsForFallback(
  all: BackendConfig[],
  current: BackendConfig,
  tried: Set<string>
): BackendConfig[] {
  const index = all.findIndex((backend) => backend.id === current.id)
  if (index < 0) return all.filter((backend) => !tried.has(backend.id))
  return Array.from({ length: all.length - 1 }, (_, i) => all[(index + i + 1) % all.length]).filter(
    (backend) => !tried.has(backend.id)
  )
}

export function getOrGenerateRequestId(c: Context): string {
  return c.req.header('x-request-id') || crypto.randomUUID()
}

function responseHeaders(headers: Headers): Headers {
  const result = new Headers(headers)
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection'])
    result.delete(name)
  return result
}

class TTFTTimeout extends Error {}
class InvalidJSON extends Error {}

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

class ResponseCapture {
  private buffer = new Uint8Array(0)
  private length = 0
  truncated = false

  append(chunk: Uint8Array): void {
    const size = Math.min(chunk.byteLength, MAX_RESPONSE_BYTES - this.length)
    if (size < chunk.byteLength) this.truncated = true
    if (!size) return
    const required = this.length + size
    if (required > this.buffer.byteLength) {
      const grown = new Uint8Array(
        Math.min(MAX_RESPONSE_BYTES, Math.max(required, this.buffer.byteLength * 2, 64 * 1024))
      )
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(chunk.subarray(0, size), this.length)
    this.length += size
  }

  bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length)
  }
}

async function tryBackend(
  c: Context<HonoEnv>,
  provider: BaseProvider,
  backend: BackendConfig,
  request: StandardizedRequest,
  sessionId?: string
): Promise<{ success: boolean; response: Response }> {
  const db = c.env.DB
  const limiter = new ConcurrencyLimiter(c.env.CONCURRENCY)
  const metrics = new DbMetricsCollector(db)
  const affinity = new AffinityManager(db)
  const recorder = new RequestRecorder(db, c.env.RECORDINGS)
  const capture =
    backend.recordRequests && backend.recordResponses ? new ResponseCapture() : undefined
  let recording: Promise<string | null> | undefined
  let upstreamStatus: number | null = null
  let upstreamHeaders: Record<string, string> | null = null
  const slotId = crypto.randomUUID()
  const start = Date.now()
  const limited = (backend.maxConcurrentRequests ?? 0) > 0
  if (limited && !(await limiter.tryAcquire(backend, slotId))) {
    return {
      success: false,
      response: createErrorResponse(
        `Backend ${backend.id} is at capacity`,
        'rate_limit_exceeded',
        'all_backends_at_capacity',
        429
      ),
    }
  }

  let completed = false
  const captureChunk = (chunk: Uint8Array) => {
    if (!completed) capture?.append(chunk)
  }
  const finish = (success: boolean, ttft?: number, error: ResponseRecordingError | null = null) => {
    if (completed) return
    completed = true
    if (limited) c.executionCtx.waitUntil(limiter.release(backend.id, slotId))
    c.executionCtx.waitUntil(
      (async () => {
        const statements = [
          metrics.completionStatement({
            backendId: backend.id,
            requestId: slotId,
            status: success ? 'success' : 'failure',
            duration: Date.now() - start,
            ttft,
            streamType: request.stream ? 'streaming' : 'non-streaming',
            model: request.model,
          }),
        ]
        if (success && sessionId)
          statements.push(affinity.upsertStatement(request.model, sessionId, backend.id))
        await db.batch(statements)
      })().catch((error) => console.error('Request completion batch failed', error))
    )

    if (capture && recording) {
      const noBody = error === 'ttft_timeout' || error === 'network_error'
      // Freeze metadata and captured bytes at completion, before waiting for the
      // request INSERT. A fast upstream must not update a row that does not exist.
      const responseData = {
        status: noBody ? null : upstreamStatus,
        headers: noBody ? null : upstreamHeaders,
        body: !noBody && upstreamStatus !== null ? capture.bytes() : undefined,
        error,
        truncated: !noBody && capture.truncated,
        completedAt: Date.now(),
      }
      c.executionCtx.waitUntil(
        recording
          .then(async (id) => {
            if (id) await recorder.recordResponse(id, responseData)
          })
          .catch((error) => console.error('Response recording failed', error))
      )
    }
  }

  const abort = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = (reason: unknown) => {
    abort.abort(reason)
    if (reader) c.executionCtx.waitUntil(reader.cancel(reason).catch(() => undefined))
  }
  const onAbort = () => {
    finish(false, undefined, 'client_disconnected')
    cancel(c.req.raw.signal.reason)
  }
  c.req.raw.signal.addEventListener('abort', onAbort, { once: true })
  const detach = () => c.req.raw.signal.removeEventListener('abort', onAbort)
  try {
    if (c.req.raw.signal.aborted) throw new Error('Client disconnected')
    const body = JSON.stringify(provider.prepareRequestBody(request, backend))
    const url = provider.getTargetUrl(backend, request)
    const headers = await provider.prepareHeaders(
      backend,
      request.stream,
      url,
      request.originalHeaders,
      body
    )
    if (abort.signal.aborted) throw abort.signal.reason
    if (backend.recordRequests) {
      recording = recorder
        .recordRequest(backend, request.model, url, headers, body)
        .catch((error) => {
          console.error('Request recording failed', error)
          return null
        })
      c.executionCtx.waitUntil(recording)
    }
    const timeout = request.stream ? backend.streamingTTFTTimeout : backend.nonStreamingTTFTTimeout
    const operation = async () => {
      const response = await fetch(url, { method: 'POST', headers, body, signal: abort.signal })
      if (abort.signal.aborted) {
        if (response.body) await response.body.cancel(abort.signal.reason)
        throw abort.signal.reason
      }
      upstreamStatus = response.status
      upstreamHeaders = Object.fromEntries(response.headers.entries())
      if (!response.ok && !capture) return { response }
      reader = response.body?.getReader()
      if (response.ok && request.stream) {
        if (!reader) throw new Error('No response body')
        const first = await reader.read()
        if (!first.done) captureChunk(first.value)
        return { response, first }
      }
      const chunks: Uint8Array[] = []
      let length = 0
      if (reader) {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          chunks.push(chunk.value)
          length += chunk.value.byteLength
          captureChunk(chunk.value)
        }
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { response, bytes }
    }
    const work = operation()
    const result =
      timeout && timeout > 0
        ? await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  const error = new TTFTTimeout('TTFT timeout exceeded')
                  cancel(error)
                  reject(error)
                },
                Math.max(0, timeout - (Date.now() - start))
              )
            }),
          ])
        : await work
    if (timer) clearTimeout(timer)
    if (c.req.raw.signal.aborted) throw new Error('Client disconnected')
    const { response } = result
    if (!response.ok) {
      finish(false)
      detach()
      return {
        success: false,
        response: new Response(
          response.status === 304 ? null : capture ? result.bytes : response.body,
          {
            status: response.status,
            headers: responseHeaders(response.headers),
          }
        ),
      }
    }
    const ttft = Date.now() - start
    if (!request.stream) {
      const bytes = result.bytes!
      try {
        JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        throw new InvalidJSON('Invalid JSON response from backend')
      }
      finish(true, ttft)
      detach()
      return {
        success: true,
        response: new Response(bytes, {
          status: response.status,
          headers: responseHeaders(response.headers),
        }),
      }
    }
    const upstream = reader!
    const first = result.first!
    if (first.done) {
      finish(true, ttft)
      detach()
    }
    let pendingFirst = !first.done
    const bodyStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (pendingFirst) {
            pendingFirst = false
            controller.enqueue(first.value!)
            return
          }
          const chunk = first.done ? { done: true as const } : await upstream.read()
          if (chunk.done) {
            controller.close()
            finish(true, ttft)
            detach()
          } else {
            captureChunk(chunk.value)
            controller.enqueue(chunk.value)
          }
        } catch (error) {
          finish(
            false,
            undefined,
            c.req.raw.signal.aborted ? 'client_disconnected' : 'stream_interrupted'
          )
          detach()
          cancel(error)
          controller.error(error)
        }
      },
      async cancel(reason) {
        finish(false, undefined, 'client_disconnected')
        detach()
        abort.abort(reason)
        await upstream.cancel(reason)
      },
    })
    return {
      success: true,
      response: new Response(bodyStream, {
        status: response.status,
        headers: responseHeaders(response.headers),
      }),
    }
  } catch (error) {
    const errorType: ResponseRecordingError = c.req.raw.signal.aborted
      ? 'client_disconnected'
      : error instanceof TTFTTimeout
        ? 'ttft_timeout'
        : error instanceof InvalidJSON
          ? 'invalid_json'
          : 'network_error'
    finish(false, undefined, errorType)
    cancel(error)
    detach()
    const invalidJSON = errorType === 'invalid_json'
    const timedOut = errorType === 'ttft_timeout'
    return {
      success: false,
      response: createErrorResponse(
        timedOut
          ? 'TTFT timeout exceeded'
          : invalidJSON
            ? 'Invalid JSON response from backend'
            : 'Backend request failed',
        timedOut ? 'timeout_error' : invalidJSON ? 'internal_error' : 'backend_error',
        timedOut ? 'ttft_timeout' : invalidJSON ? 'internal_error' : 'network_error',
        timedOut ? 504 : 500
      ),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createProxyHandler(providerType: ProviderType) {
  return async (c: Context<HonoEnv>): Promise<Response> => {
    const provider = providerFactory.getProvider(providerType)
    let request: StandardizedRequest
    try {
      const body = await provider.readBody(c)
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error('JSON object is required')
      provider.validateRequest(c, body)
      request = provider.parseRequest(c, body)
    } catch (error) {
      return createErrorResponse(
        error instanceof Error ? error.message : 'Invalid request',
        'invalid_request_error',
        error instanceof ProviderRequestError ? error.code : 'validation_failed',
        error instanceof ProviderRequestError ? error.status : 400
      )
    }
    if (!c.get('apiKey').models.includes(request.model))
      return createErrorResponse(
        `API key does not have permission to access model: ${request.model}`,
        'permission_denied',
        'model_not_allowed',
        403
      )
    const model = c.get('models').find((model) => model.model === request.model)
    if (!model)
      return createErrorResponse(
        `Model configuration for ${request.model} not found`,
        'invalid_request_error',
        'model_not_found',
        400
      )
    if (model.provider !== providerType)
      return createErrorResponse(
        'Model provider does not match request format',
        'invalid_request_error',
        'provider_mismatch',
        400
      )
    const candidates = model.backends.filter((backend) => backend.enabled)
    const forcedId = c.req.header('X-Backend-ID')
    const sessionId = model.enableAffinity ? c.req.header('X-Session-ID') : undefined
    let backend: BackendConfig | null | undefined
    try {
      if (!forcedId && sessionId)
        backend = await new AffinityManager(c.env.DB).getAffinityBackend(
          model.model,
          sessionId,
          candidates,
          c.executionCtx
        )
      backend ??= await new LoadBalancer(new DbMetricsCollector(c.env.DB)).selectBackend(
        model,
        forcedId,
        request.stream
      )
    } catch (error) {
      return createErrorResponse(
        error instanceof Error ? error.message : 'Invalid backend',
        'invalid_request_error',
        'invalid_backend',
        400
      )
    }
    if (!backend)
      return createErrorResponse(
        'No enabled backends available',
        'service_unavailable',
        'no_backend',
        503
      )
    let currentBackend: BackendConfig = backend
    const tried = new Set<string>()
    while (true) {
      tried.add(currentBackend.id)
      const result = await tryBackend(c, provider, currentBackend, request, sessionId)
      if (result.success) return result.response
      const next: BackendConfig | undefined = getOrderedBackendsForFallback(
        candidates,
        currentBackend,
        tried
      )[0]
      if (!next || c.req.raw.signal.aborted) return result.response
      c.executionCtx.waitUntil(
        result.response.body?.cancel().catch(() => undefined) ?? Promise.resolve()
      )
      currentBackend = next
    }
  }
}

proxyApp.post('/chat/completions', createProxyHandler('openai'))
proxyApp.post('/systemone', createProxyHandler('jev'))
proxyApp.post('/model/:modelId/invoke', createProxyHandler('bedrock'))
proxyApp.post('/model/:modelId/invoke-with-response-stream', createProxyHandler('bedrock'))
export default proxyApp
