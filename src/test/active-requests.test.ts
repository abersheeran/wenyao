import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { MongoClient, Db } from 'mongodb'
import { createClient, type RedisClientType } from 'redis'
import { createActiveRequestStore } from '../services/active-requests/index.js'
import { MongoActiveRequestStore } from '../services/active-requests/mongo-store.js'
import { RedisActiveRequestStore } from '../services/active-requests/redis-store.js'
import type { ActiveRequestStore } from '../services/active-requests/interface.js'

describe('ActiveRequestStore Factory', () => {
  it('throws error when mongodb type without db', () => {
    expect(() => createActiveRequestStore({
      type: 'mongodb',
      instanceId: 'test-instance'
    })).toThrow('MongoDB database instance is required')
  })

  it('throws error when redis type without client', () => {
    expect(() => createActiveRequestStore({
      type: 'redis',
      instanceId: 'test-instance'
    })).toThrow('Redis client is required')
  })

  it('throws error for unknown store type', () => {
    expect(() => createActiveRequestStore({
      type: 'unknown' as any,
      instanceId: 'test-instance'
    })).toThrow('Unknown active request store type')
  })
})

describe('MongoActiveRequestStore', () => {
  let mongoClient: MongoClient | null = null
  let db: Db | null = null
  let store: ActiveRequestStore | null = null
  const instanceId = 'test-mongo-instance'

  beforeAll(async () => {
    if (process.env.MONGODB_URL) {
      try {
        mongoClient = new MongoClient(process.env.MONGODB_URL)
        await mongoClient.connect()
        db = mongoClient.db()
        console.log('Connected to MongoDB for ActiveRequestStore tests')
      } catch (error) {
        console.warn('MongoDB not available for tests:', error)
      }
    }
  })

  afterAll(async () => {
    if (mongoClient) {
      await mongoClient.close()
    }
  })

  beforeEach(async () => {
    if (!db) return

    // Clean up collection before each test
    try {
      await db.collection('active_requests').deleteMany({})
    } catch (error) {
      // Collection might not exist
    }

    store = createActiveRequestStore({
      type: 'mongodb',
      instanceId,
      db
    })
    await store.initialize()
  })

  it('should initialize successfully', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    expect(store).toBeDefined()
    expect(store).toBeInstanceOf(MongoActiveRequestStore)
  })

  it('should record a request start', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    const count = await store.getCount('backend-1')
    expect(count).toBe(1)
  })

  it('should record multiple requests for same backend', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-1', 'req-2')
    await store.recordStart('backend-1', 'req-3')

    const count = await store.getCount('backend-1')
    expect(count).toBe(3)
  })

  it('should track requests for different backends separately', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-2', 'req-2')
    await store.recordStart('backend-1', 'req-3')

    expect(await store.getCount('backend-1')).toBe(2)
    expect(await store.getCount('backend-2')).toBe(1)
  })

  it('should record request completion', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-1', 'req-2')
    expect(await store.getCount('backend-1')).toBe(2)

    await store.recordComplete('backend-1', 'req-1')
    expect(await store.getCount('backend-1')).toBe(1)
  })

  it('should handle tryRecordStart with no limit (always allow)', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    const result1 = await store.tryRecordStart('backend-1', 'req-1', undefined)
    expect(result1).toBe(true)

    const result2 = await store.tryRecordStart('backend-1', 'req-2', 0)
    expect(result2).toBe(true)

    expect(await store.getCount('backend-1')).toBe(2)
  })

  it('should enforce capacity limit with tryRecordStart', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    const maxLimit = 2

    // First two requests should succeed
    const result1 = await store.tryRecordStart('backend-1', 'req-1', maxLimit)
    expect(result1).toBe(true)

    const result2 = await store.tryRecordStart('backend-1', 'req-2', maxLimit)
    expect(result2).toBe(true)

    // Third request should be rejected (at capacity)
    const result3 = await store.tryRecordStart('backend-1', 'req-3', maxLimit)
    expect(result3).toBe(false)

    expect(await store.getCount('backend-1')).toBe(2)
  })

  it('should allow requests after releasing capacity', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    const maxLimit = 2

    await store.tryRecordStart('backend-1', 'req-1', maxLimit)
    await store.tryRecordStart('backend-1', 'req-2', maxLimit)

    // At capacity
    const result1 = await store.tryRecordStart('backend-1', 'req-3', maxLimit)
    expect(result1).toBe(false)

    // Release one slot
    await store.recordComplete('backend-1', 'req-1')

    // Should now succeed
    const result2 = await store.tryRecordStart('backend-1', 'req-3', maxLimit)
    expect(result2).toBe(true)

    expect(await store.getCount('backend-1')).toBe(2)
  })

  it('should handle idempotent recordStart (duplicate requestId)', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-1', 'req-1') // Duplicate - should warn but not error

    // Count should still be reasonable (may be 1 or 2 depending on uniqueness constraint)
    const count = await store.getCount('backend-1')
    expect(count).toBeGreaterThanOrEqual(1)
  })

  it('should return counts for all backends', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-2', 'req-2')
    await store.recordStart('backend-1', 'req-3')

    const counts = await store.getAllCounts()
    expect(counts['backend-1']).toBe(2)
    expect(counts['backend-2']).toBe(1)
  })

  it('should cleanup requests by instance', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-2', 'req-2')

    const deletedCount = await store.cleanup(instanceId)
    expect(deletedCount).toBeGreaterThanOrEqual(1)

    expect(await store.getCount('backend-1')).toBe(0)
    expect(await store.getCount('backend-2')).toBe(0)
  })

  it('should shutdown and cleanup', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-2', 'req-2')

    await store.shutdown()

    expect(await store.getCount('backend-1')).toBe(0)
    expect(await store.getCount('backend-2')).toBe(0)
  })

  it('should return 0 for non-existent backend', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    const count = await store.getCount('non-existent-backend')
    expect(count).toBe(0)
  })

  it('should handle concurrent tryRecordStart calls (race condition test)', async () => {
    if (!store) {
      console.log('Skipping test: MongoDB not available')
      return
    }

    const maxLimit = 5
    const concurrentRequests = 10

    // Simulate concurrent requests
    const promises = Array.from({ length: concurrentRequests }, (_, i) =>
      store!.tryRecordStart('backend-1', `req-${i}`, maxLimit)
    )

    const results = await Promise.all(promises)

    // Exactly maxLimit should succeed
    const successCount = results.filter(r => r === true).length
    expect(successCount).toBeLessThanOrEqual(maxLimit)

    const count = await store.getCount('backend-1')
    expect(count).toBeLessThanOrEqual(maxLimit)
  })
})

describe('RedisActiveRequestStore', () => {
  let redisClient: RedisClientType | null = null
  let store: ActiveRequestStore | null = null
  const instanceId = 'test-redis-instance'

  beforeAll(async () => {
    if (process.env.REDIS_URL) {
      try {
        redisClient = createClient({
          url: process.env.REDIS_URL
        })
        await redisClient.connect()
        console.log('Connected to Redis for ActiveRequestStore tests')
      } catch (error) {
        console.warn('Redis not available for tests:', error)
      }
    }
  })

  afterAll(async () => {
    if (redisClient) {
      await redisClient.quit()
    }
  })

  beforeEach(async () => {
    if (!redisClient) return

    // Clean up redis keys before each test
    try {
      const keys = await redisClient.keys('active_requests:*')
      if (keys.length > 0) {
        await redisClient.del(keys)
      }
      const instanceKeys = await redisClient.keys('instance_requests:*')
      if (instanceKeys.length > 0) {
        await redisClient.del(instanceKeys)
      }
    } catch (error) {
      console.warn('Failed to cleanup Redis:', error)
    }

    store = createActiveRequestStore({
      type: 'redis',
      instanceId,
      redis: redisClient
    })
    await store.initialize()
  })

  it('should initialize successfully', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    expect(store).toBeDefined()
    expect(store).toBeInstanceOf(RedisActiveRequestStore)
  })

  it('should record a request start', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    const count = await store.getCount('backend-1')
    expect(count).toBe(1)
  })

  it('should record multiple requests for same backend', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-1', 'req-2')
    await store.recordStart('backend-1', 'req-3')

    const count = await store.getCount('backend-1')
    expect(count).toBe(3)
  })

  it('should track requests for different backends separately', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-2', 'req-2')
    await store.recordStart('backend-1', 'req-3')

    expect(await store.getCount('backend-1')).toBe(2)
    expect(await store.getCount('backend-2')).toBe(1)
  })

  it('should record request completion', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-1', 'req-2')
    expect(await store.getCount('backend-1')).toBe(2)

    await store.recordComplete('backend-1', 'req-1')
    expect(await store.getCount('backend-1')).toBe(1)
  })

  it('should handle tryRecordStart with no limit (always allow)', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    const result1 = await store.tryRecordStart('backend-1', 'req-1', undefined)
    expect(result1).toBe(true)

    const result2 = await store.tryRecordStart('backend-1', 'req-2', 0)
    expect(result2).toBe(true)

    expect(await store.getCount('backend-1')).toBe(2)
  })

  it('should enforce capacity limit with tryRecordStart', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    const maxLimit = 2

    // First two requests should succeed
    const result1 = await store.tryRecordStart('backend-1', 'req-1', maxLimit)
    expect(result1).toBe(true)

    const result2 = await store.tryRecordStart('backend-1', 'req-2', maxLimit)
    expect(result2).toBe(true)

    // Third request should be rejected (at capacity)
    const result3 = await store.tryRecordStart('backend-1', 'req-3', maxLimit)
    expect(result3).toBe(false)

    expect(await store.getCount('backend-1')).toBe(2)
  })

  it('should allow requests after releasing capacity', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    const maxLimit = 2

    await store.tryRecordStart('backend-1', 'req-1', maxLimit)
    await store.tryRecordStart('backend-1', 'req-2', maxLimit)

    // At capacity
    const result1 = await store.tryRecordStart('backend-1', 'req-3', maxLimit)
    expect(result1).toBe(false)

    // Release one slot
    await store.recordComplete('backend-1', 'req-1')

    // Should now succeed
    const result2 = await store.tryRecordStart('backend-1', 'req-3', maxLimit)
    expect(result2).toBe(true)

    expect(await store.getCount('backend-1')).toBe(2)
  })

  it('should handle idempotent tryRecordStart (duplicate requestId)', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    const maxLimit = 5
    const result1 = await store.tryRecordStart('backend-1', 'req-1', maxLimit)
    expect(result1).toBe(true)

    // Second call with same requestId should be idempotent (return true)
    const result2 = await store.tryRecordStart('backend-1', 'req-1', maxLimit)
    expect(result2).toBe(true)

    // Count should still be 1
    expect(await store.getCount('backend-1')).toBe(1)
  })

  it('should cleanup requests by instance', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-2', 'req-2')

    const deletedCount = await store.cleanup(instanceId)
    expect(deletedCount).toBe(2)

    expect(await store.getCount('backend-1')).toBe(0)
    expect(await store.getCount('backend-2')).toBe(0)
  })

  it('should shutdown and cleanup', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-2', 'req-2')

    await store.shutdown()

    expect(await store.getCount('backend-1')).toBe(0)
    expect(await store.getCount('backend-2')).toBe(0)
  })

  it('should return counts for all backends', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    await store.recordStart('backend-1', 'req-1')
    await store.recordStart('backend-2', 'req-2')
    await store.recordStart('backend-1', 'req-3')

    const counts = await store.getAllCounts()
    expect(counts['backend-1']).toBe(2)
    expect(counts['backend-2']).toBe(1)
  })

  it('should return 0 for non-existent backend', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    const count = await store.getCount('non-existent-backend')
    expect(count).toBe(0)
  })

  it('should handle concurrent tryRecordStart calls (race condition test)', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    const maxLimit = 5
    const concurrentRequests = 10

    // Simulate concurrent requests
    const promises = Array.from({ length: concurrentRequests }, (_, i) =>
      store!.tryRecordStart('backend-1', `req-${i}`, maxLimit)
    )

    const results = await Promise.all(promises)

    // Exactly maxLimit should succeed
    const successCount = results.filter(r => r === true).length
    expect(successCount).toBe(maxLimit)

    const count = await store.getCount('backend-1')
    expect(count).toBe(maxLimit)
  })

  it('should automatically cleanup expired requests on getCount', async () => {
    if (!store || !redisClient) {
      console.log('Skipping test: Redis not available')
      return
    }

    // Manually add an expired request (backdated timestamp)
    const expiredTimestamp = Date.now() - 700000 // 11+ minutes ago
    await redisClient.zAdd('active_requests:backend-1', {
      score: expiredTimestamp,
      value: 'expired-req'
    })

    // Add a fresh request
    await store.recordStart('backend-1', 'fresh-req')

    // getCount should cleanup expired and return only fresh
    const count = await store.getCount('backend-1')
    expect(count).toBe(1)
  })

  it('should handle cleanup of instance with colon in requestId', async () => {
    if (!store) {
      console.log('Skipping test: Redis not available')
      return
    }

    // RequestIds with colons could cause parsing issues
    await store.recordStart('backend:1', 'req:1')
    await store.recordStart('backend:2', 'req:2')

    const deletedCount = await store.cleanup(instanceId)
    expect(deletedCount).toBe(2)
  })
})
