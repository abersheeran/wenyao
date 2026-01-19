import { Db, MongoClient } from 'mongodb'
import { createClient, type RedisClientType } from 'redis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestOpenAIBackend } from './helpers.js'
import { createActiveRequestStore } from '../services/active-requests/index.js'
import { ConcurrencyLimiter } from '../services/concurrency-limiter.js'

import type { BackendConfig } from '../types/backend.js'

describe('ConcurrencyLimiter', () => {
  let limiter: ConcurrencyLimiter
  let mongoClient: MongoClient | null = null
  let redisClient: RedisClientType | null = null
  let db: Db | null = null

  // Test with both MongoDB and Redis
  const testWithStore = (storeName: 'mongodb' | 'redis') => {
    describe(`with ${storeName} store`, () => {
      beforeAll(async () => {
        if (storeName === 'mongodb' && process.env.MONGODB_URL) {
          try {
            mongoClient = new MongoClient(process.env.MONGODB_URL)
            await mongoClient.connect()
            db = mongoClient.db()
            console.log('Connected to MongoDB for ConcurrencyLimiter tests')
          } catch (error) {
            console.warn('MongoDB not available:', error)
          }
        } else if (storeName === 'redis' && process.env.REDIS_URL) {
          try {
            redisClient = createClient({ url: process.env.REDIS_URL })
            await redisClient.connect()
            console.log('Connected to Redis for ConcurrencyLimiter tests')
          } catch (error) {
            console.warn('Redis not available:', error)
          }
        }
      })

      afterAll(async () => {
        if (mongoClient) {
          await mongoClient.close()
          mongoClient = null
        }
        if (redisClient) {
          await redisClient.quit()
          redisClient = null
        }
      })

      beforeEach(async () => {
        limiter = new ConcurrencyLimiter()

        // Clean up data
        if (storeName === 'mongodb' && db) {
          try {
            await db.collection('active_requests').deleteMany({})
          } catch (error) {
            // Collection might not exist, ignore error
          }

          const store = createActiveRequestStore({
            type: 'mongodb',
            instanceId: 'test-instance',
            db,
          })
          await store.initialize()
          limiter.initialize(store)
        } else if (storeName === 'redis' && redisClient) {
          try {
            // Use FLUSHDB to clean all keys in the current database
            await redisClient.flushDb()
          } catch (error) {
            console.warn('Failed to cleanup Redis:', error)
          }

          const store = createActiveRequestStore({
            type: 'redis',
            instanceId: 'test-instance',
            redis: redisClient,
          })
          await store.initialize()
          limiter.initialize(store)
        }
      })

      it('should report enabled when initialized with store', () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        expect(limiter.isEnabled()).toBe(true)
      })

      it('should report disabled when not initialized', () => {
        const uninitializedLimiter = new ConcurrencyLimiter()
        expect(uninitializedLimiter.isEnabled()).toBe(false)
      })

      it('should always allow when not enabled', async () => {
        const uninitializedLimiter = new ConcurrencyLimiter()
        const backend = createTestOpenAIBackend({
          id: 'backend-1',
          maxConcurrentRequests: 1,
        })

        const result = await uninitializedLimiter.tryAcquire(backend, 'req-1')
        expect(result).toBe(true)
      })

      it('should allow requests without maxConcurrentRequests', async () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        const backend = createTestOpenAIBackend({
          id: 'backend-1',
          // No maxConcurrentRequests
        })

        const result1 = await limiter.tryAcquire(backend, 'req-1')
        expect(result1).toBe(true)

        const result2 = await limiter.tryAcquire(backend, 'req-2')
        expect(result2).toBe(true)

        const result3 = await limiter.tryAcquire(backend, 'req-3')
        expect(result3).toBe(true)
      })

      it('should enforce maxConcurrentRequests limit', async () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        const backend = createTestOpenAIBackend({
          id: 'backend-1',
          maxConcurrentRequests: 2,
        })

        // First two should succeed
        const result1 = await limiter.tryAcquire(backend, 'req-1')
        expect(result1).toBe(true)

        const result2 = await limiter.tryAcquire(backend, 'req-2')
        expect(result2).toBe(true)

        // Third should be rejected
        const result3 = await limiter.tryAcquire(backend, 'req-3')
        expect(result3).toBe(false)
      })

      it('should allow new requests after releasing', async () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        const backend = createTestOpenAIBackend({
          id: 'backend-1',
          maxConcurrentRequests: 2,
        })

        await limiter.tryAcquire(backend, 'req-1')
        await limiter.tryAcquire(backend, 'req-2')

        // At capacity
        let result = await limiter.tryAcquire(backend, 'req-3')
        expect(result).toBe(false)

        // Release one
        await limiter.release(backend.id, 'req-1')

        // Should now succeed
        result = await limiter.tryAcquire(backend, 'req-3')
        expect(result).toBe(true)
      })

      it('should track active request count', async () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        const backend = createTestOpenAIBackend({
          id: 'backend-1',
        })

        expect(await limiter.getActiveRequestCount(backend.id)).toBe(0)

        await limiter.recordStart(backend.id, 'req-1')
        expect(await limiter.getActiveRequestCount(backend.id)).toBe(1)

        await limiter.recordStart(backend.id, 'req-2')
        expect(await limiter.getActiveRequestCount(backend.id)).toBe(2)

        await limiter.release(backend.id, 'req-1')
        expect(await limiter.getActiveRequestCount(backend.id)).toBe(1)
      })

      it('should handle multiple backends independently', async () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        const backend1 = createTestOpenAIBackend({
          id: 'backend-1',
          maxConcurrentRequests: 1,
        })

        const backend2 = createTestOpenAIBackend({
          id: 'backend-2',
          maxConcurrentRequests: 2,
        })

        // Backend 1: limit of 1
        expect(await limiter.tryAcquire(backend1, 'req-1')).toBe(true)
        expect(await limiter.tryAcquire(backend1, 'req-2')).toBe(false)

        // Backend 2: limit of 2
        expect(await limiter.tryAcquire(backend2, 'req-3')).toBe(true)
        expect(await limiter.tryAcquire(backend2, 'req-4')).toBe(true)
        expect(await limiter.tryAcquire(backend2, 'req-5')).toBe(false)
      })

      it('should handle zero maxConcurrentRequests (no limit)', async () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        const backend = createTestOpenAIBackend({
          id: 'backend-1',
          maxConcurrentRequests: 0, // 0 means no limit
        })

        for (let i = 0; i < 10; i++) {
          const result = await limiter.tryAcquire(backend, `req-${i}`)
          expect(result).toBe(true)
        }
      })

      it('should fail open on storage errors', async () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        // Create a limiter with a broken store
        const brokenLimiter = new ConcurrencyLimiter()
        const mockStore = {
          initialize: async () => {},
          tryRecordStart: async () => {
            throw new Error('Storage error')
          },
          recordStart: async () => {},
          recordComplete: async () => {},
          getCount: async () => 0,
          getAllCounts: async () => ({}),
          cleanup: async () => 0,
          shutdown: async () => {},
        }
        brokenLimiter.initialize(mockStore)

        const backend = createTestOpenAIBackend({
          id: 'backend-1',
          maxConcurrentRequests: 1,
        })

        // Should return true (fail open) on error
        const result = await brokenLimiter.tryAcquire(backend, 'req-1')
        expect(result).toBe(true)
      })

      it('should handle release when not enabled', async () => {
        const uninitializedLimiter = new ConcurrencyLimiter()

        // Should not throw
        await expect(uninitializedLimiter.release('backend-1', 'req-1')).resolves.not.toThrow()
      })

      it('should return 0 count when not enabled', async () => {
        const uninitializedLimiter = new ConcurrencyLimiter()
        const count = await uninitializedLimiter.getActiveRequestCount('backend-1')
        expect(count).toBe(0)
      })

      it('should handle recordStart when not enabled', async () => {
        const uninitializedLimiter = new ConcurrencyLimiter()

        // Should not throw
        await expect(uninitializedLimiter.recordStart('backend-1', 'req-1')).resolves.not.toThrow()
      })

      it('should handle concurrent operations safely', async () => {
        if ((storeName === 'mongodb' && !db) || (storeName === 'redis' && !redisClient)) {
          console.log(`Skipping test: ${storeName} not available`)
          return
        }

        const backend = createTestOpenAIBackend({
          id: 'backend-1',
          maxConcurrentRequests: 5,
        })

        // Simulate 10 concurrent requests trying to acquire
        const promises = Array.from({ length: 10 }, (_, i) =>
          limiter.tryAcquire(backend, `req-${i}`)
        )

        const results = await Promise.all(promises)
        const successCount = results.filter((r) => r === true).length

        // Should allow exactly up to maxConcurrentRequests
        expect(successCount).toBeLessThanOrEqual(5)
      })
    })
  }

  // Run tests for both storage backends
  testWithStore('mongodb')
  testWithStore('redis')

  describe('singleton instance', () => {
    it('should export a singleton instance', async () => {
      // Import the singleton
      const { concurrencyLimiter } = await import('../services/concurrency-limiter.js')
      expect(concurrencyLimiter).toBeDefined()
      expect(concurrencyLimiter).toBeInstanceOf(ConcurrencyLimiter)
    })
  })
})
