import { PrometheusExporter } from './prometheus-exporter.js'

import type {
  BackendIdentity,
  HistoryQueryParams,
  MetricsTotals,
  RequestCompleteData,
  TimeWindow,
} from './types.js'
import type { BackendStats, StatsDataPoint } from '../../types/backend.js'

type BackendStatsMap = Map<string, Map<string, BackendStats>>

interface RecentStatsCache {
  expiresAt: number
  stats: BackendStatsMap
}

// Share completed data only; never retain request-scoped I/O or Promises.
const recentStatsCaches = new WeakMap<D1Database, Map<number, RecentStatsCache>>()

const TOTAL_COLUMNS = `model, backend_id, SUM(total) AS total, SUM(success) AS success,
  SUM(failure) AS failure, SUM(streaming_ttft_sum) AS streaming_ttft_sum,
  SUM(streaming_ttft_count) AS streaming_ttft_count,
  SUM(non_streaming_ttft_sum) AS non_streaming_ttft_sum,
  SUM(non_streaming_ttft_count) AS non_streaming_ttft_count`

export function emptyStats(model: string, backendId: string): BackendStats {
  return {
    model,
    backendId,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    successRate: 0,
    averageStreamingTTFT: 0,
    averageNonStreamingTTFT: 0,
    ttftSamples: [],
  }
}

function toStats(row: MetricsTotals): BackendStats {
  return {
    model: row.model,
    backendId: row.backend_id,
    totalRequests: row.total,
    successfulRequests: row.success,
    failedRequests: row.failure,
    successRate: row.total > 0 ? row.success / row.total : 0,
    averageStreamingTTFT:
      row.streaming_ttft_count > 0 ? row.streaming_ttft_sum / row.streaming_ttft_count : 0,
    averageNonStreamingTTFT:
      row.non_streaming_ttft_count > 0
        ? row.non_streaming_ttft_sum / row.non_streaming_ttft_count
        : 0,
    ttftSamples: [],
  }
}

/** D1 minute buckets are the source of both aggregate and historical metrics. */
export class DbMetricsCollector {
  constructor(
    private readonly db: D1Database,
    private readonly concurrency?: Env['CONCURRENCY']
  ) {}

  completionStatement(data: RequestCompleteData, now = Date.now()): D1PreparedStatement {
    const hasTTFT = data.ttft !== undefined && Number.isFinite(data.ttft)
    const streaming = hasTTFT && data.streamType === 'streaming'
    const nonStreaming = hasTTFT && data.streamType === 'non-streaming'
    return this.db
      .prepare(
        `INSERT INTO backend_stats_minute
          (model, backend_id, minute, total, success, failure, streaming_ttft_sum,
           streaming_ttft_count, non_streaming_ttft_sum, non_streaming_ttft_count)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (model, backend_id, minute) DO UPDATE SET
           total = total + 1,
           success = success + excluded.success,
           failure = failure + excluded.failure,
           streaming_ttft_sum = streaming_ttft_sum + excluded.streaming_ttft_sum,
           streaming_ttft_count = streaming_ttft_count + excluded.streaming_ttft_count,
           non_streaming_ttft_sum = non_streaming_ttft_sum + excluded.non_streaming_ttft_sum,
           non_streaming_ttft_count = non_streaming_ttft_count + excluded.non_streaming_ttft_count`
      )
      .bind(
        data.model,
        data.backendId,
        Math.floor(now / 60_000) * 60_000,
        data.status === 'success' ? 1 : 0,
        data.status === 'failure' ? 1 : 0,
        streaming ? data.ttft! : 0,
        streaming ? 1 : 0,
        nonStreaming ? data.ttft! : 0,
        nonStreaming ? 1 : 0
      )
  }

  async getTotals(timeWindow: TimeWindow, backend?: BackendIdentity): Promise<MetricsTotals[]> {
    const query = this.db.prepare(
      `SELECT ${TOTAL_COLUMNS} FROM backend_stats_minute
       WHERE minute > ? AND minute <= ? ${backend ? 'AND model = ? AND backend_id = ?' : ''}
       GROUP BY model, backend_id ORDER BY model, backend_id`
    )
    const params: (number | string)[] = [
      timeWindow.startTime.getTime() - 60_000,
      timeWindow.endTime.getTime(),
    ]
    if (backend) params.push(backend.model, backend.backendId)
    return (await query.bind(...params).all<MetricsTotals>()).results
  }

  async getStats(model: string, backendId: string, timeWindow: TimeWindow): Promise<BackendStats> {
    const rows = await this.getTotals(timeWindow, { model, backendId })
    return rows.length > 0 ? toStats(rows[0]) : emptyStats(model, backendId)
  }

  async getRecentStats(model: string, backendId: string, windowMs: number): Promise<BackendStats> {
    const now = Date.now()
    return this.getStats(model, backendId, {
      startTime: new Date(now - windowMs),
      endTime: new Date(now),
    })
  }

  async getRecentStatsMap(windowMs: number): Promise<BackendStatsMap> {
    const now = Date.now()
    let caches = recentStatsCaches.get(this.db)
    if (!caches) {
      caches = new Map()
      recentStatsCaches.set(this.db, caches)
    }
    const cached = caches.get(windowMs)
    if (cached && cached.expiresAt > now) return cached.stats

    const stats = await this.getAllStats({
      startTime: new Date(now - windowMs),
      endTime: new Date(now),
    })
    caches.set(windowMs, { expiresAt: now + 15_000, stats })
    return stats
  }

  async getAllStats(timeWindow: TimeWindow): Promise<BackendStatsMap> {
    const rows = await this.getTotals(timeWindow)
    const stats: BackendStatsMap = new Map()
    for (const row of rows) {
      let backends = stats.get(row.model)
      if (!backends) stats.set(row.model, (backends = new Map()))
      backends.set(row.backend_id, toStats(row))
    }
    return stats
  }

  async resetStats(backend?: BackendIdentity): Promise<number> {
    const statement =
      backend === undefined
        ? this.db.prepare('DELETE FROM backend_stats_minute')
        : this.db
            .prepare('DELETE FROM backend_stats_minute WHERE model = ? AND backend_id = ?')
            .bind(backend.model, backend.backendId)
    const count = (await statement.run()).meta.changes
    recentStatsCaches.delete(this.db)
    return count
  }

  async getHistoricalStats(params: HistoryQueryParams): Promise<StatsDataPoint[]> {
    const intervalMs = (params.intervalMinutes ?? 1) * 60_000
    const values: (number | string)[] = [
      intervalMs,
      Math.floor(params.startTime.getTime() / intervalMs) * intervalMs,
      Math.floor(params.endTime.getTime() / intervalMs) * intervalMs + intervalMs,
    ]
    if (params.backend) values.push(params.backend.model, params.backend.backendId)
    if (params.limit !== undefined) values.push(params.limit)
    const { results } = await this.db
      .prepare(
        `SELECT ${TOTAL_COLUMNS}, minute - (minute % ?) AS bucket
         FROM backend_stats_minute WHERE minute >= ? AND minute < ?
         ${params.backend ? 'AND model = ? AND backend_id = ?' : ''}
         GROUP BY model, backend_id, bucket
         ORDER BY bucket DESC, model, backend_id
         ${params.limit === undefined ? '' : 'LIMIT ?'}`
      )
      .bind(...values)
      .all<MetricsTotals & { bucket: number }>()
    return results.map((row) => {
      const stats = toStats(row)
      return {
        model: row.model,
        backendId: row.backend_id,
        timestamp: new Date(row.bucket),
        totalRequests: stats.totalRequests,
        successfulRequests: stats.successfulRequests,
        failedRequests: stats.failedRequests,
        successRate: stats.successRate,
        averageStreamingTTFT: stats.averageStreamingTTFT,
        averageNonStreamingTTFT: stats.averageNonStreamingTTFT,
        requestsInPeriod: row.total,
      }
    })
  }

  async getPrometheusMetrics(): Promise<string> {
    if (!this.concurrency) throw new Error('CONCURRENCY binding is required to export metrics')
    return new PrometheusExporter(this, this.db, this.concurrency).generateMetrics()
  }
}
