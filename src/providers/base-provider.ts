/**
 * Base provider interface and abstract class for different API backends (OpenAI, Bedrock, etc.)
 * This abstraction layer allows each provider to handle their specific request/response formats
 */

import { stream } from 'hono/streaming'

import { getMetricsCollector } from '../index.js'
import { concurrencyLimiter } from '../services/concurrency-limiter.js'

import type { BackendConfig } from '../types/backend.js'
import type { Context } from 'hono'

/**
 * Constants used in provider operations
 */
const PROVIDER_CONSTANTS = {
  HTTP_GATEWAY_TIMEOUT: 504,
  HTTP_INTERNAL_ERROR: 500,
  TTFT_ALREADY_EXCEEDED: 0,
  ERROR_CODES: {
    NO_RESPONSE_BODY: 'no_response_body',
    TTFT_TIMEOUT: 'ttft_timeout',
    STREAM_INTERRUPTED: 'stream_interrupted',
    INTERNAL_ERROR: 'internal_error',
  },
  ERROR_TYPES: {
    BACKEND_ERROR: 'backend_error',
    TIMEOUT_ERROR: 'timeout_error',
    INTERNAL_ERROR: 'internal_error',
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

  concurrencyLimiter.release(backendId, requestId).catch((err) => {
    console.error(`[Provider] Failed to release concurrency slot for ${backendId}:`, err)
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

  concurrencyLimiter.release(backendId, requestId).catch((err) => {
    console.error(`[Provider] Failed to release concurrency slot for ${backendId}:`, err)
  })
}

/**
 * Context for TTFT timeout operations
 */
interface TTFTTimeoutContext {
  currentBackend: BackendConfig
  requestId: string
  requestStartTime: number
  model: string
}

/**
 * Result of a TTFT timeout operation
 */
interface TTFTTimeoutResult<T> {
  success: boolean
  result?: T
  timedOut?: boolean
  response?: Response
}

/**
 * Execute an operation with TTFT timeout
 */
async function executeWithTTFTTimeout<T>(
  operation: () => Promise<T>,
  ttftTimeout: number | undefined,
  context: TTFTTimeoutContext
): Promise<TTFTTimeoutResult<T>> {
  if (!ttftTimeout || ttftTimeout <= PROVIDER_CONSTANTS.TTFT_ALREADY_EXCEEDED) {
    const result = await operation()
    return { success: true, result }
  }

  const elapsedTime = Date.now() - context.requestStartTime
  const remainingTimeout = Math.max(
    PROVIDER_CONSTANTS.TTFT_ALREADY_EXCEEDED,
    ttftTimeout - elapsedTime
  )

  if (remainingTimeout === PROVIDER_CONSTANTS.TTFT_ALREADY_EXCEEDED) {
    recordMetricsFailure(
      context.currentBackend.id,
      context.requestId,
      context.requestStartTime,
      context.model,
      PROVIDER_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT
    )
    return {
      success: false,
      timedOut: true,
      response: createErrorResponse(
        'TTFT timeout exceeded',
        PROVIDER_CONSTANTS.ERROR_TYPES.TIMEOUT_ERROR,
        PROVIDER_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT,
        PROVIDER_CONSTANTS.HTTP_GATEWAY_TIMEOUT
      ),
    }
  }

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
      recordMetricsFailure(
        context.currentBackend.id,
        context.requestId,
        context.requestStartTime,
        context.model,
        PROVIDER_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT
      )
      return {
        success: false,
        timedOut: true,
        response: createErrorResponse(
          'TTFT timeout exceeded',
          PROVIDER_CONSTANTS.ERROR_TYPES.TIMEOUT_ERROR,
          PROVIDER_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT,
          PROVIDER_CONSTANTS.HTTP_GATEWAY_TIMEOUT
        ),
      }
    }

    return { success: true, result: raceResult.result }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

/**
 * Generic request body - each provider will have their own specific type
 */
export interface BaseRequest {
  model: string
  stream?: boolean
  [key: string]: any
}

/**
 * Standardized internal request format
 * Providers convert their specific format to this
 */
export interface StandardizedRequest {
  model: string
  stream: boolean
  originalHeaders: Record<string, string>
  originalBody: any // Keep original for provider-specific forwarding
}

/**
 * Result of a backend request
 */
export interface RequestResult {
  success: boolean
  response: Response
  startTime?: number
  error?: any
  atCapacity?: boolean
}

/**
 * Result of response handling
 */
export interface HandleResult {
  success: boolean
  response?: Response
  error?: string
}

/**
 * Context needed for handling responses
 */
export interface ResponseContext {
  c: Context<any>
  backend: BackendConfig
  requestStartTime: number
  requestId: string
  model: string
}

/**
 * Options for processing stream chunks
 */
export interface StreamChunkProcessor {
  /**
   * Process a chunk before writing to client
   * @param chunk - The decoded chunk string
   * @returns The processed chunk to write
   */
  processChunk?: (chunk: string) => string
}

/**
 * Options for processing non-streaming response
 */
export interface NonStreamingProcessor {
  /**
   * Process the response body before returning to client
   * @param body - The parsed JSON response body
   * @param model - The model name
   * @returns The processed response body
   */
  processBody?: (body: any, model: string) => any
}

/**
 * Decorator to handle unexpected errors in response processing methods
 * Automatically wraps methods with error handling logic
 */
function WithResponseErrorHandling(
  _target: any,
  _propertyKey: string,
  descriptor: PropertyDescriptor
): PropertyDescriptor {
  const originalMethod = descriptor.value

  descriptor.value = async function (
    this: BaseProvider,
    context: ResponseContext,
    response: Response
  ): Promise<HandleResult> {
    try {
      return await originalMethod.call(this, context, response)
    } catch (error) {
      console.error(
        `[Provider] Unexpected error in response handling for backend ${context.backend.id}:`,
        error
      )
      recordMetricsFailure(
        context.backend.id,
        context.requestId,
        context.requestStartTime,
        context.model,
        PROVIDER_CONSTANTS.ERROR_TYPES.INTERNAL_ERROR
      )
      return {
        success: false,
        error: 'Internal server error during response processing',
        response: createErrorResponse(
          'Internal server error during response processing',
          PROVIDER_CONSTANTS.ERROR_TYPES.INTERNAL_ERROR,
          PROVIDER_CONSTANTS.ERROR_CODES.INTERNAL_ERROR,
          PROVIDER_CONSTANTS.HTTP_INTERNAL_ERROR
        ),
      }
    }
  }

  return descriptor
}

/**
 * Base provider abstract class - extend this for each API provider
 * Provides default implementations for response handling with optional hooks for customization
 */
export abstract class BaseProvider {
  /**
   * Provider name (e.g., 'openai', 'bedrock')
   */
  abstract readonly name: string

  /**
   * Validate incoming request format
   * @param c - The Hono context containing the full request (headers, query params, etc.)
   * @param requestBody - The parsed request body
   * @throws Error if request is invalid
   */
  abstract validateRequest(c: Context, requestBody: any): void

  /**
   * Parse and standardize the request
   * Converts provider-specific format to standardized format
   * @param c - The Hono context containing the full request (headers, query params, etc.)
   * @param requestBody - The parsed request body
   */
  abstract parseRequest(c: Context, requestBody: any): StandardizedRequest

  /**
   * Prepare headers for backend request
   * Each provider may need different auth headers
   * @param backend - The backend configuration
   * @param stream - Whether the request is for a streaming response
   * @param url - The target URL for the request
   * @param headers - The original headers
   * @param requestBody - The stringified request body
   */
  abstract prepareHeaders(
    backend: BackendConfig,
    stream: boolean,
    url: string,
    headers: Record<string, string>,
    requestBody: string
  ): Promise<Record<string, string>>

  /**
   * Prepare request body for backend
   * Allows provider to modify request (e.g., override model name)
   */
  abstract prepareRequestBody(standardizedRequest: StandardizedRequest, backend: BackendConfig): any

  /**
   * Get the target URL for the backend request
   * @param backend - The backend configuration
   * @param standardizedRequest - The standardized request (may be needed for URL construction)
   */
  abstract getTargetUrl(backend: BackendConfig, standardizedRequest: StandardizedRequest): string

  /**
   * Optional hook: Determine if the provider uses binary stream format (e.g., Bedrock event-stream)
   * Default is false (text stream like OpenAI SSE)
   * Override this in subclass to return true for binary stream providers
   */
  protected useBinaryStream?(): boolean

  /**
   * Optional hook: Process chunk before writing to client
   * Override this in subclass if chunk processing is needed
   * @param chunk - Either a decoded text string or raw binary data (Uint8Array)
   * @returns The processed chunk to write - string for text mode, Uint8Array for binary mode
   */
  protected processChunk?(chunk: string | Uint8Array): string | Uint8Array

  /**
   * Optional hook: Process response body before returning to client
   * Override this in subclass if body processing is needed
   */
  protected processBody?(body: any, model: string): any

  /**
   * Optional hook: Process response headers before returning to client
   * Override this in subclass if header processing is needed
   */
  protected processHeaders(headers: Headers): Headers {
    const newHeaders = new Headers()
    const contentType = headers.get('content-type')
    if (contentType) {
      newHeaders.set('content-type', contentType)
    }
    return newHeaders
  }

  /**
   * Handle streaming response with common logic
   * Supports both text streams (OpenAI SSE) and binary streams (Bedrock event-stream)
   * Subclasses can override processChunk() to customize chunk processing
   */
  @WithResponseErrorHandling
  async handleStreamingResponse(
    context: ResponseContext,
    response: Response
  ): Promise<HandleResult> {
    const { c, backend, requestStartTime, requestId, model } = context
    const reader = response.body?.getReader()

    // Validate response has body
    if (!reader) {
      recordMetricsFailure(
        backend.id,
        requestId,
        requestStartTime,
        model,
        PROVIDER_CONSTANTS.ERROR_CODES.NO_RESPONSE_BODY
      )
      return {
        success: false,
        error: 'No response body',
        response: createErrorResponse(
          'No response body',
          PROVIDER_CONSTANTS.ERROR_TYPES.BACKEND_ERROR,
          PROVIDER_CONSTANTS.ERROR_CODES.NO_RESPONSE_BODY,
          PROVIDER_CONSTANTS.HTTP_INTERNAL_ERROR
        ),
      }
    }

    // Determine stream type: binary (Bedrock) or text (OpenAI SSE)
    const isBinaryStream = this.useBinaryStream?.() ?? false
    const decoder = isBinaryStream ? undefined : new TextDecoder()
    let firstTokenTime: number | undefined
    let firstChunk: Uint8Array | undefined

    // Wait for first chunk with TTFT timeout if configured
    const ttftTimeout = backend.streamingTTFTTimeout
    if (ttftTimeout && ttftTimeout > 0) {
      const timeoutResult = await executeWithTTFTTimeout(() => reader.read(), ttftTimeout, {
        currentBackend: backend,
        requestId,
        requestStartTime,
        model,
      })

      if (!timeoutResult.success) {
        // Timeout occurred
        reader.cancel('TTFT timeout exceeded').catch((err) => {
          console.warn(`[Provider] Failed to cancel reader for backend ${backend.id}:`, err)
        })
        return {
          success: false,
          error: 'Streaming TTFT timeout exceeded',
          response: timeoutResult.response,
        }
      }

      const readResult = timeoutResult.result!

      // Check if stream ended immediately (empty response)
      if (readResult.done) {
        recordMetricsSuccess(
          backend.id,
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

    // Now start streaming to client
    const streamResponse = stream(c, async (streamWriter) => {
      try {
        // Write first chunk if we already read it
        if (firstChunk) {
          let chunk: string | Uint8Array
          if (isBinaryStream) {
            // Binary mode: keep as Uint8Array
            chunk = firstChunk
          } else {
            // Text mode: decode to string
            chunk = decoder!.decode(firstChunk, { stream: true })
          }

          // Allow provider to process chunk
          if (this.processChunk) {
            chunk = this.processChunk(chunk)
          }
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

          // Process chunk based on stream type
          let chunk: string | Uint8Array
          if (isBinaryStream) {
            // Binary mode: keep as Uint8Array
            chunk = value
          } else {
            // Text mode: decode to string
            chunk = decoder!.decode(value, { stream: true })
          }

          // Allow provider to process chunk
          if (this.processChunk) {
            chunk = this.processChunk(chunk)
          }
          await streamWriter.write(chunk)
        }

        // Record success with TTFT and duration
        recordMetricsSuccess(
          backend.id,
          requestId,
          requestStartTime,
          model,
          firstTokenTime,
          'streaming'
        )
      } catch (error) {
        // Stream interrupted
        recordMetricsFailure(
          backend.id,
          requestId,
          requestStartTime,
          model,
          PROVIDER_CONSTANTS.ERROR_CODES.STREAM_INTERRUPTED
        )
        throw error
      }
    })

    return {
      success: true,
      response: new Response(streamResponse.body, {
        status: response.status,
        headers: this.processHeaders(response.headers),
      }),
    }
  }

  /**
   * Handle non-streaming response with common logic
   * Subclasses can override processBody() to customize body processing
   */
  @WithResponseErrorHandling
  async handleNonStreamingResponse(
    context: ResponseContext,
    response: Response
  ): Promise<HandleResult> {
    const { c, backend, requestStartTime, requestId, model } = context
    const ttftTimeout = backend.nonStreamingTTFTTimeout

    // Parse JSON with TTFT timeout if configured
    let responseBody
    if (ttftTimeout && ttftTimeout > 0) {
      const timeoutResult = await executeWithTTFTTimeout(() => response.json(), ttftTimeout, {
        currentBackend: backend,
        requestId,
        requestStartTime,
        model,
      })

      if (!timeoutResult.success) {
        // Timeout occurred
        return {
          success: false,
          error: 'Non-streaming TTFT timeout exceeded',
          response: timeoutResult.response,
        }
      }

      responseBody = timeoutResult.result
    } else {
      // No timeout configured
      responseBody = await response.json()
    }

    // Allow provider to process response body
    if (this.processBody) {
      responseBody = this.processBody(responseBody, model)
    }

    // For non-streaming, TTFT and duration are the same
    const duration = Date.now() - requestStartTime
    recordMetricsSuccess(backend.id, requestId, requestStartTime, model, duration, 'non-streaming')
    return {
      success: true,
      response: Response.json(responseBody, {
        status: response.status,
        headers: this.processHeaders(response.headers),
      }),
    }
  }
}
