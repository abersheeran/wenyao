import { ConcurrencyLimiter } from '../concurrency-limiter.js'

import type { DbMetricsCollector } from './db-collector.js'
import type { MetricsTotals } from './types.js'
import type { ModelConfig } from '../../types/backend.js'

function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

/** Metric names stay stable; completed-request metrics include the model label.
 * Active requests remain keyed only by backend ID, matching concurrency DOs.
 */
export class PrometheusExporter {
  constructor(
    private metrics: DbMetricsCollector,
    private db: D1Database,
    private concurrency: Env['CONCURRENCY']
  ) {}

  async generateMetrics(): Promise<string> {
    const now = Date.now()
    const [totals, models] = await Promise.all([
      this.metrics.getTotals({
        startTime: new Date(now - 60_000),
        endTime: new Date(now),
      }),
      this.db
        .prepare('SELECT model, config FROM models ORDER BY model')
        .all<{ model: string; config: string }>(),
    ])
    const statsMap = new Map<string, Map<string, MetricsTotals | undefined>>()
    for (const row of totals) {
      let backends = statsMap.get(row.model)
      if (!backends) statsMap.set(row.model, (backends = new Map()))
      backends.set(row.backend_id, row)
    }
    const limitedBackendIds = new Set<string>()
    for (const row of models.results) {
      const model = JSON.parse(row.config) as ModelConfig
      for (const backend of model.backends) {
        if (backend.enabled) {
          let backends = statsMap.get(row.model)
          if (!backends) statsMap.set(row.model, (backends = new Map()))
          if (!backends.has(backend.id)) backends.set(backend.id, undefined)
        }
        if (backend.enabled && (backend.maxConcurrentRequests ?? 0) > 0) {
          limitedBackendIds.add(backend.id)
        }
      }
    }
    const backends = [...statsMap].flatMap(([model, stats]) =>
      [...stats].map(([backendId, totals]) => ({ model, backendId, stats: totals }))
    )
    const limiter = new ConcurrencyLimiter(this.concurrency)
    const activeCounts = new Map(
      await Promise.all(
        Array.from(
          limitedBackendIds,
          async (backendId) => [backendId, await limiter.getCount(backendId)] as const
        )
      )
    )

    const lines: string[] = [
      '# HELP llm_proxy_requests_total Total number of requests per backend',
      '# TYPE llm_proxy_requests_total counter',
    ]
    for (const { model, backendId, stats } of backends) {
      lines.push(
        `llm_proxy_requests_total{model="${label(model)}",backend_id="${label(backendId)}",status="success"} ${stats?.success ?? 0}`,
        `llm_proxy_requests_total{model="${label(model)}",backend_id="${label(backendId)}",status="failure"} ${stats?.failure ?? 0}`
      )
    }

    lines.push(
      '',
      '# HELP llm_proxy_request_duration_seconds Request duration in seconds',
      '# TYPE llm_proxy_request_duration_seconds histogram'
    )
    for (const { model, backendId, stats } of backends) {
      lines.push(
        `llm_proxy_request_duration_seconds_count{model="${label(model)}",backend_id="${label(backendId)}"} ${stats?.total ?? 0}`
      )
    }

    lines.push(
      '',
      '# HELP llm_proxy_ttft_seconds Time to first token in seconds',
      '# TYPE llm_proxy_ttft_seconds histogram'
    )
    for (const { model, backendId, stats } of backends) {
      this.addTTFT(lines, model, backendId, 'streaming', stats)
      this.addTTFT(lines, model, backendId, 'non-streaming', stats)
    }

    lines.push(
      '',
      '# HELP llm_proxy_success_rate Success rate per backend (0.0 to 1.0)',
      '# TYPE llm_proxy_success_rate gauge'
    )
    for (const { model, backendId, stats } of backends) {
      const successRate = stats && stats.total > 0 ? stats.success / stats.total : 1
      lines.push(
        `llm_proxy_success_rate{model="${label(model)}",backend_id="${label(backendId)}"} ${successRate.toFixed(4)}`
      )
    }

    lines.push(
      '',
      '# HELP llm_proxy_active_requests Currently active requests per backend',
      '# TYPE llm_proxy_active_requests gauge'
    )
    for (const backendId of limitedBackendIds) {
      lines.push(
        `llm_proxy_active_requests{backend_id="${label(backendId)}"} ${activeCounts.get(backendId) ?? 0}`
      )
    }
    lines.push('')
    return lines.join('\n')
  }

  private addTTFT(
    lines: string[],
    model: string,
    backendId: string,
    streamType: 'streaming' | 'non-streaming',
    stats?: MetricsTotals
  ): void {
    const sum =
      streamType === 'streaming' ? stats?.streaming_ttft_sum : stats?.non_streaming_ttft_sum
    const count =
      streamType === 'streaming' ? stats?.streaming_ttft_count : stats?.non_streaming_ttft_count
    const labels = `model="${label(model)}",backend_id="${label(backendId)}",stream_type="${streamType}"`
    lines.push(
      `llm_proxy_ttft_seconds_sum{${labels}} ${((sum ?? 0) / 1000).toFixed(3)}`,
      `llm_proxy_ttft_seconds_count{${labels}} ${count ?? 0}`
    )
  }
}
