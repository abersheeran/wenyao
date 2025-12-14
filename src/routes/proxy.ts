import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { loadBalancer } from '../services/load-balancer.js'
import { statsTracker } from '../services/stats-tracker.js'
import { configManager } from '../services/config-manager.js'
import type { ChatCompletionRequest, BackendConfig } from '../types/backend.js'
import type { ApiKey } from '../types/apikey.js'
import type { Variables } from '../types/context.js'
import { proxyAuth } from '../middleware/auth.js'
import { proxy } from 'hono/proxy'
import type { Context } from 'hono'
import type { BlankInput } from 'hono/types'

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
 * Handle streaming response with TTFT timeout support
 * Returns { success: true, response } on success
 * Returns { success: false, error } on TTFT timeout (for fallback)
 */
async function handleStreamingResponse(
  c: Context<{ Variables: Variables }, "/chat/completions", BlankInput>,
  response: Response,
  currentBackend: BackendConfig,
  requestStartTime: number
): Promise<{ success: boolean; response?: Response; error?: string }> {
  const reader = response.body?.getReader()
  if (!reader) {
    statsTracker.decrementActive(currentBackend.id)
    return {
      success: false,
      error: 'No response body',
      response: new Response(JSON.stringify({
        error: {
          message: 'No response body',
          type: 'backend_error',
          code: 'no_response_body'
        }
      }), { status: 500 })
    }
  }

  const decoder = new TextDecoder()
  let isFirstChunk = true
  let firstTokenTime: number | undefined
  let timeoutId: NodeJS.Timeout | undefined
  let timeoutOccurred = false

  // Set up TTFT timeout if configured (both 0 and undefined mean no timeout)
  const ttftTimeout = currentBackend.streamingTTFTTimeout
  if (ttftTimeout && ttftTimeout > 0) {
    // Calculate remaining timeout based on time already elapsed
    const elapsedTime = Date.now() - requestStartTime
    const remainingTimeout = Math.max(0, ttftTimeout - elapsedTime)

    if (remainingTimeout > 0) {
      timeoutId = setTimeout(() => {
        timeoutOccurred = true
        reader.cancel('TTFT timeout exceeded')
      }, remainingTimeout)
    } else {
      // Already exceeded timeout
      const duration = Date.now() - requestStartTime
      statsTracker.recordFailure(currentBackend.id, duration)
      statsTracker.decrementActive(currentBackend.id)
      return {
        success: false,
        error: 'Streaming TTFT timeout exceeded',
        response: new Response(JSON.stringify({
          error: {
            message: 'Streaming TTFT timeout exceeded',
            type: 'timeout_error',
            code: 'ttft_timeout'
          }
        }), { status: 504 })
      }
    }
  }

  // Start streaming to client
  const streamResponse = stream(c, async (streamWriter) => {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      // Record TTFT on first chunk and clear timeout
      if (isFirstChunk) {
        firstTokenTime = Date.now() - requestStartTime
        isFirstChunk = false

        // Clear timeout on successful first token
        if (timeoutId) {
          clearTimeout(timeoutId)
        }

        // Check if timeout occurred during read
        if (timeoutOccurred) {
          const duration = Date.now() - requestStartTime
          statsTracker.recordFailure(currentBackend.id, duration)
          statsTracker.decrementActive(currentBackend.id)
          // Cannot return error result here as we're already streaming
          // This will close the stream
          return
        }
      }

      // Write chunk to client
      const chunk = decoder.decode(value, { stream: true })
      await streamWriter.write(chunk)
    }

    // Record success with TTFT and duration
    const duration = Date.now() - requestStartTime
    statsTracker.recordSuccess(currentBackend.id, firstTokenTime, duration, true)
    statsTracker.decrementActive(currentBackend.id)
  })

  // Check if timeout occurred before streaming started
  if (timeoutOccurred && isFirstChunk) {
    const duration = Date.now() - requestStartTime
    statsTracker.recordFailure(currentBackend.id, duration)
    statsTracker.decrementActive(currentBackend.id)
    return {
      success: false,
      error: 'Streaming TTFT timeout exceeded',
      response: new Response(JSON.stringify({
        error: {
          message: 'Streaming TTFT timeout exceeded',
          type: 'timeout_error',
          code: 'ttft_timeout'
        }
      }), { status: 504 })
    }
  }

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
  requestStartTime: number
): Promise<{ success: boolean; response?: Response; error?: string }> {
  // Both 0 and undefined mean no timeout
  const ttftTimeout = currentBackend.nonStreamingTTFTTimeout

  let responseBody
  if (ttftTimeout && ttftTimeout > 0) {
    // Calculate remaining timeout based on time already elapsed
    const elapsedTime = Date.now() - requestStartTime
    const remainingTimeout = Math.max(0, ttftTimeout - elapsedTime)

    if (remainingTimeout === 0) {
      // Already exceeded timeout
      const duration = Date.now() - requestStartTime
      statsTracker.recordFailure(currentBackend.id, duration)
      statsTracker.decrementActive(currentBackend.id)
      return {
        success: false,
        error: 'Non-streaming TTFT timeout exceeded',
        response: new Response(JSON.stringify({
          error: {
            message: 'Non-streaming TTFT timeout exceeded',
            type: 'timeout_error',
            code: 'ttft_timeout'
          }
        }), { status: 504 })
      }
    }

    // Use Promise.race to implement timeout with remaining time
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Non-streaming TTFT timeout exceeded')), remainingTimeout)
    })

    const result = await Promise.race([
      response.json().then(body => ({ timedOut: false, body })),
      timeoutPromise.then(() => ({ timedOut: true, body: null }))
    ]) as { timedOut: boolean; body: any }

    if (result.timedOut) {
      // Timeout occurred
      const duration = Date.now() - requestStartTime
      statsTracker.recordFailure(currentBackend.id, duration)
      statsTracker.decrementActive(currentBackend.id)
      return {
        success: false,
        error: 'Non-streaming TTFT timeout exceeded',
        response: new Response(JSON.stringify({
          error: {
            message: 'Non-streaming TTFT timeout exceeded',
            type: 'timeout_error',
            code: 'ttft_timeout'
          }
        }), { status: 504 })
      }
    }

    responseBody = result.body
  } else {
    // No timeout configured
    responseBody = await response.json()
  }

  // For non-streaming, TTFT and duration are the same
  const duration = Date.now() - requestStartTime
  statsTracker.recordSuccess(currentBackend.id, duration, duration, false)
  statsTracker.decrementActive(currentBackend.id)

  console.log(`[Proxy] Request succeeded with backend: ${currentBackend.id}`)
  return { success: true, response: c.json(responseBody) }
}

/**
 * Try to make a request to a backend
 * Returns { success: true, response, startTime } on success
 * Returns { success: false, response, error } on failure
 */
async function tryBackendRequest(
  backend: BackendConfig,
  requestBody: ChatCompletionRequest,
  headers: Record<string, string>
): Promise<{ success: boolean; response: Response; startTime?: number; error?: any }> {
  const startTime = Date.now()
  statsTracker.incrementActive(backend.id)

  try {
    // Use backend-specific model if configured
    const modifiedRequest = {
      ...requestBody,
      model: backend.model || requestBody.model
    }

    // Update headers with backend's API key
    const backendHeaders = { ...headers }
    backendHeaders['Authorization'] = `Bearer ${backend.apiKey}`

    // Make request to backend
    const response = await proxy(new URL("v1/chat/completions", backend.url), {
      method: 'POST',
      headers: backendHeaders,
      body: JSON.stringify(modifiedRequest)
    })

    // Check if response is successful (2xx status)
    if (response.ok) {
      return { success: true, response, startTime }
    } else {
      // Non-2xx response, record failure
      const duration = Date.now() - startTime
      statsTracker.recordFailure(backend.id, duration)
      statsTracker.decrementActive(backend.id)
      console.log(`[Proxy] Backend ${backend.id} returned non-2xx status: ${response.status}`)
      return { success: false, response }
    }
  } catch (error) {
    // Network error or other exception
    const duration = Date.now() - startTime
    statsTracker.recordFailure(backend.id, duration)
    statsTracker.decrementActive(backend.id)
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

    // Select backend based on model, optional backend-id, and stream type
    const initialBackend = await loadBalancer.selectBackend(requestBody.model, backendId, requestBody.stream)

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

    // Try initial backend first, then fallback to others if needed
    const triedBackendIds = new Set<string>([initialBackend.id])
    let currentBackend = initialBackend
    let lastResponse: Response | null = null

    console.log(`[Proxy] Starting request to model ${requestBody.model}, initial backend: ${initialBackend.id}`)

    // Try backends until one succeeds or all fail
    while (true) {
      console.log(`[Proxy] Trying backend: ${currentBackend.id}`)
      const result = await tryBackendRequest(currentBackend, requestBody, headers)

      if (result.success) {
        // Success! Process the response
        const response = result.response
        const requestStartTime = result.startTime! // Actual start time from tryBackendRequest

        // Handle streaming or non-streaming response
        let handleResult
        if (requestBody.stream) {
          handleResult = await handleStreamingResponse(c, response, currentBackend, requestStartTime)
        } else {
          handleResult = await handleNonStreamingResponse(c, response, currentBackend, requestStartTime)
        }

        // Check if processing succeeded
        if (handleResult.success) {
          return handleResult.response!
        }

        // TTFT timeout or other processing error occurred
        console.log(`[Proxy] Backend ${currentBackend.id} processing failed: ${handleResult.error}`)
        lastResponse = handleResult.response!
      }

      // Request failed, try fallback
      lastResponse = result.response

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
