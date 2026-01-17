import type { Db } from 'mongodb'
import type { BackendStats, StatsDataPoint } from '../../types/backend.js'
import type { MetricsCollector } from './interface.js'
import type { MetricsDataPoint, RequestCompleteData, TimeWindow, HistoryQueryParams } from './types.js'
import { MetricsStorage } from './storage.js'
import { PrometheusExporter } from './prometheus-exporter.js'
import { randomUUID } from 'crypto'

/**
 * Database-backed metrics collector
 * Writes metrics to MongoDB in real-time (fire-and-forget)
 * Automatically uses pre-aggregated views for optimized queries
 */
export class DbMetricsCollector implements MetricsCollector {
  private storage: MetricsStorage
  private prometheusExporter: PrometheusExporter
  private instanceId: string

  constructor(private db: Db, instanceId?: string) {
    this.storage = new MetricsStorage(db)
    this.prometheusExporter = new PrometheusExporter(this.storage)
    this.instanceId = instanceId || randomUUID()
  }

  /**
   * Initialize the collector (must be called once during startup)
   * Automatically creates pre-aggregated views for performance optimization
   */
  async initialize(): Promise<void> {
    await this.storage.initialize()
    console.log(`✓ DbMetricsCollector initialized (instanceId: ${this.instanceId})`)
  }

  async recordRequestComplete(data: RequestCompleteData): Promise<void> {
    // Fire-and-forget: don't await, don't block request flow
    this.insertMetricAsync(data).catch((error) => {
      console.error('Failed to record metric:', error)
    })
  }

  private async insertMetricAsync(data: RequestCompleteData): Promise<void> {
    const metric: MetricsDataPoint = {
      instanceId: this.instanceId,
      backendId: data.backendId,
      timestamp: new Date(),
      requestId: data.requestId,
      status: data.status,
      duration: data.duration,
      ttft: data.ttft,
      streamType: data.streamType,
      model: data.model,
      errorType: data.errorType
    }

    await this.storage.insertMetric(metric)
  }

  async getStats(backendId: string, timeWindow: TimeWindow): Promise<BackendStats> {
    return this.storage.getStats(backendId, timeWindow)
  }

  async getRecentStats(backendId: string, windowMs: number): Promise<BackendStats> {
    const now = new Date()
    const startTime = new Date(now.getTime() - windowMs)

    return this.storage.getStats(backendId, { startTime, endTime: now })
  }

  async getAllStats(timeWindow: TimeWindow): Promise<Map<string, BackendStats>> {
    return this.storage.getAllStats(timeWindow)
  }

  async resetStats(backendId?: string): Promise<number> {
    return this.storage.deleteStats(backendId)
  }

  async getHistoricalStats(params: HistoryQueryParams): Promise<StatsDataPoint[]> {
    return this.storage.getHistoricalStats(params)
  }

  async getPrometheusMetrics(): Promise<string> {
    return this.prometheusExporter.generateMetrics()
  }

  isEnabled(): boolean {
    return true
  }

  async shutdown(): Promise<void> {
    console.log('DbMetricsCollector shutdown')
  }
}
