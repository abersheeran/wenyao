import { MetricsStorage } from './storage.js'
import { concurrencyLimiter } from '../concurrency-limiter.js'
import { configManager } from '../config-manager.js'

/**
 * Prometheus text format exporter
 * Generates Prometheus exposition format from MongoDB metrics
 */
export class PrometheusExporter {
  constructor(private storage: MetricsStorage) {}

  /**
   * Generate Prometheus text format metrics
   * Query recent metrics (last 1 minute) and format as Prometheus
   */
  async generateMetrics(): Promise<string> {
    const now = new Date()
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000)

    const statsMap = await this.storage.getAllStats({
      startTime: oneMinuteAgo,
      endTime: now,
    })

    const backendIds: string[] = []
    const seenBackendIds = new Set<string>()

    const addBackendId = (backendId: string) => {
      if (seenBackendIds.has(backendId)) {
        return
      }
      seenBackendIds.add(backendId)
      backendIds.push(backendId)
    }

    // Prefer configured backends first (stable ordering), then include any with recent stats.
    for (const model of configManager.getAllModels()) {
      for (const backend of model.backends) {
        if (backend.enabled) {
          addBackendId(backend.id)
        }
      }
    }

    for (const backendId of statsMap.keys()) {
      addBackendId(backendId)
    }

    const lines: string[] = []

    // === Total Requests Counter ===
    lines.push('# HELP llm_proxy_requests_total Total number of requests per backend')
    lines.push('# TYPE llm_proxy_requests_total counter')

    for (const backendId of backendIds) {
      const stats = statsMap.get(backendId)
      const successCount = stats?.successfulRequests ?? 0
      const failureCount = stats?.failedRequests ?? 0

      lines.push(
        `llm_proxy_requests_total{backend_id="${backendId}",status="success"} ${successCount}`
      )
      lines.push(
        `llm_proxy_requests_total{backend_id="${backendId}",status="failure"} ${failureCount}`
      )
    }

    // === Request Duration Histogram ===
    lines.push('')
    lines.push('# HELP llm_proxy_request_duration_seconds Request duration in seconds')
    lines.push('# TYPE llm_proxy_request_duration_seconds histogram')

    // Note: For true histogram support, we'd need to store duration buckets
    // For now, we'll export summary statistics
    for (const backendId of backendIds) {
      const stats = statsMap.get(backendId)
      const totalRequests = stats?.totalRequests ?? 0
      lines.push(
        `llm_proxy_request_duration_seconds_count{backend_id="${backendId}"} ${totalRequests}`
      )
    }

    // === TTFT Histogram ===
    lines.push('')
    lines.push('# HELP llm_proxy_ttft_seconds Time to first token in seconds')
    lines.push('# TYPE llm_proxy_ttft_seconds histogram')

    for (const backendId of backendIds) {
      const stats = statsMap.get(backendId)

      // Streaming TTFT
      const streamingAvgMs = stats?.averageStreamingTTFT ?? 0
      const streamingSumSeconds = streamingAvgMs > 0 ? streamingAvgMs / 1000 : 0
      const streamingCount = streamingAvgMs > 0 ? 1 : 0
      lines.push(
        `llm_proxy_ttft_seconds_sum{backend_id="${backendId}",stream_type="streaming"} ${streamingSumSeconds.toFixed(3)}`
      )
      lines.push(
        `llm_proxy_ttft_seconds_count{backend_id="${backendId}",stream_type="streaming"} ${streamingCount}`
      )

      // Non-streaming TTFT
      const nonStreamingAvgMs = stats?.averageNonStreamingTTFT ?? 0
      const nonStreamingSumSeconds = nonStreamingAvgMs > 0 ? nonStreamingAvgMs / 1000 : 0
      const nonStreamingCount = nonStreamingAvgMs > 0 ? 1 : 0
      lines.push(
        `llm_proxy_ttft_seconds_sum{backend_id="${backendId}",stream_type="non-streaming"} ${nonStreamingSumSeconds.toFixed(3)}`
      )
      lines.push(
        `llm_proxy_ttft_seconds_count{backend_id="${backendId}",stream_type="non-streaming"} ${nonStreamingCount}`
      )
    }

    // === Success Rate Gauge ===
    lines.push('')
    lines.push('# HELP llm_proxy_success_rate Success rate per backend (0.0 to 1.0)')
    lines.push('# TYPE llm_proxy_success_rate gauge')

    for (const backendId of backendIds) {
      const stats = statsMap.get(backendId)
      const totalRequests = stats?.totalRequests ?? 0
      const successRate = totalRequests > 0 ? stats!.successRate : 1
      lines.push(
        `llm_proxy_success_rate{backend_id="${backendId}"} ${successRate.toFixed(4)}`
      )
    }

    // === Active Requests Gauge ===
    lines.push('')
    lines.push('# HELP llm_proxy_active_requests Currently active requests per backend')
    lines.push('# TYPE llm_proxy_active_requests gauge')

    // Only export active requests if concurrency limiter is enabled
    if (concurrencyLimiter.isEnabled()) {
      try {
        const activeCounts = await concurrencyLimiter.getAllActiveRequestCounts()
        for (const backendId of backendIds) {
          const activeCount = activeCounts[backendId] ?? 0
          lines.push(`llm_proxy_active_requests{backend_id="${backendId}"} ${activeCount}`)
        }
      } catch (error) {
        console.error('Failed to get all active request counts for Prometheus:', error)
      }
    }

    lines.push('') // Trailing newline
    return lines.join('\n')
  }
}
