import { PrometheusExporter } from './prometheus-exporter.js'

import type { HistoryQueryParams, MetricsTotals, RequestCompleteData, TimeWindow } from './types.js'
import type { BackendStats, StatsDataPoint } from '../../types/backend.js'

interface RecentStatsCache {
  expiresAt: number
  stats: Map<string, BackendStats>
}

// Share completed data only; never retain request-scoped I/O or Promises.
const recentStatsCaches = new WeakMap<D1Database, Map<number, RecentStatsCache>>()

const TOTAL_COLUMNS = `backend_id, SUM(total) AS total, SUM(success) AS success,
  SUM(failure) AS failure, SUM(streaming_ttft_sum) AS streaming_ttft_sum,
  SUM(streaming_ttft_count) AS streaming_ttft_count,
  SUM(non_streaming_ttft_sum) AS non_streaming_ttft_sum,
  SUM(non_streaming_ttft_count) AS non_streaming_ttft_count`

export function emptyStats(backendId: string): BackendStats {
  return {
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
          (backend_id, minute, total, success, failure, streaming_ttft_sum,
           streaming_ttft_count, non_streaming_ttft_sum, non_streaming_ttft_count)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (backend_id, minute) DO UPDATE SET
           total = total + 1,
           success = success + excluded.success,
           failure = failure + excluded.failure,
           streaming_ttft_sum = streaming_ttft_sum + excluded.streaming_ttft_sum,
           streaming_ttft_count = streaming_ttft_count + excluded.streaming_ttft_count,
           non_streaming_ttft_sum = non_streaming_ttft_sum + excluded.non_streaming_ttft_sum,
           non_streaming_ttft_count = non_streaming_ttft_count + excluded.non_streaming_ttft_count`
      )
      .bind(
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

  async getTotals(timeWindow: TimeWindow, backendId?: string): Promise<MetricsTotals[]> {
    const query = this.db.prepare(
      `SELECT ${TOTAL_COLUMNS} FROM backend_stats_minute
       WHERE minute > ? AND minute <= ? ${backendId === undefined ? '' : 'AND backend_id = ?'}
       GROUP BY backend_id`
    )
    const params: (number | string)[] = [
      timeWindow.startTime.getTime() - 60_000,
      timeWindow.endTime.getTime(),
    ]
    if (backendId !== undefined) params.push(backendId)
    return (await query.bind(...params).all<MetricsTotals>()).results
  }

  async getStats(backendId: string, timeWindow: TimeWindow): Promise<BackendStats> {
    const rows = await this.getTotals(timeWindow, backendId)
    return rows.length > 0 ? toStats(rows[0]) : emptyStats(backendId)
  }

  async getRecentStats(backendId: string, windowMs: number): Promise<BackendStats> {
    const now = Date.now()
    return this.getStats(backendId, {
      startTime: new Date(now - windowMs),
      endTime: new Date(now),
    })
  }

  async getRecentStatsMap(windowMs: number): Promise<Map<string, BackendStats>> {
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

  async getAllStats(timeWindow: TimeWindow): Promise<Map<string, BackendStats>> {
    const rows = await this.getTotals(timeWindow)
    return new Map(rows.map((row) => [row.backend_id, toStats(row)]))
  }

  async resetStats(backendId?: string): Promise<number> {
    const statement =
      backendId === undefined
        ? this.db.prepare('DELETE FROM backend_stats_minute')
        : this.db.prepare('DELETE FROM backend_stats_minute WHERE backend_id = ?').bind(backendId)
    const count = (await statement.run()).meta.changes
    recentStatsCaches.delete(this.db)
    return count
  }

  async getHistoricalStats(params: HistoryQueryParams): Promise<StatsDataPoint[]> {
    const values: (number | string)[] = [
      params.startTime.getTime() - 60_000,
      params.endTime.getTime(),
    ]
    if (params.backendId !== undefined) values.push(params.backendId)
    if (params.limit !== undefined) values.push(params.limit)
    const { results } = await this.db
      .prepare(
        `SELECT * FROM backend_stats_minute WHERE minute > ? AND minute <= ?
         ${params.backendId === undefined ? '' : 'AND backend_id = ?'}
         ORDER BY minute DESC, backend_id
         ${params.limit === undefined ? '' : 'LIMIT ?'}`
      )
      .bind(...values)
      .all<MetricsTotals & { minute: number }>()
    return results.map((row) => {
      const stats = toStats(row)
      return {
        backendId: row.backend_id,
        timestamp: new Date(row.minute),
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
