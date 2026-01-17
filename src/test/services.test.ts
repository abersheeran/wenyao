import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { ConfigManager } from '../services/config-manager.js'
import { LoadBalancer } from '../services/load-balancer.js'
import { createMetricsCollector } from '../services/metrics/index.js'
import type { MetricsCollector } from '../services/metrics/index.js'
import { concurrencyLimiter } from '../services/concurrency-limiter.js'
import { createActiveRequestStore } from '../services/active-requests/index.js'
import type { BackendConfig, ModelConfig } from '../types/backend.js'
import { MongoClient, Db } from 'mongodb'

describe('ConfigManager', () => {
  let configManager: ConfigManager

  beforeEach(() => {
    configManager = new ConfigManager()
  })

  function sampleModel(backends: BackendConfig[] = [
    { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true }
  ]): ModelConfig {
    return { model: 'gpt-4', backends, loadBalancingStrategy: 'weighted' }
  }

  it('starts with no models', () => {
    expect(configManager.getAllModels()).toEqual([])
  })

  it('adds a model configuration', async () => {
    const model = sampleModel()
    const saved = await configManager.addModelConfig(model)
    expect(configManager.getAllModels()).toHaveLength(1)
    expect(configManager.getModelConfig('gpt-4')).toEqual(saved)
  })

  it('does not allow duplicate model configs', async () => {
    const model = sampleModel()
    await configManager.addModelConfig(model)
    await expect(configManager.addModelConfig(model)).rejects.toThrow('already exists')
  })

  it('updates a model configuration', async () => {
    const model = sampleModel()
    await configManager.addModelConfig(model)
    const updates = { backends: [{ id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 5, enabled: false }] }
    const updated = await configManager.updateModelConfig('gpt-4', updates)
    const backend = updated.backends.find(b => b.id === 'b1')!
    expect(backend.weight).toBe(5)
    expect(backend.enabled).toBe(false)
  })

  it('throws when updating non-existent model', async () => {
    await expect(configManager.updateModelConfig('missing', { loadBalancingStrategy: 'lowest-ttft' }))
      .rejects.toThrow('not found')
  })

  it('deletes a model configuration', async () => {
    await configManager.addModelConfig(sampleModel())
    expect(await configManager.deleteModelConfig('gpt-4')).toBe(true)
    expect(configManager.getModelConfig('gpt-4')).toBeUndefined()
  })

  it('returns false when deleting non-existent model', async () => {
    expect(await configManager.deleteModelConfig('missing')).toBe(false)
  })

  it('gets only enabled backends for a model', async () => {
    await configManager.addModelConfig(sampleModel([
      { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true },
      { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 1, enabled: false }
    ]))
    const enabled = configManager.getEnabledBackends('gpt-4')
    expect(enabled).toHaveLength(1)
    expect(enabled[0].id).toBe('b1')
  })

  it('calculates total weight of enabled backends', async () => {
    await configManager.addModelConfig(sampleModel([
      { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 3, enabled: true },
      { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 7, enabled: true },
      { id: 'b3', url: 'https://c.test', apiKey: 'k3', weight: 5, enabled: false }
    ]))
    expect(configManager.getTotalWeight('gpt-4')).toBe(10)
  })

  it('adds, updates, deletes a backend within a model', async () => {
    await configManager.addModelConfig(sampleModel())
    // add
    let updated = await configManager.addBackendToModel('gpt-4', { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 2, enabled: true })
    expect(updated.backends).toHaveLength(2)
    // update
    updated = await configManager.updateBackendInModel('gpt-4', 'b2', { weight: 5, enabled: false })
    const b2 = updated.backends.find(b => b.id === 'b2')!
    expect(b2.weight).toBe(5)
    expect(b2.enabled).toBe(false)
    // delete
    updated = await configManager.deleteBackendFromModel('gpt-4', 'b2')
    expect(updated.backends.find(b => b.id === 'b2')).toBeUndefined()
  })
})

describe('MetricsCollector', () => {
  let metricsCollector: MetricsCollector
  let mongoClient: MongoClient | null = null
  let db: Db | null = null

  beforeAll(async () => {
    // Try to connect to MongoDB for metrics tests
    if (process.env.MONGODB_URL) {
      try {
        mongoClient = new MongoClient(process.env.MONGODB_URL)
        await mongoClient.connect()
        db = mongoClient.db()
        console.log('Connected to MongoDB for metrics tests')
      } catch (error) {
        console.warn('MongoDB not available for metrics tests:', error)
      }
    }
  })

  afterAll(async () => {
    if (mongoClient) {
      await mongoClient.close()
    }
  })

  beforeEach(async () => {
    // Initialize concurrency limiter if DB is available
    if (db) {
      const store = createActiveRequestStore({
        type: 'mongodb',
        instanceId: 'test-instance',
        db: db
      })
      await store.initialize()
      concurrencyLimiter.initialize(store)
    }

    // Create metrics collector (will use NoopCollector if MongoDB not available)
    metricsCollector = await createMetricsCollector({
      enabled: !!db,
      db: db || undefined
    })

    // Clear metrics if using database
    if (metricsCollector.isEnabled()) {
      await metricsCollector.resetStats()
    }
  })

  it('should start with no stats', async () => {
    const now = new Date()
    const oneSecondAgo = new Date(now.getTime() - 1000)
    const stats = await metricsCollector.getAllStats({ startTime: oneSecondAgo, endTime: now })
    expect(Array.from(stats.values())).toEqual([])
  })

  it('should record a successful request', async () => {
    if (!metricsCollector.isEnabled()) {
      console.log('Skipping test: metrics disabled')
      return
    }

    await concurrencyLimiter.recordStart('backend-1', 'req-1')
    await metricsCollector.recordRequestComplete({
      backendId: 'backend-1',
      requestId: 'req-1',
      status: 'success',
      duration: 1000,
      ttft: 100,
      streamType: 'streaming',
      model: 'gpt-4'
    })

    // Wait a bit for async write
    await new Promise(resolve => setTimeout(resolve, 100))

    const stats = await metricsCollector.getRecentStats('backend-1', 5000)
    expect(stats.totalRequests).toBe(1)
    expect(stats.successfulRequests).toBe(1)
    expect(stats.failedRequests).toBe(0)
    expect(stats.successRate).toBe(1)
    expect(stats.averageStreamingTTFT).toBeGreaterThan(0)
  })

  it('should record a failed request', async () => {
    if (!metricsCollector.isEnabled()) {
      console.log('Skipping test: metrics disabled')
      return
    }

    await concurrencyLimiter.recordStart('backend-1', 'req-2')
    await metricsCollector.recordRequestComplete({
      backendId: 'backend-1',
      requestId: 'req-2',
      status: 'failure',
      duration: 500,
      model: 'gpt-4',
      errorType: 'network_error'
    })

    // Wait a bit for async write
    await new Promise(resolve => setTimeout(resolve, 100))

    const stats = await metricsCollector.getRecentStats('backend-1', 5000)
    expect(stats.totalRequests).toBe(1)
    expect(stats.successfulRequests).toBe(0)
    expect(stats.failedRequests).toBe(1)
    expect(stats.successRate).toBe(0)
  })

  it('should calculate average streaming TTFT correctly', async () => {
    if (!metricsCollector.isEnabled()) {
      console.log('Skipping test: metrics disabled')
      return
    }

    const requests = [
      { ttft: 100, requestId: 'req-3' },
      { ttft: 200, requestId: 'req-4' },
      { ttft: 150, requestId: 'req-5' }
    ]

    for (const req of requests) {
      await concurrencyLimiter.recordStart('backend-1', req.requestId)
      await metricsCollector.recordRequestComplete({
        backendId: 'backend-1',
        requestId: req.requestId,
        status: 'success',
        duration: 1000,
        ttft: req.ttft,
        streamType: 'streaming',
        model: 'gpt-4'
      })
    }

    // Wait a bit for async writes
    await new Promise(resolve => setTimeout(resolve, 200))

    const stats = await metricsCollector.getRecentStats('backend-1', 5000)
    expect(stats.averageStreamingTTFT).toBeCloseTo(150, 0)
  })

  it('should calculate success rate correctly', async () => {
    if (!metricsCollector.isEnabled()) {
      console.log('Skipping test: metrics disabled')
      return
    }

    const requests = [
      { status: 'success' as const, requestId: 'req-6' },
      { status: 'success' as const, requestId: 'req-7' },
      { status: 'failure' as const, requestId: 'req-8' },
      { status: 'success' as const, requestId: 'req-9' }
    ]

    for (const req of requests) {
      await concurrencyLimiter.recordStart('backend-1', req.requestId)
      await metricsCollector.recordRequestComplete({
        backendId: 'backend-1',
        requestId: req.requestId,
        status: req.status,
        duration: 1000,
        model: 'gpt-4'
      })
    }

    // Wait a bit for async writes
    await new Promise(resolve => setTimeout(resolve, 200))

    const stats = await metricsCollector.getRecentStats('backend-1', 5000)
    expect(stats.totalRequests).toBe(4)
    expect(stats.successfulRequests).toBe(3)
    expect(stats.failedRequests).toBe(1)
    expect(stats.successRate).toBeCloseTo(0.75, 2)
  })

  it('should reset stats for a backend', async () => {
    if (!metricsCollector.isEnabled()) {
      console.log('Skipping test: metrics disabled')
      return
    }

    await concurrencyLimiter.recordStart('backend-1', 'req-10')
    await metricsCollector.recordRequestComplete({
      backendId: 'backend-1',
      requestId: 'req-10',
      status: 'success',
      duration: 1000,
      model: 'gpt-4'
    })

    // Wait a bit for async write
    await new Promise(resolve => setTimeout(resolve, 100))

    const deletedCount = await metricsCollector.resetStats('backend-1')
    expect(deletedCount).toBeGreaterThan(0)

    const stats = await metricsCollector.getRecentStats('backend-1', 5000)
    expect(stats.totalRequests).toBe(0)
  })

  it('should work when metrics disabled (NoopCollector)', async () => {
    const noopCollector = await createMetricsCollector({
      enabled: false
    })

    expect(noopCollector.isEnabled()).toBe(false)

    await noopCollector.recordRequestComplete({
      backendId: 'backend-1',
      requestId: 'req-11',
      status: 'success',
      duration: 1000,
      model: 'gpt-4'
    })

    const stats = await noopCollector.getRecentStats('backend-1', 5000)
    expect(stats.totalRequests).toBe(0)
  })
})

describe('LoadBalancer', () => {
  let lb: LoadBalancer
  let cm: ConfigManager

  beforeEach(async () => {
    cm = new ConfigManager()
    lb = new LoadBalancer(cm)
  })

  it('throws when model not found', async () => {
    await expect(lb.selectBackend('gpt-4')).rejects.toThrow('not found')
  })

  it('returns null when no enabled backends', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false } ], loadBalancingStrategy: 'weighted' })
    const backend = await lb.selectBackend('gpt-4')
    expect(backend).toBeNull()
  })

  it('selects backend when forced id provided', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    const selected = await lb.selectBackend('gpt-4', 'b1')
    expect(selected?.id).toBe('b1')
  })

  it('throws when forced id does not exist', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    await expect(lb.selectBackend('gpt-4', 'nope')).rejects.toThrow('not found')
  })

  it('throws when forced id is disabled', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false } ], loadBalancingStrategy: 'weighted' })
    await expect(lb.selectBackend('gpt-4', 'b1')).rejects.toThrow('disabled')
  })

  it('only selects from enabled backends', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [
      { id: 'disabled', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false },
      { id: 'enabled', url: 'https://b.test', apiKey: 'k2', weight: 1, enabled: true }
    ], loadBalancingStrategy: 'weighted' })
    const selected = await lb.selectBackend('gpt-4')
    expect(selected?.id).toBe('enabled')
  })

  it('respects weight distribution', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [
      { id: 'heavy', url: 'https://a.test', apiKey: 'k1', weight: 90, enabled: true },
      { id: 'light', url: 'https://b.test', apiKey: 'k2', weight: 10, enabled: true }
    ], loadBalancingStrategy: 'weighted' })

    const counts = { heavy: 0, light: 0 }
    for (let i = 0; i < 1000; i++) {
      const selected = await lb.selectBackend('gpt-4')
      if (selected?.id === 'heavy') counts.heavy++
      if (selected?.id === 'light') counts.light++
    }

    expect(counts.heavy).toBeGreaterThan(800)
    expect(counts.heavy).toBeLessThan(950)
    expect(counts.light).toBeGreaterThan(50)
    expect(counts.light).toBeLessThan(200)
  })

  it('handles equal weights', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [
      { id: 'backend-1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true },
      { id: 'backend-2', url: 'https://b.test', apiKey: 'k2', weight: 1, enabled: true }
    ], loadBalancingStrategy: 'weighted' })

    const counts = { 'backend-1': 0, 'backend-2': 0 }
    for (let i = 0; i < 1000; i++) {
      const selected = await lb.selectBackend('gpt-4')
      if (selected?.id === 'backend-1') counts['backend-1']++
      if (selected?.id === 'backend-2') counts['backend-2']++
    }

    expect(counts['backend-1']).toBeGreaterThan(400)
    expect(counts['backend-1']).toBeLessThan(600)
    expect(counts['backend-2']).toBeGreaterThan(400)
    expect(counts['backend-2']).toBeLessThan(600)
  })

  it('returns null when all backends have zero weight', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [
      { id: 'backend-1', url: 'https://a.test', apiKey: 'k1', weight: 0, enabled: true },
      { id: 'backend-2', url: 'https://b.test', apiKey: 'k2', weight: 0, enabled: true }
    ], loadBalancingStrategy: 'weighted' })
    const selected = await lb.selectBackend('gpt-4')
    // When all backends have weight=0, they are filtered out and null is returned
    expect(selected).toBeNull()
  })
})
