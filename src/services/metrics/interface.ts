import type { BackendStats, StatsDataPoint } from '../../types/backend.js'
import type { RequestCompleteData, TimeWindow, HistoryQueryParams } from './types.js'

/**
 * MetricsCollector interface - defines the contract for metrics collection
 * Implementations: DbMetricsCollector (database-backed), NoopMetricsCollector (disabled)
 */
export interface MetricsCollector {
  /**
   * Record when a request starts (for tracking active requests)
   */
  recordRequestStart(backendId: string, requestId: string): void

  /**
   * Record request completion with full metrics
   * This should be fire-and-forget (async, non-blocking)
   */
  recordRequestComplete(data: RequestCompleteData): Promise<void>

  /**
   * Get aggregated stats for a specific backend within a time window
   */
  getStats(backendId: string, timeWindow: TimeWindow): Promise<BackendStats>

  /**
   * Get recent stats for a specific backend (used by load balancer)
   * @param windowMs - Time window in milliseconds (e.g., 900000 for 15 minutes)
   */
  getRecentStats(backendId: string, windowMs: number): Promise<BackendStats>

  /**
   * Get aggregated stats for all backends within a time window
   */
  getAllStats(timeWindow: TimeWindow): Promise<Map<string, BackendStats>>

  /**
   * Reset stats for a specific backend or all backends
   * Returns the number of deleted records
   */
  resetStats(backendId?: string): Promise<number>

  /**
   * Get historical stats data points (raw time-series data)
   */
  getHistoricalStats(params: HistoryQueryParams): Promise<StatsDataPoint[]>

  /**
   * Generate Prometheus-format metrics text
   * Used by /admin/metrics endpoint
   */
  getPrometheusMetrics(): Promise<string>

  /**
   * Check if metrics collection is enabled
   */
  isEnabled(): boolean

  /**
   * Cleanup and shutdown the collector
   */
  shutdown(): Promise<void>
}
