import type { RedisClientType } from 'redis'
import type { ActiveRequestStore } from './interface.js'

/**
 * Redis-based active request store (optimized version)
 *
 * Data structure:
 *   - active_requests:{backendId} -> ZSet[requestId1: timestamp1, requestId2: timestamp2, ...]
 *   - instance_requests:{instanceId} -> Set["backendId:requestId", ...] (for cleanup)
 *
 * Benefits:
 *   - Extremely high throughput: Single ZSet per backend for counting.
 *   - Automatic cleanup of stale requests via ZREMRANGEBYSCORE.
 *   - Correctness: Idempotent operations, handles instance crashes via score-based aging.
 *   - Safe Shutdown: Tracks requests per instance for clean exit.
 */
export class RedisActiveRequestStore implements ActiveRequestStore {
  private instanceId: string
  private ttl: number = 600 // 10 minutes in seconds

  constructor(private redis: RedisClientType, instanceId: string) {
    this.instanceId = instanceId
  }

  async initialize(): Promise<void> {
    // No initialization needed for Redis
    console.log('✓ RedisActiveRequestStore initialized')
  }

  async tryRecordStart(backendId: string, requestId: string, maxLimit: number | undefined): Promise<boolean> {
    // No limit configured (undefined or 0) - always allow
    if (maxLimit === undefined || maxLimit === 0) {
      await this.recordStart(backendId, requestId)
      return true
    }

    const setKey = `active_requests:${backendId}`
    const instanceKey = `instance_requests:${this.instanceId}`
    const now = Date.now()
    const expiryTime = now - (this.ttl * 1000)

    // Lua script for atomic check-and-add
    // Strategy:
    // 1. Remove expired entries from the ZSet
    // 2. Check if the requestId is already present or if the count is under limit
    // 3. Add the requestId with current timestamp
    // 4. Track request in instance set for cleanup
    const luaScript = `
      local setKey = KEYS[1]
      local instanceKey = KEYS[2]
      local requestId = ARGV[1]
      local maxLimit = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      local expiryTime = tonumber(ARGV[4])
      local ttl = tonumber(ARGV[5])
      local backendId = ARGV[6]

      -- Cleanup stale entries
      redis.call('ZREMRANGEBYSCORE', setKey, '-inf', expiryTime)

      -- Check if already exists (idempotency)
      if redis.call('ZSCORE', setKey, requestId) then
        return 1
      end

      -- Check limit
      local currentCount = redis.call('ZCARD', setKey)
      if currentCount >= maxLimit then
        return 0
      end

      -- Add and set TTL
      redis.call('ZADD', setKey, now, requestId)
      redis.call('EXPIRE', setKey, ttl)

      -- Track by instance for cleanup
      redis.call('SADD', instanceKey, backendId .. ':' .. requestId)
      redis.call('EXPIRE', instanceKey, ttl)

      return 1
    `

    try {
      const result = await this.redis.eval(luaScript, {
        keys: [setKey, instanceKey],
        arguments: [
          requestId,
          maxLimit.toString(),
          now.toString(),
          expiryTime.toString(),
          this.ttl.toString(),
          backendId
        ]
      })

      return result === 1
    } catch (error: any) {
      console.error(`Failed to tryRecordStart for ${backendId}:`, error.message)
      // Fail open
      return true
    }
  }

  async recordStart(backendId: string, requestId: string): Promise<void> {
    const setKey = `active_requests:${backendId}`
    const instanceKey = `instance_requests:${this.instanceId}`
    const now = Date.now()

    try {
      const multi = this.redis.multi()
      multi.zAdd(setKey, { score: now, value: requestId })
      multi.expire(setKey, this.ttl)
      multi.sAdd(instanceKey, `${backendId}:${requestId}`)
      multi.expire(instanceKey, this.ttl)
      await multi.exec()
    } catch (error: any) {
      console.error(`Failed to recordStart for ${backendId}:`, error.message)
    }
  }

  async recordComplete(backendId: string, requestId: string): Promise<void> {
    const setKey = `active_requests:${backendId}`
    const instanceKey = `instance_requests:${this.instanceId}`

    try {
      const multi = this.redis.multi()
      multi.zRem(setKey, requestId)
      multi.sRem(instanceKey, `${backendId}:${requestId}`)
      await multi.exec()
    } catch (error: any) {
      console.error(`Failed to recordComplete for requestId ${requestId} on backend ${backendId}:`, error.message)
    }
  }

  async getCount(backendId: string): Promise<number> {
    const setKey = `active_requests:${backendId}`
    const now = Date.now()
    const expiryTime = now - (this.ttl * 1000)

    try {
      // Periodic cleanup during getCount helps keep the set clean
      await this.redis.zRemRangeByScore(setKey, '-inf', expiryTime)
      return await this.redis.zCard(setKey)
    } catch (error: any) {
      console.error(`Failed to getCount for ${backendId}:`, error.message)
      return 0
    }
  }

  async getAllCounts(): Promise<Record<string, number>> {
    try {
      const keys = await this.redis.keys('active_requests:*')
      const counts: Record<string, number> = {}

      if (keys.length === 0) {
        return counts
      }

      // Use a pipeline to get counts for all keys efficiently
      const multi = this.redis.multi()
      for (const key of keys) {
        multi.zCard(key)
      }

      const results = await multi.exec()

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]
        const backendId = key.split(':')[1]
        counts[backendId] = results[i] as number
      }

      return counts
    } catch (error: any) {
      console.error('Failed to get all active request counts from Redis:', error.message)
      return {}
    }
  }

  async cleanup(instanceId: string): Promise<number> {
    const instanceKey = `instance_requests:${instanceId}`

    try {
      const members = await this.redis.sMembers(instanceKey)
      if (!members || members.length === 0) {
        return 0
      }

      const multi = this.redis.multi()
      for (const member of members) {
        const lastColonIndex = member.lastIndexOf(':')
        if (lastColonIndex === -1) continue

        const backendId = member.substring(0, lastColonIndex)
        const requestId = member.substring(lastColonIndex + 1)

        multi.zRem(`active_requests:${backendId}`, requestId)
      }

      multi.del(instanceKey)
      await multi.exec()
      return members.length
    } catch (error: any) {
      console.error(`Failed to cleanup Redis active requests for instance ${instanceId}:`, error.message)
      return 0
    }
  }

  async shutdown(): Promise<void> {
    const deletedCount = await this.cleanup(this.instanceId)
    console.log(`RedisActiveRequestStore shutdown (cleaned up ${deletedCount} requests)`)
  }
}
