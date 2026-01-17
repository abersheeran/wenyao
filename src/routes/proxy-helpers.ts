/**
 * Helper functions and constants for proxy.ts
 * Extracted to improve maintainability and reduce code duplication
 */

import type { BackendConfig } from '../types/backend.js'
import { getMetricsCollector } from '../index.js'
import { concurrencyLimiter } from '../services/concurrency-limiter.js'

/**
 * Constants used in proxy operations
 */
export const PROXY_CONSTANTS = {
  // HTTP Status Codes
  HTTP_GATEWAY_TIMEOUT: 504,
  HTTP_INTERNAL_ERROR: 500,
  HTTP_SERVICE_UNAVAILABLE: 503,
  HTTP_TOO_MANY_REQUESTS: 429,

  // Timeout Checks
  TTFT_ALREADY_EXCEEDED: 0,
  CIRCULAR_ORDER_START_OFFSET: 1,

  // Error Codes
  ERROR_CODES: {
    NO_RESPONSE_BODY: 'no_response_body',
    TTFT_TIMEOUT: 'ttft_timeout',
    NETWORK_ERROR: 'network_error',
    STREAM_INTERRUPTED: 'stream_interrupted',
    NO_BACKEND: 'no_backend',
    BACKEND_ERROR: 'backend_error',
    STREAMING_PROCESSING_ERROR: 'streaming_processing_error',
    NON_STREAMING_PROCESSING_ERROR: 'non_streaming_processing_error',
    ALL_BACKENDS_AT_CAPACITY: 'all_backends_at_capacity',
    ALL_BACKENDS_FAILED: 'all_backends_failed',
  },

  // Error Types
  ERROR_TYPES: {
    BACKEND_ERROR: 'backend_error',
    TIMEOUT_ERROR: 'timeout_error',
    INTERNAL_ERROR: 'internal_error',
    RATE_LIMIT_ERROR: 'rate_limit_exceeded',
    SERVICE_UNAVAILABLE: 'service_unavailable',
  },
} as const

/**
 * Create a standardized error response
 */
export function createErrorResponse(
  message: string,
  type: string,
  code: string,
  status: number
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        code,
      },
    }),
    { status }
  )
}

/**
 * Record request failure metrics
 */
export function recordMetricsFailure(
  backendId: string,
  requestId: string,
  requestStartTime: number,
  model: string,
  errorType: string
): void {
  const duration = Date.now() - requestStartTime
  getMetricsCollector().recordRequestComplete({
    backendId,
    requestId,
    status: 'failure',
    duration,
    model,
    errorType,
  })

  // Ensure concurrency slot is released even if metrics are disabled
  concurrencyLimiter.release(backendId, requestId).catch((err) => {
    console.error(`[Proxy] Failed to release concurrency slot for ${backendId}:`, err)
  })
}

/**
 * Record request success metrics
 */
export function recordMetricsSuccess(
  backendId: string,
  requestId: string,
  requestStartTime: number,
  model: string,
  ttft: number | undefined,
  streamType: 'streaming' | 'non-streaming'
): void {
  const duration = Date.now() - requestStartTime
  getMetricsCollector().recordRequestComplete({
    backendId,
    requestId,
    status: 'success',
    duration,
    ttft,
    streamType,
    model,
  })

  // Ensure concurrency slot is released even if metrics are disabled
  concurrencyLimiter.release(backendId, requestId).catch((err) => {
    console.error(`[Proxy] Failed to release concurrency slot for ${backendId}:`, err)
  })
}

/**
 * Context for TTFT timeout operations
 */
export interface TTFTTimeoutContext {
  currentBackend: BackendConfig
  requestId: string
  requestStartTime: number
  model: string
}

/**
 * Result of a TTFT timeout operation
 */
export interface TTFTTimeoutResult<T> {
  success: boolean
  result?: T
  timedOut?: boolean
  response?: Response
}

/**
 * Execute an operation with TTFT timeout
 * Returns { success: true, result } if operation completes within timeout
 * Returns { success: false, timedOut: true, response } if timeout occurs
 */
export async function executeWithTTFTTimeout<T>(
  operation: () => Promise<T>,
  ttftTimeout: number | undefined,
  context: TTFTTimeoutContext
): Promise<TTFTTimeoutResult<T>> {
  // No timeout configured - execute directly
  if (!ttftTimeout || ttftTimeout <= PROXY_CONSTANTS.TTFT_ALREADY_EXCEEDED) {
    const result = await operation()
    return { success: true, result }
  }

  // Calculate remaining timeout based on elapsed time
  const elapsedTime = Date.now() - context.requestStartTime
  const remainingTimeout = Math.max(
    PROXY_CONSTANTS.TTFT_ALREADY_EXCEEDED,
    ttftTimeout - elapsedTime
  )

  // Already exceeded timeout
  if (remainingTimeout === PROXY_CONSTANTS.TTFT_ALREADY_EXCEEDED) {
    recordMetricsFailure(
      context.currentBackend.id,
      context.requestId,
      context.requestStartTime,
      context.model,
      PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT
    )
    const duration = Date.now() - context.requestStartTime
    console.log(
      `[Proxy] Backend ${context.currentBackend.id} TTFT timeout before operation (${duration}ms)`
    )
    return {
      success: false,
      timedOut: true,
      response: createErrorResponse(
        'TTFT timeout exceeded',
        PROXY_CONSTANTS.ERROR_TYPES.TIMEOUT_ERROR,
        PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT,
        PROXY_CONSTANTS.HTTP_GATEWAY_TIMEOUT
      ),
    }
  }

  // Execute operation with timeout using Promise.race
  let timeoutId: any
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), remainingTimeout)
  })

  try {
    const operationPromise = operation().then((result) => ({
      timedOut: false as const,
      result,
    }))

    const raceResult = await Promise.race([operationPromise, timeoutPromise])

    if ('timedOut' in raceResult && raceResult.timedOut) {
      // Timeout occurred
      recordMetricsFailure(
        context.currentBackend.id,
        context.requestId,
        context.requestStartTime,
        context.model,
        PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT
      )
      const duration = Date.now() - context.requestStartTime
      console.log(
        `[Proxy] Backend ${context.currentBackend.id} TTFT timeout during operation (${duration}ms)`
      )
      return {
        success: false,
        timedOut: true,
        response: createErrorResponse(
          'TTFT timeout exceeded',
          PROXY_CONSTANTS.ERROR_TYPES.TIMEOUT_ERROR,
          PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT,
          PROXY_CONSTANTS.HTTP_GATEWAY_TIMEOUT
        ),
      }
    }

    // Success - at this point TypeScript knows raceResult has result property
    return { success: true, result: (raceResult as { timedOut: false; result: T }).result }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}
