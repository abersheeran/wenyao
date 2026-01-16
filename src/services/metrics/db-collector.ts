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
 */
export class DbMetricsCollector implements MetricsCollector {
  private storage: MetricsStorage
  private prometheusExporter: PrometheusExporter
  private instanceId: string
  private activeRequests: Map<string, { backendId: string; startTime: number }>

  constructor(private db: Db, instanceId?: string) {
    this.storage = new MetricsStorage(db)
    this.prometheusExporter = new PrometheusExporter(this.storage)
    this.instanceId = instanceId || randomUUID()
    this.activeRequests = new Map()
  }

  /**
   * Initialize the collector (must be called once during startup)
   */
  async initialize(): Promise<void> {
    await this.storage.initialize()
    console.log(`DbMetricsCollector initialized with instanceId: ${this.instanceId}`)
  }

  recordRequestStart(backendId: string, requestId: string): void {
    this.activeRequests.set(requestId, {
      backendId,
      startTime: Date.now()
    })
  }

  async recordRequestComplete(data: RequestCompleteData): Promise<void> {
    // Fire-and-forget: don't await, don't block request flow
    this.insertMetricAsync(data).catch((error) => {
      console.error('Failed to record metric:', error)
    })

    // Clean up active request tracking
    this.activeRequests.delete(data.requestId)
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
    console.log(`DbMetricsCollector shutdown (${this.activeRequests.size} active requests)`)
    this.activeRequests.clear()
  }
}
