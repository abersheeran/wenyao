import type { BackendConfig } from '../types/backend.js'
import type { ActiveRequestStore } from './active-requests/interface.js'

/**
 * ConcurrencyLimiter service for tracking and enforcing per-backend concurrent request limits
 * Integrates with ActiveRequestStore to get real-time active request counts
 * Supports multi-instance environments via pluggable storage backends (MongoDB, Redis)
 */
export class ConcurrencyLimiter {
  private store: ActiveRequestStore | null = null

  /**
   * Initialize the limiter with an active request store
   */
  initialize(store: ActiveRequestStore): void {
    this.store = store
  }

  /**
   * Check if metrics/active request tracking is enabled
   */
  isEnabled(): boolean {
    return this.store !== null
  }

  /**
   * Try to acquire a concurrency slot for a backend
   * Returns true if acquired (under limit), false if at/over capacity
   */
  async tryAcquire(backend: BackendConfig, requestId: string): Promise<boolean> {
    if (!this.store) {
      return true // No tracking - always allow
    }

    try {
      return await this.store.tryRecordStart(backend.id, requestId, backend.maxConcurrentRequests)
    } catch (error) {
      console.error(`[ConcurrencyLimiter] Error trying to acquire slot for ${backend.id}:`, error)
      return true // Fail open on storage errors
    }
  }

  /**
   * Record a request start without capacity check
   */
  async recordStart(backendId: string, requestId: string): Promise<void> {
    if (!this.store) return
    await this.store.recordStart(backendId, requestId)
  }

  /**
   * Release a concurrency slot
   */
  async release(backendId: string, requestId: string): Promise<void> {
    if (!this.store) return
    try {
      await this.store.recordComplete(backendId, requestId)
    } catch (error) {
      console.error(`[ConcurrencyLimiter] Error releasing slot for ${backendId}:`, error)
    }
  }

  /**
   * Get current active request count for a backend
   * Returns 0 if disabled
   */
  async getActiveRequestCount(backendId: string): Promise<number> {
    if (!this.store) {
      return 0
    }
    return await this.store.getCount(backendId)
  }

  /**
   * Get current active request counts for all backends
   * Returns empty object if disabled
   */
  async getAllActiveRequestCounts(): Promise<Record<string, number>> {
    if (!this.store) {
      return {}
    }
    return await this.store.getAllCounts()
  }
}

// Singleton instance
export const concurrencyLimiter = new ConcurrencyLimiter()
