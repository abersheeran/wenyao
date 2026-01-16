import type { BackendStats, StatsDataPoint } from '../../types/backend.js'
import type { MetricsCollector } from './interface.js'
import type { RequestCompleteData, TimeWindow, HistoryQueryParams } from './types.js'

/**
 * No-op implementation of MetricsCollector used when metrics are disabled
 * All methods are lightweight and return empty/default values
 */
export class NoopMetricsCollector implements MetricsCollector {
  recordRequestStart(_backendId: string, _requestId: string): void {
    // No-op
  }

  async recordRequestComplete(_data: RequestCompleteData): Promise<void> {
    // No-op
  }

  async getStats(_backendId: string, _timeWindow: TimeWindow): Promise<BackendStats> {
    return this.getEmptyStats(_backendId)
  }

  async getRecentStats(_backendId: string, _windowMs: number): Promise<BackendStats> {
    return this.getEmptyStats(_backendId)
  }

  async getAllStats(_timeWindow: TimeWindow): Promise<Map<string, BackendStats>> {
    return new Map()
  }

  async resetStats(_backendId?: string): Promise<number> {
    return 0
  }

  async getHistoricalStats(_params: HistoryQueryParams): Promise<StatsDataPoint[]> {
    return []
  }

  async getPrometheusMetrics(): Promise<string> {
    return '# Metrics disabled\n'
  }

  isEnabled(): boolean {
    return false
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  private getEmptyStats(backendId: string): BackendStats {
    return {
      backendId,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      successRate: 0,
      averageStreamingTTFT: 0,
      averageNonStreamingTTFT: 0,
      ttftSamples: []
    }
  }
}
