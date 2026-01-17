import type { Db, Collection } from 'mongodb'
import type { ActiveRequestStore, ActiveRequest } from './interface.js'

/**
 * MongoDB document for a single active request
 */
interface ActiveRequestDocument {
  requestId: string
  backendId: string
  instanceId: string
  startTime: Date
  createdAt: Date
}

/**
 * MongoDB document for a backend's active requests
 */
interface BackendRequestsDocument {
  _id: string // backendId
  requests: ActiveRequestDocument[]
}

/**
 * MongoDB-based active request store
 * Uses a single document per backend with an array of requests for atomic check-and-insert
 * without requiring transactions.
 */
export class MongoActiveRequestStore implements ActiveRequestStore {
  private collection: Collection<any>
  private instanceId: string
  private ttl: number = 600 // 10 minutes in seconds
  private cleanupInterval: NodeJS.Timeout | null = null

  constructor(private db: Db, instanceId: string) {
    this.collection = db.collection('active_requests')
    this.instanceId = instanceId
  }

  async initialize(): Promise<void> {
    // Create indexes
    try {
      // Global unique index on requestId within the requests array
      await this.collection.createIndex({ 'requests.requestId': 1 }, { unique: true, sparse: true })
      // Index for finding/cleaning up by instanceId
      await this.collection.createIndex({ 'requests.instanceId': 1 })

      // Start background TTL cleanup (every minute)
      // This compensates for MongoDB not supporting TTL indexes on individual array items
      this.cleanupInterval = setInterval(() => {
        const tenMinutesAgo = new Date(Date.now() - this.ttl * 1000)
        this.collection.updateMany(
          {},
          { $pull: { requests: { createdAt: { $lt: tenMinutesAgo } } } } as any
        ).catch(err => console.error('Failed background mongo TTL cleanup:', err))
      }, 60000)

      // Allow the process to exit even if this interval is running
      if (this.cleanupInterval.unref) {
        this.cleanupInterval.unref()
      }

      console.log('✓ MongoActiveRequestStore initialized with indexes and background cleanup')
    } catch (error: any) {
      // Indexes might already exist
      if (error.code === 85 || error.code === 86 || error.codeName === 'IndexOptionsConflict' || error.codeName === 'IndexKeySpecsConflict') {
        console.log('✓ MongoActiveRequestStore initialized (indexes already exist)')
      } else {
        console.warn('Warning: Failed to create some indexes for active_requests collection:', error.message)
        console.log('✓ MongoActiveRequestStore initialized (with index warnings)')
      }
    }
  }

  async tryRecordStart(backendId: string, requestId: string, maxLimit: number | undefined): Promise<boolean> {
    // No limit configured (undefined or 0) - always allow
    if (maxLimit === undefined || maxLimit === 0) {
      await this.recordStart(backendId, requestId)
      return true
    }

    const now = new Date()
    const doc: ActiveRequestDocument = {
      requestId,
      backendId,
      instanceId: this.instanceId,
      startTime: now,
      createdAt: now
    }

    try {
      // Use findOneAndUpdate with an aggregation pipeline for atomic cleanup + check + push.
      // 1. Filter out expired requests (older than 10 minutes).
      // 2. Check if the remaining requests are below maxLimit.
      // 3. If yes, add the new request.
      // 4. If no, just keep the filtered list (perform cleanup anyway).
      const tenMinutesAgo = new Date(Date.now() - this.ttl * 1000)
      const result = await this.collection.findOneAndUpdate(
        { _id: backendId as any },
        [
          {
            $set: {
              requests: {
                $let: {
                  vars: {
                    filtered: {
                      $filter: {
                        input: { $ifNull: ['$requests', []] },
                        as: 'r',
                        cond: { $gt: ['$$r.createdAt', tenMinutesAgo] }
                      }
                    }
                  },
                  in: {
                    $cond: {
                      if: { $lt: [{ $size: '$$filtered' }, maxLimit] },
                      then: { $concatArrays: ['$$filtered', [doc]] },
                      else: '$$filtered'
                    }
                  }
                }
              }
            }
          }
        ],
        {
          upsert: true,
          returnDocument: 'after'
        }
      )

      const updatedDoc = (result as any)?.value || result
      const wasAdded = updatedDoc?.requests?.some((r: any) => r.requestId === requestId)

      if (!wasAdded) {
        console.log(`Capacity limit reached for backend ${backendId} (${maxLimit})`)
      }

      return !!wasAdded
    } catch (error: any) {
      console.error(`Failed to tryRecordStart for ${backendId}:`, error.message)
      // Fail-open: if database is erroring, allow request through to avoid cascading failure
      return true
    }
  }

  async recordStart(backendId: string, requestId: string): Promise<void> {
    const now = new Date()
    const doc: ActiveRequestDocument = {
      requestId,
      backendId,
      instanceId: this.instanceId,
      startTime: now,
      createdAt: now
    }

    try {
      await this.collection.updateOne(
        { _id: backendId as any },
        {
          $push: { requests: doc } as any
        },
        { upsert: true }
      )
    } catch (error: any) {
      if (error.code === 11000) {
        console.warn(`Request ${requestId} already being tracked`)
      } else {
        console.error(`Failed to record active request start for ${backendId}:`, error.message)
      }
    }
  }

  async recordComplete(backendId: string, requestId: string): Promise<void> {
    try {
      await this.collection.updateOne(
        { _id: backendId as any },
        { $pull: { requests: { requestId } } } as any
      )
    } catch (error: any) {
      console.error(`Failed to delete active request ${requestId} for backend ${backendId}:`, error.message)
    }
  }

  async getCount(backendId: string): Promise<number> {
    const doc = await this.collection.findOne({ _id: backendId as any })
    return doc?.requests?.length || 0
  }

  async getAllCounts(): Promise<Record<string, number>> {
    try {
      // Use aggregation to compute array sizes on the database side
      const results = await this.collection.aggregate([
        {
          $project: {
            _id: 1,
            count: { $size: { $ifNull: ['$requests', []] } }
          }
        }
      ]).toArray()

      const counts: Record<string, number> = {}
      for (const res of results) {
        counts[res._id as string] = res.count
      }

      return counts
    } catch (error: any) {
      console.error('Failed to get all active request counts from MongoDB:', error.message)
      return {}
    }
  }

  async cleanup(instanceId: string): Promise<number> {
    // Remove all requests from this instance across all backends
    const result = await this.collection.updateMany(
      {},
      { $pull: { requests: { instanceId } } } as any
    )
    return result.modifiedCount
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    const deletedCount = await this.cleanup(this.instanceId)
    console.log(`MongoActiveRequestStore shutdown (cleaned up ${deletedCount} backends)`)
  }
}
