import { MetricsStorage } from './storage.js'

/**
 * Prometheus text format exporter
 * Generates Prometheus exposition format from MongoDB metrics
 */
export class PrometheusExporter {
  constructor(private storage: MetricsStorage) {}

  /**
   * Generate Prometheus text format metrics
   * Query recent metrics (last 5 minutes) and format as Prometheus
   */
  async generateMetrics(): Promise<string> {
    const now = new Date()
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000)

    const statsMap = await this.storage.getAllStats({
      startTime: fiveMinutesAgo,
      endTime: now
    })

    const lines: string[] = []

    // === Total Requests Counter ===
    lines.push('# HELP llm_proxy_requests_total Total number of requests per backend')
    lines.push('# TYPE llm_proxy_requests_total counter')

    for (const [backendId, stats] of statsMap) {
      const successCount = stats.successfulRequests
      const failureCount = stats.failedRequests

      if (successCount > 0) {
        lines.push(
          `llm_proxy_requests_total{backend_id="${backendId}",status="success"} ${successCount}`
        )
      }
      if (failureCount > 0) {
        lines.push(
          `llm_proxy_requests_total{backend_id="${backendId}",status="failure"} ${failureCount}`
        )
      }
    }

    // === Request Duration Histogram ===
    lines.push('')
    lines.push('# HELP llm_proxy_request_duration_seconds Request duration in seconds')
    lines.push('# TYPE llm_proxy_request_duration_seconds histogram')

    // Note: For true histogram support, we'd need to store duration buckets
    // For now, we'll export summary statistics
    for (const [backendId, stats] of statsMap) {
      if (stats.totalRequests > 0) {
        lines.push(`llm_proxy_request_duration_seconds_count{backend_id="${backendId}"} ${stats.totalRequests}`)
      }
    }

    // === TTFT Histogram ===
    lines.push('')
    lines.push('# HELP llm_proxy_ttft_seconds Time to first token in seconds')
    lines.push('# TYPE llm_proxy_ttft_seconds histogram')

    for (const [backendId, stats] of statsMap) {
      // Streaming TTFT
      if (stats.averageStreamingTTFT > 0) {
        const ttftSeconds = stats.averageStreamingTTFT / 1000
        lines.push(
          `llm_proxy_ttft_seconds_sum{backend_id="${backendId}",stream_type="streaming"} ${ttftSeconds.toFixed(3)}`
        )
        lines.push(
          `llm_proxy_ttft_seconds_count{backend_id="${backendId}",stream_type="streaming"} 1`
        )
      }

      // Non-streaming TTFT
      if (stats.averageNonStreamingTTFT > 0) {
        const ttftSeconds = stats.averageNonStreamingTTFT / 1000
        lines.push(
          `llm_proxy_ttft_seconds_sum{backend_id="${backendId}",stream_type="non-streaming"} ${ttftSeconds.toFixed(3)}`
        )
        lines.push(
          `llm_proxy_ttft_seconds_count{backend_id="${backendId}",stream_type="non-streaming"} 1`
        )
      }
    }

    // === Success Rate Gauge ===
    lines.push('')
    lines.push('# HELP llm_proxy_success_rate Success rate per backend (0.0 to 1.0)')
    lines.push('# TYPE llm_proxy_success_rate gauge')

    for (const [backendId, stats] of statsMap) {
      if (stats.totalRequests > 0) {
        lines.push(
          `llm_proxy_success_rate{backend_id="${backendId}"} ${stats.successRate.toFixed(4)}`
        )
      }
    }

    // === Active Requests Gauge ===
    // Note: This would require tracking active requests separately
    // For now, we'll skip this metric or calculate from recent requests
    lines.push('')
    lines.push('# HELP llm_proxy_active_requests Currently active requests per backend')
    lines.push('# TYPE llm_proxy_active_requests gauge')

    for (const [backendId] of statsMap) {
      try {
        const activeCount = await this.storage.getActiveRequestsCount(backendId)
        if (activeCount > 0) {
          lines.push(`llm_proxy_active_requests{backend_id="${backendId}"} ${activeCount}`)
        }
      } catch (error) {
        console.error(`Failed to get active requests for ${backendId}:`, error)
      }
    }

    lines.push('') // Trailing newline
    return lines.join('\n')
  }
}
