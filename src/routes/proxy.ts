import { randomUUID } from 'crypto'

import { type Context, Hono } from 'hono'
import { proxy } from 'hono/proxy'

import { proxyAuth } from '../middleware/auth.js'
import {
  type BaseProvider,
  createErrorResponse,
  recordMetricsFailure,
  type StandardizedRequest,
} from '../providers/base-provider.js'
import { providerFactory } from '../providers/provider-factory.js'
import { affinityManager } from '../services/affinity-manager.js'
import { concurrencyLimiter } from '../services/concurrency-limiter.js'
import { configManager } from '../services/config-manager.js'
import { loadBalancer } from '../services/load-balancer.js'
import { requestRecorder } from '../services/request-recorder.js'

import type { BackendConfig } from '../types/backend.js'
import type { Variables } from '../types/context.js'

const proxyApp = new Hono<{ Variables: Variables }>()

proxyApp.use('*', proxyAuth)

/**
 * Get ordered backends for fallback based on current backend position
 * Returns backends in circular order starting from the next position after currentBackend
 */
export function getOrderedBackendsForFallback(
  allBackends: BackendConfig[],
  currentBackend: BackendConfig,
  triedBackendIds: Set<string>
): BackendConfig[] {
  const currentIndex = allBackends.findIndex((b) => b.id === currentBackend.id)
  if (currentIndex === -1) {
    return allBackends.filter((b) => !triedBackendIds.has(b.id))
  }

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
 * Get request ID from header or generate a new one
 */
export function getOrGenerateRequestId(c: Context): string {
  return c.req.header('x-request-id') || randomUUID()
}

/**
 * Try to make a request to a backend using the appropriate provider
 * Returns { success: true, response, startTime } on success
 * Returns { success: false, response, error, atCapacity } on failure
 */
async function tryBackendRequest(
  backend: BackendConfig,
  standardizedRequest: StandardizedRequest,
  requestId: string,
  provider: BaseProvider
): Promise<{
  success: boolean
  response: Response
  startTime?: number
  error?: any
  atCapacity?: boolean
}> {
  const startTime = Date.now()

  // Use concurrencyLimiter to enforce concurrency limits if configured
  const allowed = await concurrencyLimiter.tryAcquire(backend, requestId)

  if (!allowed) {
    return {
      success: false,
      atCapacity: true,
      response: createErrorResponse(
        `Backend ${backend.id} is at capacity`,
        'rate_limit_exceeded',
        'all_backends_at_capacity',
        429
      ),
    }
  }

  try {
    // Prepare request body using provider
    const modifiedRequestBody = provider.prepareRequestBody(standardizedRequest, backend)
    const requestBodyString = JSON.stringify(modifiedRequestBody)
    // Get target URL from provider
    const fullUrl = provider.getTargetUrl(backend, standardizedRequest)

    // Prepare headers using provider (async for all providers)
    const backendHeaders = await provider.prepareHeaders(
      backend,
      standardizedRequest.stream,
      fullUrl,
      standardizedRequest.originalHeaders,
      requestBodyString
    )

    // Record request if enabled for this backend
    await requestRecorder.recordRequest(
      backend,
      standardizedRequest.model,
      fullUrl,
      backendHeaders,
      requestBodyString
    )

    // Make request to backend
    const response = await proxy(fullUrl, {
      method: 'POST',
      headers: backendHeaders,
      body: requestBodyString,
    })

    // Check if response is successful (2xx status)
    if (response.ok) {
      return { success: true, response, startTime }
    } else {
      console.warn(`[${requestId}] Backend ${backend.id} returned status ${response.status}`)
      // Non-2xx response, record failure
      recordMetricsFailure(
        backend.id,
        requestId,
        startTime,
        standardizedRequest.model,
        `http_${response.status}`
      )
      return { success: false, response }
    }
  } catch (error) {
    console.error(`[${requestId}] Error requesting backend ${backend.id}:`, error)
    // Network error or other exception
    recordMetricsFailure(
      backend.id,
      requestId,
      startTime,
      standardizedRequest.model,
      'network_error'
    )
    return { success: false, response: new Response(null, { status: 500 }), error }
  }
}

/**
 * Generic proxy handler that works with any provider
 */
function createProxyHandler(providerType: 'openai' | 'bedrock') {
  return async (c: Context<{ Variables: Variables }>): Promise<Response> => {
    const provider = providerFactory.getProvider(providerType)

    const requestBody = await c.req.json()
    try {
      provider.validateRequest(c, requestBody)
    } catch (error) {
      return createErrorResponse(
        error instanceof Error ? error.message : 'Invalid request',
        'invalid_request_error',
        'validation_failed',
        400
      )
    }

    const standardizedRequest = provider.parseRequest(c, requestBody)

    // Check API key permissions for the requested model
    const apiKey = c.get('apiKey')
    if (!apiKey.models.includes(standardizedRequest.model)) {
      return createErrorResponse(
        `API key does not have permission to access model: ${standardizedRequest.model}`,
        'permission_denied',
        'model_not_allowed',
        403
      )
    }

    // Get model configuration and validate provider
    const modelConfig = configManager.getModelConfig(standardizedRequest.model)
    if (!modelConfig) {
      return createErrorResponse(
        `Model configuration for ${standardizedRequest.model} not found`,
        'invalid_request_error',
        'model_not_found',
        400
      )
    }

    // Validate that the model's provider matches the request format
    if (modelConfig.provider !== providerType) {
      return createErrorResponse(
        `Model '${standardizedRequest.model}' is configured for ${modelConfig.provider} provider, but request uses ${providerType} format`,
        'invalid_request_error',
        'provider_mismatch',
        400
      )
    }

    // Get backend-id from header if specified (for forced backend selection)
    const backendId = c.req.header('X-Backend-ID')

    // Get session-id from header for affinity-based routing
    const sessionId = c.req.header('X-Session-ID')

    // Select backend based on model, optional backend-id, stream type, and session ID
    let initialBackend
    try {
      initialBackend = await loadBalancer.selectBackend(
        standardizedRequest.model,
        backendId,
        standardizedRequest.stream,
        sessionId
      )
    } catch (error) {
      // Handle errors from selectBackend (e.g., invalid backend-id)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return createErrorResponse(errorMessage, 'invalid_request_error', 'invalid_backend', 400)
    }

    if (!initialBackend) {
      return createErrorResponse(
        `No enabled backends available for model: ${standardizedRequest.model}`,
        'service_unavailable',
        'no_backend',
        503
      )
    }

    const allBackends = configManager.getAllEnabledBackends(standardizedRequest.model)

    const requestId = getOrGenerateRequestId(c)

    // Try initial backend first, then fallback to others if needed
    const triedBackendIds = new Set<string>([initialBackend.id])
    let currentBackend = initialBackend
    let lastResponse: Response | null = null

    // Try backends until one succeeds or all fail
    while (true) {
      const result = await tryBackendRequest(
        currentBackend,
        standardizedRequest,
        requestId,
        provider
      )

      if (result.success) {
        // Success! Process the response using provider
        const response = result.response
        const requestStartTime = result.startTime! // Actual start time from tryBackendRequest

        // Create response context
        const responseContext = {
          c,
          backend: currentBackend,
          requestStartTime,
          requestId,
          model: standardizedRequest.model,
        }

        // Handle streaming or non-streaming response using provider
        let handleResult
        if (standardizedRequest.stream) {
          handleResult = await provider.handleStreamingResponse(responseContext, response)
        } else {
          handleResult = await provider.handleNonStreamingResponse(responseContext, response)
        }

        // Check if processing succeeded
        if (handleResult.success) {
          // Store affinity mapping if session ID provided and affinity enabled
          if (sessionId) {
            const modelConfig = configManager.getModelConfig(standardizedRequest.model)
            if (modelConfig?.enableAffinity) {
              affinityManager
                .setAffinityBackend(standardizedRequest.model, sessionId, currentBackend.id)
                .catch((err) => console.error('Failed to store affinity mapping:', err))
            }
          }

          return handleResult.response!
        }
        // TTFT timeout or other processing error occurred
        lastResponse = handleResult.response!
        // Continue to fallback logic below
      } else {
        // Request failed or at capacity, try fallback
        lastResponse = result.response
      }

      // Get next backends to try
      const nextBackends = getOrderedBackendsForFallback(
        allBackends,
        currentBackend,
        triedBackendIds
      )

      if (nextBackends.length === 0) {
        // No more backends to try, return last error
        console.error(`[${requestId}] All backends exhausted, returning last error`)
        return lastResponse
      }

      // Try next backend
      currentBackend = nextBackends[0]
      triedBackendIds.add(currentBackend.id)
    }
  }
}

// OpenAI-compatible proxy endpoint
proxyApp.post('/chat/completions', createProxyHandler('openai'))

// AWS Bedrock proxy endpoints
// Pattern: /model/:modelId/invoke or /model/:modelId/invoke-with-response-stream
proxyApp.post('/model/:modelId/invoke', createProxyHandler('bedrock'))
proxyApp.post('/model/:modelId/invoke-with-response-stream', createProxyHandler('bedrock'))

export default proxyApp
