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
 * Try to make a request to a backend
 * Returns { success: true, response } on success
 * Returns { success: false, response, error } on failure
 */
async function tryBackendRequest(
  backend: BackendConfig,
  requestBody: ChatCompletionRequest,
  headers: Record<string, string>
): Promise<{ success: boolean; response: Response; error?: any }> {
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
    const response = await proxy(new URL("/v1/chat/completions", backend.url), {
      method: 'POST',
      headers: backendHeaders,
      body: JSON.stringify(modifiedRequest)
    })

    // Check if response is successful (2xx status)
    if (response.ok) {
      return { success: true, response }
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
        const startTime = Date.now() // Note: actual start time is within tryBackendRequest

        // Handle streaming response
        if (requestBody.stream) {
          return stream(c, async (streamWriter) => {
            const reader = response.body?.getReader()
            if (!reader) {
              statsTracker.decrementActive(currentBackend.id)
              throw new Error('No response body')
            }

            const decoder = new TextDecoder()
            let isFirstChunk = true
            let firstTokenTime: number | undefined
            const requestStartTime = Date.now()

            try {
              while (true) {
                const { done, value } = await reader.read()

                if (done) {
                  break
                }

                // Record TTFT on first chunk
                if (isFirstChunk) {
                  firstTokenTime = Date.now() - requestStartTime
                  isFirstChunk = false
                }

                // Write chunk to client
                const chunk = decoder.decode(value, { stream: true })
                await streamWriter.write(chunk)
              }

              // Record success with TTFT and duration
              const duration = Date.now() - requestStartTime
              statsTracker.recordSuccess(currentBackend.id, firstTokenTime, duration, true)
              statsTracker.decrementActive(currentBackend.id)
            } catch (error) {
              // Stream error after starting - don't fallback, just record failure
              const duration = Date.now() - requestStartTime
              statsTracker.recordFailure(currentBackend.id, duration)
              statsTracker.decrementActive(currentBackend.id)
              throw error
            }
          })
        } else {
          // Non-streaming response
          const responseBody = await response.json()

          // For non-streaming, TTFT and duration are the same
          const duration = Date.now() - startTime
          statsTracker.recordSuccess(currentBackend.id, duration, duration, false)
          statsTracker.decrementActive(currentBackend.id)

          console.log(`[Proxy] Request succeeded with backend: ${currentBackend.id}`)
          return c.json(responseBody)
        }
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
