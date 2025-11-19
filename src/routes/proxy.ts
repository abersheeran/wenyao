import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { loadBalancer } from '../services/load-balancer.js'
import { statsTracker } from '../services/stats-tracker.js'
import type { ChatCompletionRequest } from '../types/backend.js'
import type { ApiKey } from '../types/apikey.js'
import type { Variables } from '../types/context.js'
import { proxyAuth } from '../middleware/auth.js'
import { proxy } from 'hono/proxy'

const proxyApp = new Hono<{ Variables: Variables }>()

proxyApp.use('*', proxyAuth);

// POST /v1/chat/completions - Proxy to backend with load balancing
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
    const backend = await loadBalancer.selectBackend(requestBody.model, backendId, requestBody.stream)

    if (!backend) {
      console.log(`[Proxy] No available backend for model: ${requestBody.model}, backendId: ${backendId || 'none'}`)
      return c.json({
        error: {
          message: `No enabled backends available for model: ${requestBody.model}`,
          type: 'service_unavailable',
          code: 'no_backend'
        }
      }, 503)
    }

    // Use backend-specific model if configured, otherwise use the client's model
    const modifiedRequest = {
      ...requestBody,
      model: backend.model || requestBody.model
    }

    // Record request start time and increment active requests
    const startTime = Date.now()
    let firstTokenTime: number | undefined
    statsTracker.incrementActive(backend.id)

    try {
      // Call backend using fetch
      const response = await proxy(new URL("/v1/chat/completions", backend.url), {
        method: 'POST',
        headers: {
          ...c.req.header(),
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${backend.apiKey}`
        },
        body: JSON.stringify(modifiedRequest)
      })

      // Handle streaming response
      if (requestBody.stream) {
        // Check if response is ok before starting stream
        if (!response.ok) {
          const duration = Date.now() - startTime
          statsTracker.recordFailure(backend.id, duration)
          statsTracker.decrementActive(backend.id)
          return response
        }

        // Stream the response
        return stream(c, async (streamWriter) => {
          const reader = response.body?.getReader()
          if (!reader) {
            const duration = Date.now() - startTime
            statsTracker.recordFailure(backend.id, duration)
            statsTracker.decrementActive(backend.id)
            throw new Error('No response body')
          }

          const decoder = new TextDecoder()
          let isFirstChunk = true

          try {
            while (true) {
              const { done, value } = await reader.read()

              if (done) {
                break
              }

              // Record TTFT on first chunk
              if (isFirstChunk) {
                firstTokenTime = Date.now() - startTime
                isFirstChunk = false
              }

              // Write chunk to client
              const chunk = decoder.decode(value, { stream: true })
              await streamWriter.write(chunk)
            }

            // Record success with TTFT and duration
            const duration = Date.now() - startTime
            statsTracker.recordSuccess(backend.id, firstTokenTime, duration, true)
            statsTracker.decrementActive(backend.id)
          } catch (error) {
            const duration = Date.now() - startTime
            statsTracker.recordFailure(backend.id, duration)
            statsTracker.decrementActive(backend.id)
            throw error
          }
        })
      } else {
        // Non-streaming response
        if (!response.ok) {
          const duration = Date.now() - startTime
          statsTracker.recordFailure(backend.id, duration)
          statsTracker.decrementActive(backend.id)
          return response
        }

        const responseBody = await response.json()

        // For non-streaming, TTFT and duration are the same
        const duration = Date.now() - startTime
        statsTracker.recordSuccess(backend.id, duration, duration, false)
        statsTracker.decrementActive(backend.id)

        return c.json(responseBody)
      }
    } catch (error) {
      // Record failure and return error as-is
      const duration = Date.now() - startTime
      statsTracker.recordFailure(backend.id, duration)
      statsTracker.decrementActive(backend.id)

      // Return error in OpenAI format
      return c.json({
        error: {
          message: error instanceof Error ? error.message : 'Backend request failed',
          type: 'backend_error',
          code: 'backend_failed'
        }
      }, 500)
    }
  } catch (error) {
    // Handle errors in request processing (before backend selection)
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
