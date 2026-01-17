import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PROXY_CONSTANTS,
  createErrorResponse,
  recordMetricsFailure,
  recordMetricsSuccess,
  executeWithTTFTTimeout,
  type TTFTTimeoutContext,
} from '../routes/proxy-helpers.js'
import type { BackendConfig } from '../types/backend.js'

// Create a shared mock function
const mockRecordRequestComplete = vi.fn()

// Mock the getMetricsCollector function
vi.mock('../index.js', () => ({
  getMetricsCollector: () => ({
    recordRequestComplete: mockRecordRequestComplete,
  }),
}))

describe('PROXY_CONSTANTS', () => {
  it('should have all HTTP status codes', () => {
    expect(PROXY_CONSTANTS.HTTP_GATEWAY_TIMEOUT).toBe(504)
    expect(PROXY_CONSTANTS.HTTP_INTERNAL_ERROR).toBe(500)
    expect(PROXY_CONSTANTS.HTTP_SERVICE_UNAVAILABLE).toBe(503)
    expect(PROXY_CONSTANTS.HTTP_TOO_MANY_REQUESTS).toBe(429)
  })

  it('should have timeout check constants', () => {
    expect(PROXY_CONSTANTS.TTFT_ALREADY_EXCEEDED).toBe(0)
    expect(PROXY_CONSTANTS.CIRCULAR_ORDER_START_OFFSET).toBe(1)
  })

  it('should have all error codes', () => {
    expect(PROXY_CONSTANTS.ERROR_CODES.NO_RESPONSE_BODY).toBe('no_response_body')
    expect(PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT).toBe('ttft_timeout')
    expect(PROXY_CONSTANTS.ERROR_CODES.NETWORK_ERROR).toBe('network_error')
    expect(PROXY_CONSTANTS.ERROR_CODES.STREAM_INTERRUPTED).toBe('stream_interrupted')
    expect(PROXY_CONSTANTS.ERROR_CODES.NO_BACKEND).toBe('no_backend')
    expect(PROXY_CONSTANTS.ERROR_CODES.BACKEND_ERROR).toBe('backend_error')
    expect(PROXY_CONSTANTS.ERROR_CODES.STREAMING_PROCESSING_ERROR).toBe('streaming_processing_error')
    expect(PROXY_CONSTANTS.ERROR_CODES.NON_STREAMING_PROCESSING_ERROR).toBe('non_streaming_processing_error')
    expect(PROXY_CONSTANTS.ERROR_CODES.ALL_BACKENDS_AT_CAPACITY).toBe('all_backends_at_capacity')
    expect(PROXY_CONSTANTS.ERROR_CODES.ALL_BACKENDS_FAILED).toBe('all_backends_failed')
  })

  it('should have all error types', () => {
    expect(PROXY_CONSTANTS.ERROR_TYPES.BACKEND_ERROR).toBe('backend_error')
    expect(PROXY_CONSTANTS.ERROR_TYPES.TIMEOUT_ERROR).toBe('timeout_error')
    expect(PROXY_CONSTANTS.ERROR_TYPES.INTERNAL_ERROR).toBe('internal_error')
    expect(PROXY_CONSTANTS.ERROR_TYPES.RATE_LIMIT_ERROR).toBe('rate_limit_exceeded')
    expect(PROXY_CONSTANTS.ERROR_TYPES.SERVICE_UNAVAILABLE).toBe('service_unavailable')
  })
})

describe('createErrorResponse', () => {
  it('should create a valid error response', async () => {
    const response = createErrorResponse(
      'Test error message',
      'test_type',
      'test_code',
      500
    )

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(500)

    const body = await response.json()
    expect(body).toEqual({
      error: {
        message: 'Test error message',
        type: 'test_type',
        code: 'test_code',
      },
    })
  })

  it('should handle different status codes', async () => {
    const statuses = [400, 429, 500, 503, 504]

    for (const status of statuses) {
      const response = createErrorResponse('Error', 'type', 'code', status)
      expect(response.status).toBe(status)
    }
  })

  it('should create proper JSON structure', async () => {
    const response = createErrorResponse(
      'Gateway timeout',
      PROXY_CONSTANTS.ERROR_TYPES.TIMEOUT_ERROR,
      PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT,
      PROXY_CONSTANTS.HTTP_GATEWAY_TIMEOUT
    )

    const body = await response.json()
    expect(body.error).toBeDefined()
    expect(body.error.message).toBe('Gateway timeout')
    expect(body.error.type).toBe('timeout_error')
    expect(body.error.code).toBe('ttft_timeout')
  })
})

describe('recordMetricsFailure', () => {
  beforeEach(() => {
    mockRecordRequestComplete.mockClear()
  })

  it('should call metrics collector with failure data', () => {
    const requestStartTime = Date.now() - 1000
    recordMetricsFailure(
      'backend-1',
      'req-123',
      requestStartTime,
      'gpt-4',
      'network_error'
    )

    expect(mockRecordRequestComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: 'backend-1',
        requestId: 'req-123',
        status: 'failure',
        model: 'gpt-4',
        errorType: 'network_error',
      })
    )

    const callArgs = mockRecordRequestComplete.mock.calls[0][0]
    expect(callArgs.duration).toBeGreaterThan(0)
  })

  it('should calculate duration correctly', () => {
    const requestStartTime = Date.now() - 5000 // 5 seconds ago
    recordMetricsFailure(
      'backend-1',
      'req-123',
      requestStartTime,
      'gpt-4',
      'timeout'
    )

    const callArgs = mockRecordRequestComplete.mock.calls[0][0]
    expect(callArgs.duration).toBeGreaterThanOrEqual(4900)
    expect(callArgs.duration).toBeLessThanOrEqual(5100)
  })
})

describe('recordMetricsSuccess', () => {
  beforeEach(() => {
    mockRecordRequestComplete.mockClear()
  })

  it('should call metrics collector with success data for streaming', () => {
    const requestStartTime = Date.now() - 2000
    recordMetricsSuccess(
      'backend-1',
      'req-456',
      requestStartTime,
      'gpt-4',
      150,
      'streaming'
    )

    expect(mockRecordRequestComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: 'backend-1',
        requestId: 'req-456',
        status: 'success',
        model: 'gpt-4',
        ttft: 150,
        streamType: 'streaming',
      })
    )
  })

  it('should call metrics collector with success data for non-streaming', () => {
    const requestStartTime = Date.now() - 3000
    recordMetricsSuccess(
      'backend-1',
      'req-789',
      requestStartTime,
      'claude-3',
      undefined,
      'non-streaming'
    )

    expect(mockRecordRequestComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: 'backend-1',
        requestId: 'req-789',
        status: 'success',
        model: 'claude-3',
        ttft: undefined,
        streamType: 'non-streaming',
      })
    )
  })

  it('should calculate duration correctly', () => {
    const requestStartTime = Date.now() - 1500
    recordMetricsSuccess(
      'backend-1',
      'req-999',
      requestStartTime,
      'gpt-4',
      100,
      'streaming'
    )

    const callArgs = mockRecordRequestComplete.mock.calls[0][0]
    expect(callArgs.duration).toBeGreaterThanOrEqual(1400)
    expect(callArgs.duration).toBeLessThanOrEqual(1600)
  })
})

describe('executeWithTTFTTimeout', () => {
  let consoleLogSpy: any

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockRecordRequestComplete.mockClear()
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  const createContext = (requestStartTime?: number): TTFTTimeoutContext => ({
    currentBackend: {
      id: 'backend-1',
      url: 'https://test.com',
      apiKey: 'key',
      weight: 1,
      enabled: true,
    } as BackendConfig,
    requestId: 'req-test',
    requestStartTime: requestStartTime || Date.now(),
    model: 'gpt-4',
  })

  it('should execute operation directly when no timeout configured', async () => {
    const operation = vi.fn(async () => 'success')
    const context = createContext()

    const result = await executeWithTTFTTimeout(operation, undefined, context)

    expect(result.success).toBe(true)
    expect(result.result).toBe('success')
    expect(result.timedOut).toBeUndefined()
    expect(operation).toHaveBeenCalled()
  })

  it('should execute operation directly when timeout is 0', async () => {
    const operation = vi.fn(async () => 'success')
    const context = createContext()

    const result = await executeWithTTFTTimeout(operation, 0, context)

    expect(result.success).toBe(true)
    expect(result.result).toBe('success')
    expect(operation).toHaveBeenCalled()
  })

  it('should succeed when operation completes within timeout', async () => {
    const operation = async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return 'success'
    }
    const context = createContext()

    const result = await executeWithTTFTTimeout(operation, 200, context)

    expect(result.success).toBe(true)
    expect(result.result).toBe('success')
    expect(result.timedOut).toBeUndefined()
  })

  it('should timeout when operation takes too long', async () => {
    const operation = async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return 'success'
    }
    const context = createContext()

    const result = await executeWithTTFTTimeout(operation, 50, context)

    expect(result.success).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.response).toBeDefined()

    const errorResponse = result.response!
    expect(errorResponse.status).toBe(PROXY_CONSTANTS.HTTP_GATEWAY_TIMEOUT)

    const body = await errorResponse.json()
    expect(body.error.code).toBe(PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT)
    expect(body.error.type).toBe(PROXY_CONSTANTS.ERROR_TYPES.TIMEOUT_ERROR)
  })

  it('should handle already exceeded timeout before operation', async () => {
    const operation = vi.fn(async () => 'success')
    const requestStartTime = Date.now() - 5000 // 5 seconds ago
    const context = createContext(requestStartTime)

    const result = await executeWithTTFTTimeout(operation, 1000, context) // timeout was 1 second

    expect(result.success).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.response).toBeDefined()
    expect(operation).not.toHaveBeenCalled() // Should not even try
  })

  it('should calculate remaining timeout correctly', async () => {
    const operation = async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return 'success'
    }
    const requestStartTime = Date.now() - 200 // 200ms ago
    const context = createContext(requestStartTime)

    // Total timeout is 500ms, but 200ms already elapsed, so remaining is 300ms
    // Operation takes 100ms, so should succeed
    const result = await executeWithTTFTTimeout(operation, 500, context)

    expect(result.success).toBe(true)
    expect(result.result).toBe('success')
  })

  it('should timeout with remaining time', async () => {
    const operation = async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
      return 'success'
    }
    const requestStartTime = Date.now() - 800 // 800ms ago
    const context = createContext(requestStartTime)

    // Total timeout is 1000ms, 800ms elapsed, remaining is 200ms
    // Operation takes 400ms, so should timeout
    const result = await executeWithTTFTTimeout(operation, 1000, context)

    expect(result.success).toBe(false)
    expect(result.timedOut).toBe(true)
  })

  it('should record metrics on timeout before operation', async () => {
    const operation = vi.fn(async () => 'success')
    const requestStartTime = Date.now() - 5000
    const context = createContext(requestStartTime)

    await executeWithTTFTTimeout(operation, 1000, context)

    expect(mockRecordRequestComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: 'backend-1',
        requestId: 'req-test',
        status: 'failure',
        errorType: PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT,
      })
    )
  })

  it('should record metrics on timeout during operation', async () => {
    const operation = async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return 'success'
    }
    const context = createContext()

    await executeWithTTFTTimeout(operation, 50, context)

    expect(mockRecordRequestComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: 'backend-1',
        requestId: 'req-test',
        status: 'failure',
        errorType: PROXY_CONSTANTS.ERROR_CODES.TTFT_TIMEOUT,
      })
    )
  })

  it('should clean up timeout on success', async () => {
    // This test verifies that setTimeout is properly cleared
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')

    const operation = async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return 'success'
    }
    const context = createContext()

    await executeWithTTFTTimeout(operation, 100, context)

    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })

  it('should handle operation errors gracefully', async () => {
    const operation = async () => {
      throw new Error('Operation failed')
    }
    const context = createContext()

    await expect(
      executeWithTTFTTimeout(operation, 1000, context)
    ).rejects.toThrow('Operation failed')
  })

  it('should handle Promise.race edge cases', async () => {
    // Operation completes exactly at timeout boundary
    const operation = async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return 'success'
    }
    const context = createContext()

    const result = await executeWithTTFTTimeout(operation, 50, context)

    // Either success or timeout is acceptable at the boundary
    expect(result.success !== undefined).toBe(true)
  })

  it('should log timeout message before operation', async () => {
    const requestStartTime = Date.now() - 5000
    const context = createContext(requestStartTime)
    const operation = vi.fn(async () => 'success')

    await executeWithTTFTTimeout(operation, 1000, context)

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Proxy] Backend backend-1 TTFT timeout before operation')
    )
  })

  it('should log timeout message during operation', async () => {
    const context = createContext()
    const operation = async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return 'success'
    }

    await executeWithTTFTTimeout(operation, 50, context)

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Proxy] Backend backend-1 TTFT timeout during operation')
    )
  })

  it('should handle negative timeout gracefully', async () => {
    const operation = vi.fn(async () => 'success')
    const context = createContext()

    const result = await executeWithTTFTTimeout(operation, -100, context)

    // Negative timeout should be treated as no timeout (execute directly)
    // because the condition checks: if (!ttftTimeout || ttftTimeout <= 0)
    expect(result.success).toBe(true)
    expect(result.result).toBe('success')
  })
})
