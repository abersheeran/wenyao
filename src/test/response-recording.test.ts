import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import worker from '../index.js'
import {
  admin,
  count,
  createTestBedrockBackend,
  createTestOpenAIBackend,
  jsonResponse,
  MODEL,
  modelConfig,
  proxy,
  PROXY_KEY,
  seed,
  upstream,
} from './helpers.js'
import { RequestRecorder } from '../services/request-recorder.js'

import type { BackendConfig } from '../types/backend.js'

interface RecordedResponse {
  status: number | null
  headers: Record<string, string> | null
  body: string
  bodyEncoding: 'utf8' | 'base64'
  error: string | null
  truncated: boolean
  completedAt: string
}

interface Recorded {
  _id: string
  backendId: string
  body: string
  response: RecordedResponse | null
}

const RESPONSE_LIMIT = 10 * 1024 * 1024
const encoder = new TextEncoder()

function recordingBackend(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return createTestOpenAIBackend({ recordRequests: true, recordResponses: true, ...overrides })
}

async function recordedRequests(): Promise<Recorded[]> {
  const response = await admin('/recorded-requests')
  expect(response.status).toBe(200)
  const result = (await response.json()) as { requests: Recorded[]; total: number }
  expect(result.total).toBe(result.requests.length)
  return result.requests
}

async function onlyRecording(): Promise<Recorded> {
  const recordings = await recordedRequests()
  expect(recordings).toHaveLength(1)
  return recordings[0]
}

function fromBase64(body: string): Uint8Array {
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0))
}

async function startStreamingProxy() {
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request('https://proxy.example/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PROXY_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    }),
    env,
    context
  )
  expect(response.status).toBe(200)
  return { response, context }
}

describe('Response recording', () => {
  it('preserves an empty HTTP 304 response while recording its original status', async () => {
    await seed(modelConfig({ backends: [recordingBackend()] }))
    upstream(() => new Response(null, { status: 304, headers: { ETag: 'original' } }))
    const context = createExecutionContext()
    const response = await worker.fetch(
      new Request('https://proxy.example/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${PROXY_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }] }),
      }),
      env,
      context
    )
    expect(response.status).toBe(304)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
    await waitOnExecutionContext(context)
    expect((await onlyRecording()).response).toMatchObject({
      status: 304,
      headers: { etag: 'original' },
      body: '',
      error: null,
      truncated: false,
    })
  })

  it('records non-streaming 2xx status, original headers and original UTF-8 bytes on list and get', async () => {
    await seed(modelConfig({ backends: [recordingBackend()] }))
    const body = ' { "message": "文鳐", "ok": true }\n'
    const bytes = encoder.encode(body)
    upstream(
      () =>
        new Response(bytes, {
          status: 201,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': '9999',
            'Content-Encoding': 'gzip',
            'X-Upstream-Trace': 'original-trace',
          },
        })
    )
    const response = await proxy()
    expect(response.status).toBe(201)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(response.headers.has('content-length')).toBe(false)
    expect(response.headers.has('content-encoding')).toBe(false)
    const recorded = await onlyRecording()
    expect(recorded.response).toEqual({
      status: 201,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '9999',
        'content-encoding': 'gzip',
        'x-upstream-trace': 'original-trace',
      },
      body,
      bodyEncoding: 'utf8',
      error: null,
      truncated: false,
      completedAt: expect.any(String),
    })
    expect(Date.parse(recorded.response!.completedAt)).not.toBeNaN()
    const detail = (await (await admin(`/recorded-requests/${recorded._id}`)).json()) as {
      request: Recorded
    }
    expect(detail.request).toEqual(recorded)
    expect(
      new Uint8Array(
        await (await env.RECORDINGS.get(`recorded-responses/${recorded._id}`))!.arrayBuffer()
      )
    ).toEqual(bytes)
    // Existing replay consumers still receive the original request body.
    expect(JSON.parse(recorded.body).model).toBe(MODEL)
  })

  it('records the failed HTTP attempt before fallback returns the second backend success', async () => {
    await seed(
      modelConfig({
        backends: [
          recordingBackend(),
          recordingBackend({
            id: 'b2',
            connectionId: 'openai-second',
          }),
        ],
      })
    )
    const failedBody = 'upstream capacity exhausted\n'
    upstream((request) =>
      new URL(request.url).hostname === 'b1.example'
        ? new Response(failedBody, {
            status: 503,
            headers: { 'Content-Type': 'text/plain', 'X-Error-Trace': 'failed-first' },
          })
        : jsonResponse({ recovered: true })
    )
    const response = await proxy({}, { 'X-Backend-ID': 'b1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ recovered: true })
    const recordings = await recordedRequests()
    expect(recordings).toHaveLength(2)
    expect(recordings.find((item) => item.backendId === 'b1')!.response).toMatchObject({
      status: 503,
      headers: { 'content-type': 'text/plain', 'x-error-trace': 'failed-first' },
      body: failedBody,
      bodyEncoding: 'utf8',
      error: null,
      truncated: false,
    })
    expect(recordings.find((item) => item.backendId === 'b2')!.response).toMatchObject({
      status: 200,
      body: '{"recovered":true}',
      error: null,
    })
  })

  it('returns a final non-2xx body unchanged after reading it for recording', async () => {
    await seed(modelConfig({ backends: [recordingBackend()] }))
    const body = ' { "error": "unavailable" }\n'
    upstream(
      () => new Response(body, { status: 502, headers: { 'Content-Type': 'application/json' } })
    )
    const response = await proxy()
    expect(response.status).toBe(502)
    expect(await response.text()).toBe(body)
    expect((await onlyRecording()).response).toMatchObject({ status: 502, body, error: null })
  })

  it('records OpenAI SSE bytes exactly as delivered across split UTF-8 chunks', async () => {
    await seed(modelConfig({ backends: [recordingBackend()] }))
    const bytes = encoder.encode('data: {"text":"文鳐"}\r\n\r\ndata: [DONE]\n\n')
    upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 17))
              controller.enqueue(bytes.slice(17, 18))
              controller.enqueue(bytes.slice(18))
              controller.close()
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
    )
    const response = await proxy({ stream: true })
    const clientBytes = new Uint8Array(await response.arrayBuffer())
    const recorded = await onlyRecording()
    expect(clientBytes).toEqual(bytes)
    expect(recorded.response).toMatchObject({
      status: 200,
      bodyEncoding: 'utf8',
      error: null,
      truncated: false,
    })
    expect(encoder.encode(recorded.response!.body)).toEqual(clientBytes)
    expect(
      new Uint8Array(
        await (await env.RECORDINGS.get(`recorded-responses/${recorded._id}`))!.arrayBuffer()
      )
    ).toEqual(clientBytes)
  })

  it('records Bedrock event-stream as base64 without changing binary bytes', async () => {
    const model = 'anthropic.claude-3-5-sonnet-20240620-v1:0'
    await seed(
      modelConfig({
        model,
        provider: 'bedrock',
        backends: [createTestBedrockBackend({ recordRequests: true, recordResponses: true })],
      })
    )
    const bytes = new Uint8Array([0, 0, 0, 32, 255, 254, 128, 0, 13, 10, 255, 128, 1])
    upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 6))
              controller.enqueue(bytes.slice(6))
              controller.close()
            },
          }),
          { headers: { 'Content-Type': 'application/vnd.amazon.eventstream' } }
        )
    )
    const response = await proxy(
      {},
      {},
      `/v1/model/${encodeURIComponent(model)}/invoke-with-response-stream`
    )
    const clientBytes = new Uint8Array(await response.arrayBuffer())
    const recorded = await onlyRecording()
    expect(clientBytes).toEqual(bytes)
    expect(recorded.response).toMatchObject({
      status: 200,
      bodyEncoding: 'base64',
      error: null,
      truncated: false,
    })
    expect(fromBase64(recorded.response!.body)).toEqual(clientBytes)
  })

  it.each(['client', 'upstream'] as const)(
    'keeps the received stream prefix when interrupted by %s',
    async (source) => {
      await seed(modelConfig({ backends: [recordingBackend()] }))
      const prefix = 'data: first 文鳐\n\n'
      let upstreamController!: ReadableStreamDefaultController<Uint8Array>
      const cancel = vi.fn()
      upstream(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                upstreamController = controller
                controller.enqueue(encoder.encode(prefix))
              },
              cancel,
            }),
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
      )
      const { response, context } = await startStreamingProxy()
      const reader = response.body!.getReader()
      expect((await reader.read()).value).toEqual(encoder.encode(prefix))
      if (source === 'client') {
        await reader.cancel('client stopped')
        expect(cancel).toHaveBeenCalledOnce()
      } else {
        upstreamController.error(new Error('upstream interrupted'))
        await expect(reader.read()).rejects.toThrow('upstream interrupted')
      }
      await waitOnExecutionContext(context)
      const recorded = await onlyRecording()
      expect(recorded.response).toMatchObject({
        status: 200,
        body: prefix,
        bodyEncoding: 'utf8',
        error: source === 'client' ? 'client_disconnected' : 'stream_interrupted',
        truncated: false,
      })
      expect(await (await env.RECORDINGS.get(`recorded-responses/${recorded._id}`))!.text()).toBe(
        prefix
      )
    }
  )

  it.each([
    ['timeout', false],
    ['timeout', true],
    ['network', false],
    ['network', true],
  ] as const)(
    'records only the error and no response R2 object on %s before headers (stream=%s)',
    async (failure, stream) => {
      await seed(
        modelConfig({
          backends: [recordingBackend({ streamingTTFTTimeout: 20, nonStreamingTTFTTimeout: 20 })],
        })
      )
      upstream((request) => {
        if (failure === 'network') throw new Error('connection failed')
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          })
        })
      })
      const response = await proxy({ stream })
      expect(response.status).toBe(failure === 'timeout' ? 504 : 500)
      const recorded = await onlyRecording()
      expect(recorded.response).toMatchObject({
        status: null,
        headers: null,
        body: '',
        error: failure === 'timeout' ? 'ttft_timeout' : 'network_error',
        truncated: false,
      })
      expect(await env.RECORDINGS.get(`recorded-responses/${recorded._id}`)).toBeNull()
    }
  )

  it.each([false, true])(
    'discards captured bytes when TTFT expires while reading the upstream body (stream=%s)',
    async (stream) => {
      await seed(
        modelConfig({
          backends: [recordingBackend({ streamingTTFTTimeout: 20, nonStreamingTTFTTimeout: 20 })],
        })
      )
      const cancel = vi.fn()
      upstream(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (!stream) controller.enqueue(encoder.encode('{"partial":'))
              },
              cancel,
            }),
            { headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' } }
          )
      )
      expect((await proxy({ stream })).status).toBe(504)
      expect(cancel).toHaveBeenCalledOnce()
      const recorded = await onlyRecording()
      expect(recorded.response).toMatchObject({
        status: null,
        headers: null,
        body: '',
        error: 'ttft_timeout',
        truncated: false,
      })
      expect(await env.RECORDINGS.get(`recorded-responses/${recorded._id}`)).toBeNull()
    }
  )

  it.each([false, true])(
    'caps recording at exactly 10 MiB while delivering the complete response (stream=%s)',
    async (stream) => {
      await seed(modelConfig({ backends: [recordingBackend()] }))
      // This is also valid JSON in non-streaming mode.
      const bytes = encoder.encode(`"${'x'.repeat(RESPONSE_LIMIT + 123)}"`)
      upstream(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (let offset = 0; offset < bytes.length; offset += 1024 * 1024)
                  controller.enqueue(bytes.slice(offset, offset + 1024 * 1024))
                controller.close()
              },
            }),
            { headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' } }
          )
      )
      const response = await proxy({ stream })
      expect(response.status).toBe(200)
      const clientBytes = new Uint8Array(await response.arrayBuffer())
      expect(clientBytes.byteLength).toBe(bytes.byteLength)
      expect(await crypto.subtle.digest('SHA-256', clientBytes)).toEqual(
        await crypto.subtle.digest('SHA-256', bytes)
      )
      const row = await env.DB.prepare(
        'SELECT id, response_truncated FROM recorded_requests'
      ).first<{
        id: string
        response_truncated: number
      }>()
      expect(row!.response_truncated).toBe(1)
      const object = await env.RECORDINGS.get(`recorded-responses/${row!.id}`)
      expect(object!.size).toBe(RESPONSE_LIMIT)
      const storedBytes = new Uint8Array(await object!.arrayBuffer())
      expect(await crypto.subtle.digest('SHA-256', storedBytes)).toEqual(
        await crypto.subtle.digest('SHA-256', bytes.slice(0, RESPONSE_LIMIT))
      )
      expect((await onlyRecording()).response).toMatchObject({ truncated: true, error: null })
    }
  )

  it('does not record anything when recordResponses is true but recordRequests is false', async () => {
    await seed(modelConfig({ backends: [recordingBackend({ recordRequests: false })] }))
    upstream(() => jsonResponse({ ok: true }))
    expect((await proxy()).status).toBe(200)
    expect(await count('recorded_requests')).toBe(0)
    expect((await env.RECORDINGS.list()).objects).toHaveLength(0)
  })

  it('preserves request-only recording with a null response', async () => {
    await seed(modelConfig({ backends: [createTestOpenAIBackend({ recordRequests: true })] }))
    upstream(() => jsonResponse({ ok: true }))
    expect((await proxy()).status).toBe(200)
    const recorded = await onlyRecording()
    expect(recorded.response).toBeNull()
    expect(await env.RECORDINGS.get(`recorded-requests/${recorded._id}`)).not.toBeNull()
    expect(await env.RECORDINGS.get(`recorded-responses/${recorded._id}`)).toBeNull()
  })

  it('deletes request and response R2 objects together with their D1 row', async () => {
    await seed(modelConfig({ backends: [recordingBackend()] }))
    upstream(() => jsonResponse({ ok: true }))
    await proxy()
    const recorded = await onlyRecording()
    expect(await env.RECORDINGS.get(`recorded-requests/${recorded._id}`)).not.toBeNull()
    expect(await env.RECORDINGS.get(`recorded-responses/${recorded._id}`)).not.toBeNull()
    const result = await admin('/recorded-requests?backendId=b1', 'DELETE')
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ deletedCount: 1 })
    expect(await count('recorded_requests')).toBe(0)
    expect(await env.RECORDINGS.get(`recorded-requests/${recorded._id}`)).toBeNull()
    expect(await env.RECORDINGS.get(`recorded-responses/${recorded._id}`)).toBeNull()
  })

  it('chains a fast response recording after delayed request insertion', async () => {
    await seed(modelConfig({ backends: [recordingBackend()] }))
    let allowInsert!: () => void
    const insertAllowed = new Promise<void>((resolve) => {
      allowInsert = resolve
    })
    const original = RequestRecorder.prototype.recordRequest
    vi.spyOn(RequestRecorder.prototype, 'recordRequest').mockImplementation(async function (
      this: RequestRecorder,
      ...args
    ) {
      await insertAllowed
      return original.apply(this, args)
    })
    upstream(() => jsonResponse({ immediate: true }))
    const context = createExecutionContext()
    const response = await worker.fetch(
      new Request('https://proxy.example/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${PROXY_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }] }),
      }),
      env,
      context
    )
    try {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ immediate: true })
      expect(await count('recorded_requests')).toBe(0)
    } finally {
      allowInsert()
      await waitOnExecutionContext(context)
    }
    expect((await onlyRecording()).response).toMatchObject({
      status: 200,
      body: '{"immediate":true}',
      error: null,
    })
  })

  it('records invalid non-streaming JSON as a failure and falls back without rewriting valid bytes', async () => {
    await seed(
      modelConfig({
        backends: [
          recordingBackend(),
          recordingBackend({
            id: 'b2',
            connectionId: 'openai-second',
          }),
        ],
      })
    )
    const invalid = '{"broken":'
    const valid = ' { "recovered": true } \n'
    upstream(
      (request) =>
        new Response(new URL(request.url).hostname === 'b1.example' ? invalid : valid, {
          headers: { 'Content-Type': 'application/json' },
        })
    )
    const response = await proxy({}, { 'X-Backend-ID': 'b1' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(valid)
    const recordings = await recordedRequests()
    expect(recordings.find((item) => item.backendId === 'b1')!.response).toMatchObject({
      status: 200,
      body: invalid,
      error: 'invalid_json',
    })
    const stats = await env.DB.prepare(
      'SELECT backend_id, success, failure FROM backend_stats_minute ORDER BY backend_id'
    ).all()
    expect(stats.results).toEqual([
      { backend_id: 'b1', success: 0, failure: 1 },
      { backend_id: 'b2', success: 1, failure: 0 },
    ])
  })

  it('returns 500 internal_error when the last non-streaming attempt has invalid JSON', async () => {
    await seed(modelConfig({ backends: [recordingBackend()] }))
    upstream(() => new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }))
    const response = await proxy()
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'internal_error' } })
    expect((await onlyRecording()).response).toMatchObject({
      body: 'not JSON',
      error: 'invalid_json',
    })
  })

  it.each(['text/plain; charset=utf-8', 'application/problem+json'])(
    'uses utf8 for %s',
    async (contentType) => {
      await seed(modelConfig({ backends: [recordingBackend()] }))
      upstream(() => new Response('"文鳐"', { headers: { 'Content-Type': contentType } }))
      expect((await proxy()).status).toBe(200)
      expect((await onlyRecording()).response).toMatchObject({
        body: '"文鳐"',
        bodyEncoding: 'utf8',
      })
    }
  )

  it('accepts recordResponses independently in backend create and partial update schemas', async () => {
    await seed()
    expect(
      (
        await admin(
          `/models/${MODEL}/backends`,
          'POST',
          createTestOpenAIBackend({
            id: 'b2',
            recordResponses: true,
          })
        )
      ).status
    ).toBe(201)
    expect(
      (await admin(`/models/${MODEL}/backends/b1`, 'PUT', { recordResponses: true })).status
    ).toBe(200)
    const result = (await (await admin(`/models/${MODEL}/backends`)).json()) as {
      backends: BackendConfig[]
    }
    expect(result.backends.every((backend) => backend.recordResponses === true)).toBe(true)
    expect(result.backends.every((backend) => backend.recordRequests !== true)).toBe(true)
  })
})
