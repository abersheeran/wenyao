/**
 * Active request store interface
 * Abstracts storage backend for tracking active requests across instances
 * Currently supports: MongoDB, Redis
 */
export interface ActiveRequestStore {
  /**
   * Initialize the store (create indexes, connections, etc.)
   */
  initialize(): Promise<void>

  /**
   * Atomically try to record a request start if under capacity limit
   * This method performs a check-and-set operation to prevent race conditions
   * @param backendId - Backend identifier
   * @param requestId - Unique request identifier
   * @param maxLimit - Maximum concurrent requests allowed (undefined/0 = no limit)
   * @returns true if request was recorded (under limit), false if at/over capacity
   */
  tryRecordStart(
    backendId: string,
    requestId: string,
    maxLimit: number | undefined
  ): Promise<boolean>

  /**
   * Record that a request has started (without capacity check)
   * Use this when no concurrent limit is configured
   * @param backendId - Backend identifier
   * @param requestId - Unique request identifier
   */
  recordStart(backendId: string, requestId: string): Promise<void>

  /**
   * Record that a request has completed (remove from active)
   * @param backendId - Backend identifier
   * @param requestId - Unique request identifier
   */
  recordComplete(backendId: string, requestId: string): Promise<void>

  /**
   * Get count of active requests for a specific backend
   * @param backendId - Backend identifier
   * @returns Number of active requests
   */
  getCount(backendId: string): Promise<number>

  /**
   * Get counts of active requests for all backends
   * @returns Record mapping backendId to active request count
   */
  getAllCounts(): Promise<Record<string, number>>

  /**
   * Cleanup all active requests for a specific instance
   * Used during graceful shutdown
   * @param instanceId - Instance identifier
   */
  cleanup(instanceId: string): Promise<number>

  /**
   * Shutdown and cleanup resources
   */
  shutdown(): Promise<void>
}

/**
 * Active request metadata
 */
export interface ActiveRequest {
  requestId: string
  backendId: string
  instanceId: string
  startTime: Date
}
