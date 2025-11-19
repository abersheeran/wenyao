import { Registry, Counter, Histogram, Gauge } from 'prom-client'
import type { BackendStats, StatsDataPoint } from '../types/backend.js'
import { mongoDBService } from './mongodb.js'
import { instanceManager } from './instance-manager.js'

export class StatsTracker {
  private registry: Registry
  private historyInterval: NodeJS.Timeout | null = null
  private lastSnapshotStats: Map<string, {
    totalRequests: number
    successfulRequests: number
    failedRequests: number
  }> = new Map()

  // Prometheus metrics
  private requestsTotal: Counter
  private requestDuration: Histogram
  private ttftHistogram: Histogram
  private activeRequests: Gauge

  constructor() {
    this.registry = new Registry()

    // Total requests counter (with instance and status labels)
    this.requestsTotal = new Counter({
      name: 'llm_proxy_requests_total',
      help: 'Total number of requests to backends',
      labelNames: ['instance', 'backend_id', 'status'],
      registers: [this.registry]
    })

    // Request duration histogram
    this.requestDuration = new Histogram({
      name: 'llm_proxy_request_duration_seconds',
      help: 'Request duration in seconds',
      labelNames: ['instance', 'backend_id', 'status'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry]
    })

    // TTFT (Time To First Token) histogram
    this.ttftHistogram = new Histogram({
      name: 'llm_proxy_ttft_seconds',
      help: 'Time to first token in seconds',
      labelNames: ['instance', 'backend_id', 'stream_type'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [this.registry]
    })

    // Active requests gauge
    this.activeRequests = new Gauge({
      name: 'llm_proxy_active_requests',
      help: 'Number of currently active requests',
      labelNames: ['instance', 'backend_id'],
      registers: [this.registry]
    })
  }

  // Record a successful request
  recordSuccess(backendId: string, ttft?: number, duration?: number, isStream?: boolean): void {
    const instance = instanceManager.getInstanceId()
    this.requestsTotal.inc({ instance, backend_id: backendId, status: 'success' })

    if (duration !== undefined) {
      this.requestDuration.observe({ instance, backend_id: backendId, status: 'success' }, duration / 1000)
    }

    if (ttft !== undefined) {
      // Treat undefined isStream as false (non-streaming)
      const streamType = (isStream === true) ? 'streaming' : 'non-streaming'
      this.ttftHistogram.observe({ instance, backend_id: backendId, stream_type: streamType }, ttft / 1000)
    }
  }

  // Record a failed request
  recordFailure(backendId: string, duration?: number): void {
    const instance = instanceManager.getInstanceId()
    this.requestsTotal.inc({ instance, backend_id: backendId, status: 'failure' })

    if (duration !== undefined) {
      this.requestDuration.observe({ instance, backend_id: backendId, status: 'failure' }, duration / 1000)
    }
  }

  // Increment active requests
  incrementActive(backendId: string): void {
    const instance = instanceManager.getInstanceId()
    this.activeRequests.inc({ instance, backend_id: backendId })
  }

  // Decrement active requests
  decrementActive(backendId: string): void {
    const instance = instanceManager.getInstanceId()
    this.activeRequests.dec({ instance, backend_id: backendId })
  }

  // Get Prometheus metrics in text format
  async getMetrics(): Promise<string> {
    return this.registry.metrics()
  }

  // Get stats for a specific backend (for backward compatibility)
  async getStats(backendId: string): Promise<BackendStats | undefined> {
    const metricsText = await this.registry.metrics()
    const lines = metricsText.split('\n')
    const instance = instanceManager.getInstanceId()

    let successfulRequests = 0
    let failedRequests = 0
    let streamingTtftSum = 0
    let streamingTtftCount = 0
    let nonStreamingTtftSum = 0
    let nonStreamingTtftCount = 0

    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') continue

      // Parse llm_proxy_requests_total (filter by current instance)
      if (line.includes('llm_proxy_requests_total') &&
          line.includes(`instance="${instance}"`) &&
          line.includes(`backend_id="${backendId}"`)) {
        const value = parseFloat(line.split(' ')[1])
        if (line.includes('status="success"')) {
          successfulRequests = value
        } else if (line.includes('status="failure"')) {
          failedRequests = value
        }
      }

      // Parse llm_proxy_ttft_seconds sum and count (filter by current instance)
      if (line.includes('llm_proxy_ttft_seconds') &&
          line.includes(`instance="${instance}"`) &&
          line.includes(`backend_id="${backendId}"`)) {

        // Parse streaming TTFT
        if (line.includes('stream_type="streaming"')) {
          if (line.includes('_sum')) {
            streamingTtftSum = parseFloat(line.split(' ')[1])
          } else if (line.includes('_count')) {
            streamingTtftCount = parseFloat(line.split(' ')[1])
          }
        }

        // Parse non-streaming TTFT
        if (line.includes('stream_type="non-streaming"')) {
          if (line.includes('_sum')) {
            nonStreamingTtftSum = parseFloat(line.split(' ')[1])
          } else if (line.includes('_count')) {
            nonStreamingTtftCount = parseFloat(line.split(' ')[1])
          }
        }
      }
    }

    const totalRequests = successfulRequests + failedRequests
    if (totalRequests === 0) return undefined

    const averageStreamingTTFT = streamingTtftCount > 0 ? (streamingTtftSum / streamingTtftCount) * 1000 : 0
    const averageNonStreamingTTFT = nonStreamingTtftCount > 0 ? (nonStreamingTtftSum / nonStreamingTtftCount) * 1000 : 0

    return {
      backendId,
      totalRequests,
      successfulRequests,
      failedRequests,
      successRate: totalRequests > 0 ? successfulRequests / totalRequests : 0,
      averageStreamingTTFT,
      averageNonStreamingTTFT,
      ttftSamples: []
    }
  }

  // Get all stats (for backward compatibility)
  async getAllStats(): Promise<BackendStats[]> {
    const metricsText = await this.registry.metrics()
    const lines = metricsText.split('\n')
    const backendIds = new Set<string>()

    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') continue

      if (line.includes('llm_proxy_requests_total')) {
        const match = line.match(/backend_id="([^"]+)"/)
        if (match) {
          backendIds.add(match[1])
        }
      }
    }

    const stats = await Promise.all(
      Array.from(backendIds).map(id => this.getStats(id))
    )

    return stats.filter((stat): stat is BackendStats => stat !== undefined)
  }

  // Reset stats for a backend
  resetStats(backendId: string): void {
    // Prometheus doesn't support resetting individual metrics
    // This is a limitation, but metrics should generally not be reset in production
    console.warn('Individual metric reset not supported with Prometheus')
  }

  // Reset all stats
  resetAllStats(): void {
    this.registry.resetMetrics()
  }

  // Get the registry (useful for custom metrics)
  getRegistry(): Registry {
    return this.registry
  }

  // Start tracking historical stats (saves snapshot every 15 seconds, like Grafana)
  startHistoryTracking(intervalMs: number = 15 * 1000): void {
    if (this.historyInterval) {
      console.warn('History tracking is already running')
      return
    }

    // Save initial snapshot
    this.saveCurrentStatsSnapshot().catch(err => {
      console.error('Failed to save initial stats snapshot:', err)
    })

    // Set up periodic snapshot saving
    this.historyInterval = setInterval(() => {
      this.saveCurrentStatsSnapshot().catch(err => {
        console.error('Failed to save stats snapshot:', err)
      })
    }, intervalMs)

    console.log(`Started stats history tracking (interval: ${intervalMs}ms)`)
  }

  // Stop tracking historical stats
  stopHistoryTracking(): void {
    if (this.historyInterval) {
      clearInterval(this.historyInterval)
      this.historyInterval = null
      console.log('Stopped stats history tracking')
    }
  }

  // Save current stats snapshot to MongoDB
  private async saveCurrentStatsSnapshot(): Promise<void> {
    if (!mongoDBService.isConnected()) {
      console.warn('MongoDB not connected, skipping stats snapshot')
      return
    }

    try {
      const allStats = await this.getAllStats()
      const timestamp = new Date()
      const collection = mongoDBService.getStatsHistoryCollection()

      // Prepare data points for all backends
      const dataPoints: StatsDataPoint[] = allStats.map(stats => {
        // Calculate incremental requests since last snapshot
        const lastSnapshot = this.lastSnapshotStats.get(stats.backendId)
        const requestsInPeriod = lastSnapshot
          ? stats.totalRequests - lastSnapshot.totalRequests
          : 0 // First snapshot: don't include historical data

        const successfulInPeriod = lastSnapshot
          ? stats.successfulRequests - lastSnapshot.successfulRequests
          : 0

        const failedInPeriod = lastSnapshot
          ? stats.failedRequests - lastSnapshot.failedRequests
          : 0

        // Calculate success rate for this period
        const successRate = requestsInPeriod > 0
          ? successfulInPeriod / requestsInPeriod
          : 0

        // Update last snapshot stats
        this.lastSnapshotStats.set(stats.backendId, {
          totalRequests: stats.totalRequests,
          successfulRequests: stats.successfulRequests,
          failedRequests: stats.failedRequests
        })

        return {
          instanceId: instanceManager.getInstanceId(),
          backendId: stats.backendId,
          timestamp,
          totalRequests: requestsInPeriod, // Store incremental count instead of cumulative
          successfulRequests: successfulInPeriod,
          failedRequests: failedInPeriod,
          successRate,
          averageStreamingTTFT: stats.averageStreamingTTFT,
          averageNonStreamingTTFT: stats.averageNonStreamingTTFT,
          requestsInPeriod
        }
      })

      // Save all data points (skip if no backends have stats)
      if (dataPoints.length > 0) {
        await collection.insertMany(dataPoints)
        console.log(`Saved stats snapshot for ${dataPoints.length} backends at ${timestamp.toISOString()}`)
      }
    } catch (error) {
      console.error('Error saving stats snapshot:', error)
      throw error
    }
  }

  // Get historical stats for a specific backend
  async getHistoricalStats(backendId: string, startTime?: Date, endTime?: Date): Promise<StatsDataPoint[]> {
    if (!mongoDBService.isConnected()) {
      return []
    }

    try {
      const collection = mongoDBService.getStatsHistoryCollection()
      const query: any = { backendId }

      // Build time range query
      if (startTime || endTime) {
        query.timestamp = {}
        if (startTime) query.timestamp.$gte = startTime
        if (endTime) query.timestamp.$lte = endTime
      }

      const dataPoints = await collection
        .find(query)
        .sort({ timestamp: 1 }) // Ascending order for chart display
        .toArray()

      return dataPoints
    } catch (error) {
      console.error(`Error fetching historical stats for backend ${backendId}:`, error)
      return []
    }
  }

  // Get historical stats for all backends
  async getAllHistoricalStats(startTime?: Date, endTime?: Date): Promise<Map<string, StatsDataPoint[]>> {
    if (!mongoDBService.isConnected()) {
      return new Map()
    }

    try {
      const collection = mongoDBService.getStatsHistoryCollection()
      const query: any = {}

      // Build time range query
      if (startTime || endTime) {
        query.timestamp = {}
        if (startTime) query.timestamp.$gte = startTime
        if (endTime) query.timestamp.$lte = endTime
      }

      const dataPoints = await collection
        .find(query)
        .sort({ timestamp: 1 })
        .toArray()

      // Group by backendId
      const grouped = new Map<string, StatsDataPoint[]>()
      for (const point of dataPoints) {
        const existing = grouped.get(point.backendId) || []
        existing.push(point)
        grouped.set(point.backendId, existing)
      }

      return grouped
    } catch (error) {
      console.error('Error fetching all historical stats:', error)
      return new Map()
    }
  }

  /**
   * Get time-windowed stats for a specific backend
   * This is preferred over cumulative stats for load balancing decisions
   * @param backendId - Backend ID to get stats for
   * @param windowMinutes - Time window in minutes (default: 15)
   * @returns Stats aggregated over the time window, or undefined if insufficient data
   */
  async getRecentStats(backendId: string, windowMinutes: number = 15): Promise<BackendStats | undefined> {
    // Try to get from MongoDB historical data if available
    if (mongoDBService.isConnected()) {
      try {
        const startTime = new Date(Date.now() - windowMinutes * 60 * 1000)
        const dataPoints = await this.getHistoricalStats(backendId, startTime)

        if (dataPoints.length === 0) {
          // No historical data, fall back to current stats
          return await this.getStats(backendId)
        }

        // Aggregate data points
        const totalRequests = dataPoints.reduce((sum, p) => sum + p.totalRequests, 0)
        const successfulRequests = dataPoints.reduce((sum, p) => sum + p.successfulRequests, 0)
        const failedRequests = dataPoints.reduce((sum, p) => sum + p.failedRequests, 0)

        // Calculate weighted average TTFT
        let streamingTtftSum = 0
        let streamingTtftCount = 0
        let nonStreamingTtftSum = 0
        let nonStreamingTtftCount = 0

        for (const point of dataPoints) {
          if (point.averageStreamingTTFT > 0) {
            streamingTtftSum += point.averageStreamingTTFT * point.requestsInPeriod
            streamingTtftCount += point.requestsInPeriod
          }
          if (point.averageNonStreamingTTFT > 0) {
            nonStreamingTtftSum += point.averageNonStreamingTTFT * point.requestsInPeriod
            nonStreamingTtftCount += point.requestsInPeriod
          }
        }

        const averageStreamingTTFT = streamingTtftCount > 0 ? streamingTtftSum / streamingTtftCount : 0
        const averageNonStreamingTTFT = nonStreamingTtftCount > 0 ? nonStreamingTtftSum / nonStreamingTtftCount : 0

        if (totalRequests === 0) {
          return undefined
        }

        return {
          backendId,
          totalRequests,
          successfulRequests,
          failedRequests,
          successRate: successfulRequests / totalRequests,
          averageStreamingTTFT,
          averageNonStreamingTTFT,
          ttftSamples: []
        }
      } catch (error) {
        console.error(`Error fetching recent stats for backend ${backendId}:`, error)
        // Fall back to current stats
      }
    }

    // Fallback: use cumulative stats if MongoDB not available
    return await this.getStats(backendId)
  }

  /**
   * Get time-windowed stats for all backends
   * @param windowMinutes - Time window in minutes (default: 15)
   * @returns Map of backend ID to stats
   */
  async getAllRecentStats(windowMinutes: number = 15): Promise<Map<string, BackendStats>> {
    const result = new Map<string, BackendStats>()

    // Get all backend IDs from current stats
    const allStats = await this.getAllStats()
    const backendIds = allStats.map(s => s.backendId)

    // Fetch recent stats for each backend
    await Promise.all(
      backendIds.map(async (backendId) => {
        const stats = await this.getRecentStats(backendId, windowMinutes)
        if (stats) {
          result.set(backendId, stats)
        }
      })
    )

    return result
  }
}

// Singleton instance
export const statsTracker = new StatsTracker()
