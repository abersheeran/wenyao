import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { loadBalancer } from '../services/load-balancer.js'
import { configManager } from '../services/config-manager.js'
import { requestRecorder } from '../services/request-recorder.js'
import { affinityManager } from '../services/affinity-manager.js'
import { concurrencyLimiter } from '../services/concurrency-limiter.js'
import { getMetricsCollector } from '../index.js'
import { randomUUID } from 'crypto'
import type { ChatCompletionRequest, BackendConfig } from '../types/backend.js'
import type { ApiKey } from '../types/apikey.js'
import type { Variables } from '../types/context.js'
import { proxyAuth } from '../middleware/auth.js'
import { proxy } from 'hono/proxy'
import type { Context } from 'hono'
import type { BlankInput } from 'hono/types'
import {
  PROXY_CONSTANTS,
  createErrorResponse,
  recordMetricsFailure,
  recordMetricsSuccess,
  executeWithTTFTTimeout,
} from './proxy-helpers.js'

const proxyApp = new Hono<{ Variables: Variables }>()

proxyApp.use('*', proxyAuth);

/**
 * Get ordered backends for fallback based on current backend position
 * Returns backends in circular order starting from the next position after currentBackend
 */
function getOrderedBackendsForFallback(
  allBackends: BackendConfig[],
  currentBackend: BackendConfig,
  triedBackendIds: Set<string>
): BackendConfig[] {
  const currentIndex = allBackends.findIndex(b => b.id === currentBackend.id)
  if (currentIndex === -1) {
    // Current backend not found, return all untried backends
    return allBackends.filter(b => !triedBackendIds.has(b.id))
  }

  // Build circular order starting from next position
  const orderedBackends: BackendConfig[] = []
  for (let i = 1; i < allBackends.length; i++) {
    const index = (currentIndex + i) % allBackends.length
    const backend = allBackends[index]
    if (!triedBackendIds.has(backend.id)) {
      orderedBackends.push(backend)
    }
  }

  return orderedBackends
}

/**
 * Wrapper to handle unexpected errors in response processing functions
 * Automatically logs errors, records metrics, and returns standardized error responses
 */
async function withResponseErrorHandling<T>(
  handler: () => Promise<T>,
  context: {
    currentBackend: BackendConfig
    requestId: string
    requestStartTime: number
    model: string
    errorType: string
    errorMessage: string
  }
): Promise<T> {
  try {
    return await handler()
  } catch (error) {
    console.error(`[Proxy] Unexpected error in response processing for backend ${context.currentBackend.id}:`, error)
    recordMetricsFailure(
      context.currentBackend.id,
      context.requestId,
      context.requestStartTime,
      context.model,
      context.errorType
    )
    // Return a standardized error response
    return {
      success: false,
      error: context.errorMessage,
      response: createErrorResponse(
        context.errorMessage,
        PROXY_CONSTANTS.ERROR_TYPES.INTERNAL_ERROR,
        context.errorType,
        PROXY_CONSTANTS.HTTP_INTERNAL_ERROR
      )
    } as T
  }
}

/**
 * Handle streaming response with TTFT timeout support
 * Returns { success: true, response } on success
 * Returns { success: false, error } on TTFT timeout (for fallback)
 */
async function handleStreamingResponse(
  c: Context<{ Variables: Variables }, "/chat/completions", BlankInput>,
  response: Response,
  currentBackend: BackendConfig,
  requestStartTime: number,
  requestId: string,
  model: string
): Promise<{ success: boolean; response?: Response; error?: string }> {
  const reader = response.body?.getReader()

  // Validate response has body
  if (!reader) {
    recordMetricsFailure(
      currentBackend.id,
      requestId,
      requestStartTime,
      model,
      PROXY_CONSTANTS.ERROR_CODES.NO_RESPONSE_BODY
    )
    return {
      success: false,
      error: 'No response body',
      response: createErrorResponse(
        'No response body',
        PROXY_CONSTANTS.ERROR_TYPES.BACKEND_ERROR,
        PROXY_CONSTANTS.ERROR_CODES.NO_RESPONSE_BODY,
        PROXY_CONSTANTS.HTTP_INTERNAL_ERROR
      )
    }
  }

  const decoder = new TextDecoder()
  let firstTokenTime: number | undefined
  let firstChunk: Uint8Array | undefined

  // Wait for first chunk with TTFT timeout if configured
  const ttftTimeout = currentBackend.streamingTTFTTimeout
  if (ttftTimeout && ttftTimeout > 0) {
    const timeoutResult = await executeWithTTFTTimeout(
      () => reader.read(),
      ttftTimeout,
      { currentBackend, requestId, requestStartTime, model }
    )

    if (!timeoutResult.success) {
      // Timeout occurred
      reader.cancel('TTFT timeout exceeded').catch((err) => {
        console.warn(`[Proxy] Failed to cancel reader for backend ${currentBackend.id}:`, err)
      })
      return {
        success: false,
        error: 'Streaming TTFT timeout exceeded',
        response: timeoutResult.response
      }
    }

    const readResult = timeoutResult.result!

    // Check if stream ended immediately (empty response)
    if (readResult.done) {
      recordMetricsSuccess(
        currentBackend.id,
        requestId,
        requestStartTime,
        model,
        Date.now() - requestStartTime,
        'streaming'
      )
      return { success: true, response: c.body(null) }
    }

    firstChunk = readResult.value
    firstTokenTime = Date.now() - requestStartTime
  }

  // Now start streaming to client (first chunk already validated if timeout was set)
  const streamResponse = stream(c, async (streamWriter) => {
    try {
      // Write first chunk if we already read it
      if (firstChunk) {
        const chunk = decoder.decode(firstChunk, { stream: true })
        await streamWriter.write(chunk)
      }

      // Continue reading and writing remaining chunks
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        // Record TTFT on first chunk if not already set
        if (!firstTokenTime) {
          firstTokenTime = Date.now() - requestStartTime
        }

        // Write chunk to client
        const chunk = decoder.decode(value, { stream: true })
        await streamWriter.write(chunk)
      }

      // Record success with TTFT and duration
      recordMetricsSuccess(
        currentBackend.id,
        requestId,
        requestStartTime,
        model,
        firstTokenTime,
        'streaming'
      )
      const duration = Date.now() - requestStartTime
    } catch (error) {
      // Stream interrupted
      recordMetricsFailure(
        currentBackend.id,
        requestId,
        requestStartTime,
        model,
        PROXY_CONSTANTS.ERROR_CODES.STREAM_INTERRUPTED
      )
      throw error
    }
  })

  return { success: true, response: streamResponse }
}

/**
 * Handle non-streaming response with TTFT timeout support
 * Returns { success: true, response } on success
 * Returns { success: false, error } on TTFT timeout (for fallback)
 */
async function handleNonStreamingResponse(
  c: Context<{ Variables: Variables }, "/chat/completions", BlankInput>,
  response: Response,
  currentBackend: BackendConfig,
  requestStartTime: number,
  requestId: string,
  model: string
): Promise<{ success: boolean; response?: Response; error?: string }> {
  const ttftTimeout = currentBackend.nonStreamingTTFTTimeout

  // Parse JSON with TTFT timeout if configured
  let responseBody
  if (ttftTimeout && ttftTimeout > 0) {
    const timeoutResult = await executeWithTTFTTimeout(
      () => response.json(),
      ttftTimeout,
      { currentBackend, requestId, requestStartTime, model }
    )

    if (!timeoutResult.success) {
      // Timeout occurred
      return {
        success: false,
        error: 'Non-streaming TTFT timeout exceeded',
        response: timeoutResult.response
      }
    }

    responseBody = timeoutResult.result
  } else {
    // No timeout configured
    responseBody = await response.json()
  }

  // For non-streaming, TTFT and duration are the same
  const duration = Date.now() - requestStartTime
  recordMetricsSuccess(
    currentBackend.id,
    requestId,
    requestStartTime,
    model,
    duration,
    'non-streaming'
  )
  return { success: true, response: c.json(responseBody) }
}

/**
 * Try to make a request to a backend
 * Returns { success: true, response, startTime } on success
 * Returns { success: false, response, error, atCapacity } on failure
 */
async function tryBackendRequest(
  backend: BackendConfig,
  requestBody: ChatCompletionRequest,
  headers: Record<string, string>,
  requestId: string
): Promise<{ success: boolean; response: Response; startTime?: number; error?: any; atCapacity?: boolean }> {
  const metricsCollector = getMetricsCollector()
  const startTime = Date.now()

  // Use concurrencyLimiter to enforce concurrency limits if configured
  const allowed = await concurrencyLimiter.tryAcquire(backend, requestId)

  if (!allowed) {
    console.log(`[Proxy] Backend ${backend.id} is at capacity (${backend.maxConcurrentRequests})`)
    return {
      success: false,
      atCapacity: true,
      response: createErrorResponse(
        `Backend ${backend.id} is at capacity`,
        PROXY_CONSTANTS.ERROR_TYPES.RATE_LIMIT_ERROR,
        PROXY_CONSTANTS.ERROR_CODES.ALL_BACKENDS_AT_CAPACITY,
        PROXY_CONSTANTS.HTTP_TOO_MANY_REQUESTS
      )
    }
  }

  try {
    // Use backend-specific model if configured
    const modifiedRequest = {
      ...requestBody,
      model: backend.model || requestBody.model
    }

    // Update headers with backend's API key
    const backendHeaders = { ...headers }
    backendHeaders['Authorization'] = `Bearer ${backend.apiKey}`

    // Record request if enabled for this backend
    const fullUrl = new URL("v1/chat/completions", backend.url).toString()
    await requestRecorder.recordRequest(
      backend,
      requestBody.model,
      fullUrl,
      backendHeaders,
      modifiedRequest
    )

    // Make request to backend
    const response = await proxy(fullUrl, {
      method: 'POST',
      headers: backendHeaders,
      body: JSON.stringify(modifiedRequest)
    })

    // Check if response is successful (2xx status)
    if (response.ok) {
      return { success: true, response, startTime }
    } else {
      // Non-2xx response, record failure
      recordMetricsFailure(
        backend.id,
        requestId,
        startTime,
        requestBody.model,
        `http_${response.status}`
      )
      console.log(`[Proxy] Backend ${backend.id} returned non-2xx status: ${response.status}`)
      return { success: false, response }
    }
  } catch (error) {
    // Network error or other exception
    recordMetricsFailure(
      backend.id,
      requestId,
      startTime,
      requestBody.model,
      PROXY_CONSTANTS.ERROR_CODES.NETWORK_ERROR
    )
    console.log(`[Proxy] Backend ${backend.id} request failed:`, error)
    return { success: false, response: new Response(null, { status: 500 }), error }
  }
}

// POST /v1/chat/completions - Proxy to backend with load balancing and fallback
proxyApp.post('/chat/completions', async (c) => {
  try {
    // Parse request body first to get the model
    const requestBody = await c.req.json() as ChatCompletionRequest

    if (!requestBody.model) {
      return c.json({
        error: {
          message: 'Model is required in the request',
          type: 'invalid_request_error',
          code: 'model_required'
        }
      }, 400)
    }

    // Check API key permissions for the requested model
    const apiKey = c.get('apiKey') as ApiKey
    if (!apiKey.models.includes(requestBody.model)) {
      return c.json({
        error: {
          message: `API key does not have permission to access model: ${requestBody.model}`,
          type: 'permission_denied',
          code: 'model_not_allowed'
        }
      }, 403)
    }

    // Get backend-id from header if specified (for forced backend selection)
    const backendId = c.req.header('X-Backend-ID')

    // Get session-id from header for affinity-based routing
    const sessionId = c.req.header('X-Session-ID')

    // Select backend based on model, optional backend-id, stream type, and session ID
    const initialBackend = await loadBalancer.selectBackend(requestBody.model, backendId, requestBody.stream, sessionId)

    if (!initialBackend) {
      console.log(`[Proxy] No available backend for model: ${requestBody.model}, backendId: ${backendId || 'none'}`)
      return c.json({
        error: {
          message: `No enabled backends available for model: ${requestBody.model}`,
          type: 'service_unavailable',
          code: 'no_backend'
        }
      }, 503)
    }

    // Get all enabled backends for fallback
    const allBackends = configManager.getAllEnabledBackends(requestBody.model)

    // Prepare headers (without Authorization, will be set per backend)
    const headers = { ...c.req.header() }
    delete headers['content-length']
    delete headers['authorization'] // Remove client's auth header

    // Generate unique request ID for tracking
    const requestId = randomUUID()

    // Try initial backend first, then fallback to others if needed
    const triedBackendIds = new Set<string>([initialBackend.id])
    let currentBackend = initialBackend
    let lastResponse: Response | null = null

    console.log(`[Proxy] Starting request to model ${requestBody.model}, initial backend: ${initialBackend.id}, requestId: ${requestId}`)

    // Try backends until one succeeds or all fail
    while (true) {
      console.log(`[Proxy] Trying backend: ${currentBackend.id}`)
      const result = await tryBackendRequest(currentBackend, requestBody, headers, requestId)

      if (result.success) {
        // Success! Process the response
        const response = result.response
        const requestStartTime = result.startTime! // Actual start time from tryBackendRequest

        // Handle streaming or non-streaming response
        let handleResult
        if (requestBody.stream) {
          handleResult = await withResponseErrorHandling(
            () => handleStreamingResponse(c, response, currentBackend, requestStartTime, requestId, requestBody.model),
            {
              currentBackend,
              requestId,
              requestStartTime,
              model: requestBody.model,
              errorType: 'streaming_processing_error',
              errorMessage: 'Streaming processing error'
            }
          )
        } else {
          handleResult = await withResponseErrorHandling(
            () => handleNonStreamingResponse(c, response, currentBackend, requestStartTime, requestId, requestBody.model),
            {
              currentBackend,
              requestId,
              requestStartTime,
              model: requestBody.model,
              errorType: 'non_streaming_processing_error',
              errorMessage: 'Non-streaming processing error'
            }
          )
        }

        // Check if processing succeeded
        if (handleResult.success) {
          // Store affinity mapping if session ID provided and affinity enabled
          if (sessionId) {
            const modelConfig = configManager.getModelConfig(requestBody.model)
            if (modelConfig?.enableAffinity) {
              affinityManager.setAffinityBackend(
                requestBody.model,
                sessionId,
                currentBackend.id
              ).catch(err =>
                console.error('Failed to store affinity mapping:', err)
              )
            }
          }

          return handleResult.response!
        }

        // TTFT timeout or other processing error occurred
        console.log(`[Proxy] Backend ${currentBackend.id} processing failed: ${handleResult.error}, attempting fallback`)
        lastResponse = handleResult.response!
        // Continue to fallback logic below
      } else {
        // Request failed or at capacity, try fallback
        lastResponse = result.response
        if (result.atCapacity) {
          console.log(`[Proxy] Backend ${currentBackend.id} is at capacity, attempting fallback`)
        } else {
          console.log(`[Proxy] Backend ${currentBackend.id} request failed, attempting fallback`)
        }
      }

      // Get next backends to try
      const nextBackends = getOrderedBackendsForFallback(allBackends, currentBackend, triedBackendIds)

      if (nextBackends.length === 0) {
        // No more backends to try, return last error
        console.log(`[Proxy] All backends failed for model ${requestBody.model}`)
        return lastResponse
      }

      // Try next backend
      currentBackend = nextBackends[0]
      triedBackendIds.add(currentBackend.id)
      console.log(`[Proxy] Falling back to backend: ${currentBackend.id}`)
    }
  } catch (error) {
    // Handle errors in request processing (before backend selection)
    console.error('[Proxy] Request processing error:', error)
    return c.json({
      error: {
        message: error instanceof Error ? error.message : 'Request processing failed',
        type: 'invalid_request_error',
        code: 'invalid_request'
      }
    }, 400)
  }
})

export default proxyApp
