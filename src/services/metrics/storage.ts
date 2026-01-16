import type { Collection, Db } from 'mongodb'
import type { BackendStats, StatsDataPoint } from '../../types/backend.js'
import type { MetricsDataPoint, TimeWindow, HistoryQueryParams } from './types.js'

/**
 * Storage layer for metrics data in MongoDB
 * Handles raw per-request metrics and aggregated queries
 */
export class MetricsStorage {
  private collection: Collection<MetricsDataPoint>

  constructor(private db: Db) {
    this.collection = db.collection<MetricsDataPoint>('request_metrics')
  }

  /**
   * Initialize collection as Time Series Collection with indexes
   * Called once during startup
   *
   * Note: Time Series Collections in MongoDB are optimized for time-series data.
   * To create the collection manually before first run:
   *
   * db.createCollection('request_metrics', {
   *   timeseries: {
   *     timeField: 'timestamp',
   *     metaField: 'backendId',
   *     granularity: 'seconds'
   *   }
   * })
   *
   * To add a TTL index for automatic data expiration (optional):
   * db.request_metrics.createIndex({ timestamp: 1 }, { expireAfterSeconds: 604800 })  // 7 days
   */
  async initialize(): Promise<void> {
    // Check if collection exists
    const collections = await this.db.listCollections({ name: 'request_metrics' }).toArray()

    if (collections.length === 0) {
      // Create Time Series Collection
      await this.db.createCollection('request_metrics', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'backendId',
          granularity: 'seconds'
        }
      })
      console.log('Created Time Series Collection: request_metrics')
    } else {
      console.log('Time Series Collection already exists: request_metrics')
    }

    // Compound index for backend + time queries (primary use case)
    await this.collection.createIndex({ backendId: 1, timestamp: -1 })

    // Index for instance + time queries
    await this.collection.createIndex({ instanceId: 1, timestamp: -1 })

    // Index for request ID lookups (for deduplication if needed)
    await this.collection.createIndex({ requestId: 1 })

    // Note: TTL index is NOT created automatically
    // Users should create it manually if they want automatic data expiration:
    // db.request_metrics.createIndex({ timestamp: 1 }, { expireAfterSeconds: 604800 })

    console.log('Metrics Time Series Collection initialized')
  }

  /**
   * Insert a single metrics data point (fire-and-forget)
   */
  async insertMetric(metric: MetricsDataPoint): Promise<void> {
    try {
      await this.collection.insertOne(metric)
    } catch (error) {
      // Log error but don't throw - metrics failures shouldn't break requests
      console.error('Failed to insert metric:', error)
    }
  }

  /**
   * Get aggregated stats for a specific backend within a time window
   */
  async getStats(backendId: string, timeWindow: TimeWindow): Promise<BackendStats> {
    const pipeline = [
      {
        $match: {
          backendId,
          timestamp: {
            $gte: timeWindow.startTime,
            $lte: timeWindow.endTime
          }
        }
      },
      {
        $group: {
          _id: '$backendId',
          totalRequests: { $sum: 1 },
          successfulRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
          },
          failedRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'failure'] }, 1, 0] }
          },
          ttftSamples: {
            $push: {
              $cond: [
                { $and: [{ $ne: ['$ttft', null] }, { $ne: ['$ttft', undefined] }] },
                { ttft: '$ttft', streamType: '$streamType' },
                '$$REMOVE'
              ]
            }
          }
        }
      }
    ]

    const results = await this.collection.aggregate(pipeline).toArray()

    if (results.length === 0) {
      return this.getEmptyStats(backendId)
    }

    const result = results[0] as any

    // Calculate average TTFT separately for streaming and non-streaming
    const streamingTTFTs = result.ttftSamples
      .filter((s: any) => s.streamType === 'streaming')
      .map((s: any) => s.ttft)
    const nonStreamingTTFTs = result.ttftSamples
      .filter((s: any) => s.streamType === 'non-streaming')
      .map((s: any) => s.ttft)

    const avgStreamingTTFT = streamingTTFTs.length > 0
      ? streamingTTFTs.reduce((a: number, b: number) => a + b, 0) / streamingTTFTs.length
      : 0

    const avgNonStreamingTTFT = nonStreamingTTFTs.length > 0
      ? nonStreamingTTFTs.reduce((a: number, b: number) => a + b, 0) / nonStreamingTTFTs.length
      : 0

    return {
      backendId,
      totalRequests: result.totalRequests,
      successfulRequests: result.successfulRequests,
      failedRequests: result.failedRequests,
      successRate: result.totalRequests > 0
        ? result.successfulRequests / result.totalRequests
        : 0,
      averageStreamingTTFT: avgStreamingTTFT,
      averageNonStreamingTTFT: avgNonStreamingTTFT,
      ttftSamples: result.ttftSamples.map((s: any) => s.ttft).filter((t: number) => t !== undefined)
    }
  }

  /**
   * Get stats for all backends within a time window
   */
  async getAllStats(timeWindow: TimeWindow): Promise<Map<string, BackendStats>> {
    const pipeline = [
      {
        $match: {
          timestamp: {
            $gte: timeWindow.startTime,
            $lte: timeWindow.endTime
          }
        }
      },
      {
        $group: {
          _id: '$backendId',
          totalRequests: { $sum: 1 },
          successfulRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
          },
          failedRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'failure'] }, 1, 0] }
          },
          ttftSamples: {
            $push: {
              $cond: [
                { $and: [{ $ne: ['$ttft', null] }, { $ne: ['$ttft', undefined] }] },
                { ttft: '$ttft', streamType: '$streamType' },
                '$$REMOVE'
              ]
            }
          }
        }
      }
    ]

    const results = await this.collection.aggregate(pipeline).toArray()
    const statsMap = new Map<string, BackendStats>()

    for (const result of results) {
      const backendId = result._id as string

      // Calculate average TTFT separately for streaming and non-streaming
      const streamingTTFTs = result.ttftSamples
        .filter((s: any) => s.streamType === 'streaming')
        .map((s: any) => s.ttft)
      const nonStreamingTTFTs = result.ttftSamples
        .filter((s: any) => s.streamType === 'non-streaming')
        .map((s: any) => s.ttft)

      const avgStreamingTTFT = streamingTTFTs.length > 0
        ? streamingTTFTs.reduce((a: number, b: number) => a + b, 0) / streamingTTFTs.length
        : 0

      const avgNonStreamingTTFT = nonStreamingTTFTs.length > 0
        ? nonStreamingTTFTs.reduce((a: number, b: number) => a + b, 0) / nonStreamingTTFTs.length
        : 0

      statsMap.set(backendId, {
        backendId,
        totalRequests: result.totalRequests,
        successfulRequests: result.successfulRequests,
        failedRequests: result.failedRequests,
        successRate: result.totalRequests > 0
          ? result.successfulRequests / result.totalRequests
          : 0,
        averageStreamingTTFT: avgStreamingTTFT,
        averageNonStreamingTTFT: avgNonStreamingTTFT,
        ttftSamples: result.ttftSamples.map((s: any) => s.ttft).filter((t: number) => t !== undefined)
      })
    }

    return statsMap
  }

  /**
   * Delete stats for a specific backend or all backends
   * Returns the number of deleted documents
   */
  async deleteStats(backendId?: string): Promise<number> {
    const filter = backendId ? { backendId } : {}
    const result = await this.collection.deleteMany(filter)
    return result.deletedCount
  }

  /**
   * Get historical stats data points (raw time-series data)
   * Aggregates per-request data into time buckets
   */
  async getHistoricalStats(params: HistoryQueryParams): Promise<StatsDataPoint[]> {
    const match: any = {
      timestamp: {
        $gte: params.startTime,
        $lte: params.endTime
      }
    }

    if (params.backendId) {
      match.backendId = params.backendId
    }

    if (params.instanceId) {
      match.instanceId = params.instanceId
    }

    // Aggregate into 5-minute buckets
    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: {
            backendId: '$backendId',
            instanceId: '$instanceId',
            timeBucket: {
              $dateTrunc: {
                date: '$timestamp',
                unit: 'minute',
                binSize: 5
              }
            }
          },
          totalRequests: { $sum: 1 },
          successfulRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
          },
          failedRequests: {
            $sum: { $cond: [{ $eq: ['$status', 'failure'] }, 1, 0] }
          },
          streamingTTFTs: {
            $push: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$streamType', 'streaming'] },
                    { $ne: ['$ttft', null] }
                  ]
                },
                '$ttft',
                '$$REMOVE'
              ]
            }
          },
          nonStreamingTTFTs: {
            $push: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$streamType', 'non-streaming'] },
                    { $ne: ['$ttft', null] }
                  ]
                },
                '$ttft',
                '$$REMOVE'
              ]
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          backendId: '$_id.backendId',
          instanceId: '$_id.instanceId',
          timestamp: '$_id.timeBucket',
          totalRequests: 1,
          successfulRequests: 1,
          failedRequests: 1,
          successRate: {
            $cond: [
              { $gt: ['$totalRequests', 0] },
              { $divide: ['$successfulRequests', '$totalRequests'] },
              0
            ]
          },
          averageStreamingTTFT: {
            $cond: [
              { $gt: [{ $size: '$streamingTTFTs' }, 0] },
              { $avg: '$streamingTTFTs' },
              0
            ]
          },
          averageNonStreamingTTFT: {
            $cond: [
              { $gt: [{ $size: '$nonStreamingTTFTs' }, 0] },
              { $avg: '$nonStreamingTTFTs' },
              0
            ]
          },
          requestsInPeriod: '$totalRequests'
        }
      },
      { $sort: { timestamp: -1 } }
    ]

    if (params.limit) {
      pipeline.push({ $limit: params.limit } as any)
    }

    const results = await this.collection.aggregate(pipeline).toArray()
    return results as unknown as StatsDataPoint[]
  }

  /**
   * Get count of active requests (requests in the last minute without completion)
   * Used for active requests gauge
   */
  async getActiveRequestsCount(backendId: string): Promise<number> {
    const oneMinuteAgo = new Date(Date.now() - 60000)
    return this.collection.countDocuments({
      backendId,
      timestamp: { $gte: oneMinuteAgo }
    })
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
