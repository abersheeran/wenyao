import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { Hono } from 'hono'

// Mock getMetricsCollector before importing routes
vi.mock('../index.js', () => ({
  getMetricsCollector: () => ({
    isEnabled: () => false,
    recordRequestComplete: vi.fn(),
    getRecentStats: vi.fn().mockResolvedValue({
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      successRate: 0,
      averageStreamingTTFT: 0,
      averageNonStreamingTTFT: 0,
    }),
    getAllStats: vi.fn().mockResolvedValue(new Map()),
    resetStats: vi.fn().mockResolvedValue(0),
  }),
}))

import admin from '../routes/admin.js'
import proxy from '../routes/proxy.js'
import { configManager } from '../services/config-manager.js'
// TODO: Update tests to use new metricsCollector instead of statsTracker
// import { statsTracker } from '../services/stats-tracker.js'
import { adminAuth, proxyAuth } from '../middleware/auth.js'
import { mongoDBService } from '../services/mongodb.js'
import type { ModelConfig, BackendConfig } from '../types/backend.js'

// 测试用的 API Key
const TEST_API_KEY = 'test-admin-key-12345'

function req(path: string, init?: RequestInit) {
  // 为所有 admin 路径的请求自动添加鉴权头
  const headers = new Headers(init?.headers)
  if (path.startsWith('/admin')) {
    headers.set('Authorization', `Bearer ${TEST_API_KEY}`)
  }

  return new Request(`http://localhost${path}`, {
    ...init,
    headers
  })
}

async function clearAllModels() {
  const models = configManager.getAllModels()
  for (const m of models) {
    await configManager.deleteModelConfig(m.model)
  }
}

describe('Admin API - Authentication', () => {
  const app = new Hono()
  app.use('/admin/*', adminAuth)
  app.route('/admin', admin)

  beforeAll(() => {
    process.env.ADMIN_APIKEYS = TEST_API_KEY
  })

  afterAll(() => {
    delete process.env.ADMIN_APIKEYS
  })

  it('returns 401 when no Authorization header', async () => {
    const res = await app.fetch(new Request('http://localhost/admin/models'))
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when invalid API key', async () => {
    const res = await app.fetch(new Request('http://localhost/admin/models', {
      headers: { 'Authorization': 'Bearer invalid-key' }
    }))
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when wrong Authorization format', async () => {
    const res = await app.fetch(new Request('http://localhost/admin/models', {
      headers: { 'Authorization': 'Basic sometoken' }
    }))
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.error).toBe('Unauthorized')
  })

  it('allows access with valid API key', async () => {
    const res = await app.fetch(req('/admin/models'))
    expect(res.status).toBe(200)
  })
})

describe('Admin API - Models & Backends', () => {
  const app = new Hono()
  // 应用鉴权中间件
  app.use('/admin/*', adminAuth)
  app.route('/admin', admin)

  // 设置测试环境的 API Key
  beforeAll(() => {
    process.env.ADMIN_APIKEYS = TEST_API_KEY
  })

  afterAll(() => {
    delete process.env.ADMIN_APIKEYS
  })

  beforeEach(async () => {
    await clearAllModels()
    // TODO: Update to use metricsCollector.resetStats()
    // statsTracker.resetAllStats()
  })

  it('GET /admin/models returns empty array initially', async () => {
    const res = await app.fetch(req('/admin/models'))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.models).toEqual([])
  })

  it('POST /admin/models creates a model', async () => {
    const backend: BackendConfig = { id: 'b1', url: 'https://api.test', apiKey: 'k', weight: 1, enabled: true }
    const body: ModelConfig = { model: 'gpt-4', backends: [backend], loadBalancingStrategy: 'weighted' }
    const res = await app.fetch(req('/admin/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }))
    const data = await res.json()
    expect(res.status).toBe(201)
    expect(data.model.model).toBe('gpt-4')
    expect(data.model.backends).toHaveLength(1)
  })

  it('POST /admin/models fails zod validation for bad payload', async () => {
    const res = await app.fetch(req('/admin/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }))
    expect(res.status).toBe(400)
  })

  it('GET /admin/models/:model includes traffic ratios', async () => {
    await configManager.addModelConfig({
      model: 'gpt-4',
      backends: [
        { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true },
        { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 3, enabled: true },
        { id: 'b3', url: 'https://c.test', apiKey: 'k3', weight: 5, enabled: false }
      ],
      loadBalancingStrategy: 'weighted'
    })
    const res = await app.fetch(req('/admin/models/gpt-4'))
    const data = await res.json()
    expect(res.status).toBe(200)
    const b1 = data.model.backends.find((b: any) => b.id === 'b1')
    const b2 = data.model.backends.find((b: any) => b.id === 'b2')
    const b3 = data.model.backends.find((b: any) => b.id === 'b3')
    expect(b1.trafficRatio).toBeCloseTo(1/4, 5)
    expect(b2.trafficRatio).toBeCloseTo(3/4, 5)
    expect(b3.trafficRatio).toBe(0)
  })

  it('Backends CRUD within a model', async () => {
    await configManager.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })

    // Add backend
    let res = await app.fetch(req('/admin/models/gpt-4/backends', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 2, enabled: true }) }))
    let data = await res.json()
    expect(res.status).toBe(201)
    expect(data.model.backends).toHaveLength(2)

    // Get backend
    res = await app.fetch(req('/admin/models/gpt-4/backends/b2'))
    data = await res.json()
    expect(res.status).toBe(200)
    expect(data.backend.id).toBe('b2')

    // Update backend
    res = await app.fetch(req('/admin/models/gpt-4/backends/b2', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weight: 5, enabled: false }) }))
    data = await res.json()
    expect(res.status).toBe(200)
    const updated = data.model.backends.find((b: any) => b.id === 'b2')
    expect(updated.weight).toBe(5)
    expect(updated.enabled).toBe(false)

    // List backends
    res = await app.fetch(req('/admin/models/gpt-4/backends'))
    data = await res.json()
    expect(res.status).toBe(200)
    expect(data.backends).toHaveLength(2)

    // Delete backend
    res = await app.fetch(req('/admin/models/gpt-4/backends/b2', { method: 'DELETE' }))
    data = await res.json()
    expect(res.status).toBe(200)
    expect(data.message).toContain('deleted successfully')
  })

  it('GET backend returns 404 when not found', async () => {
    await configManager.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    const res = await app.fetch(req('/admin/models/gpt-4/backends/none'))
    const data = await res.json()
    expect(res.status).toBe(404)
    expect(data.error).toContain('not found')
  })
})

describe('Admin API - Statistics', () => {
  const app = new Hono()
  // 应用鉴权中间件
  app.use('/admin/*', adminAuth)
  app.route('/admin', admin)

  // 设置测试环境的 API Key
  beforeAll(() => {
    process.env.ADMIN_APIKEYS = TEST_API_KEY
  })

  afterAll(() => {
    delete process.env.ADMIN_APIKEYS
  })

  beforeEach(async () => {
    await clearAllModels()
    // TODO: Update to use metricsCollector.resetStats()
    // statsTracker.resetAllStats()
  })

  it('GET /admin/stats returns 503 when MongoDB not connected', async () => {
    // Without MongoDB connection, /admin/stats should return 503
    const res = await app.fetch(req('/admin/stats'))
    const data = await res.json()
    expect(res.status).toBe(503)
    // Either "MongoDB not connected" or "Metrics collection is disabled" is acceptable
    expect(data.error).toMatch(/MongoDB not connected|Metrics collection is disabled/)
  })

  // TODO: Update these tests to use metricsCollector
  it.skip('Stats track success and failure in memory', async () => {
    // Stats are still tracked in memory (Prometheus) for load balancing
    // statsTracker.recordSuccess('b1', 100)
    // statsTracker.recordFailure('b1')

    // But /admin/stats/:backendId now also requires MongoDB
    const res = await app.fetch(req('/admin/stats/b1'))
    const data = await res.json()
    expect(res.status).toBe(200)

    // Stats are retrieved from in-memory Prometheus metrics
    expect(data.stats.totalRequests).toBe(2)
    expect(data.stats.successfulRequests).toBe(1)
    expect(data.stats.failedRequests).toBe(1)
  })

  it.skip('Reset stats for a backend', async () => {
    // statsTracker.recordSuccess('b1', 100)
    const res = await app.fetch(req('/admin/stats/b1', { method: 'DELETE' }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.message).toContain('Statistics reset successfully')
  })

  it.skip('Reset all stats', async () => {
    // statsTracker.recordSuccess('b1', 100)
    // statsTracker.recordSuccess('b2', 200)
    const res = await app.fetch(req('/admin/stats', { method: 'DELETE' }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.message).toContain('All statistics reset successfully')

    // After reset, in-memory stats should be cleared
    // const allStats = await statsTracker.getAllStats()
    // expect(allStats).toEqual([])
  })

  it('GET /admin/instances returns 503 when MongoDB not connected', async () => {
    const res = await app.fetch(req('/admin/instances'))
    const data = await res.json()
    expect(res.status).toBe(503)
    // Either "MongoDB not connected" or "Metrics collection is disabled" is acceptable
    expect(data.error).toMatch(/MongoDB not connected|Metrics collection is disabled/)
  })

  it('GET /admin/stats/history returns 503 when MongoDB not connected', async () => {
    const res = await app.fetch(req('/admin/stats/history'))
    const data = await res.json()
    expect(res.status).toBe(503)
    // Either "MongoDB not connected" or "Metrics collection is disabled" is acceptable
    expect(data.error).toMatch(/MongoDB not connected|Metrics collection is disabled/)
  })
})

describe('Proxy API - Load Balancing', () => {
  const app = new Hono()
  app.use('/v1/*', proxyAuth)
  app.route('/v1', proxy)

  beforeAll(async () => {
    // Connect to MongoDB for API key auth tests
    if (process.env.MONGODB_URL) {
      try {
        await mongoDBService.connect()
      } catch (error) {
        console.error('Failed to connect to MongoDB for tests:', error)
      }
    }
  })

  afterAll(async () => {
    if (mongoDBService.isConnected()) {
      await mongoDBService.disconnect()
    }
  })

  beforeEach(async () => {
    await clearAllModels()
    // TODO: Update to use metricsCollector.resetStats()
    // statsTracker.resetAllStats()
    // Create a test API key with access to gpt-4
    if (mongoDBService.isConnected()) {
      const collection = mongoDBService.getApiKeysCollection()
      await collection.deleteMany({})
      await collection.insertOne({
        key: 'test-load-balancing-key',
        description: 'Test Load Balancing Key',
        models: ['gpt-4'],
        createdAt: new Date()
      })
    }
  })

  it('returns 400 when model not configured', async () => {
    if (!mongoDBService.isConnected()) {
      console.log('Skipping test: MongoDB not available')
      return
    }
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-load-balancing-key'
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] })
    }))
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('not found')
  })

  it('returns 503 when no enabled backends', async () => {
    if (!mongoDBService.isConnected()) {
      console.log('Skipping test: MongoDB not available')
      return
    }
    await configManager.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false } ], loadBalancingStrategy: 'weighted' })
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-load-balancing-key'
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] })
    }))
    const data = await res.json()
    expect(res.status).toBe(503)
    expect(data.error.message).toContain('No enabled backends')
  })

  it('returns 400 when X-Backend-ID not found', async () => {
    if (!mongoDBService.isConnected()) {
      console.log('Skipping test: MongoDB not available')
      return
    }
    await configManager.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-load-balancing-key',
        'X-Backend-ID': 'nope'
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] })
    }))
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('not found')
  })

  it('returns 400 when X-Backend-ID disabled', async () => {
    if (!mongoDBService.isConnected()) {
      console.log('Skipping test: MongoDB not available')
      return
    }
    await configManager.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false }, { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-load-balancing-key',
        'X-Backend-ID': 'b1'
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] })
    }))
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('disabled')
  })
})

describe('Admin API - API Key Management', () => {
  const app = new Hono()
  app.use('/admin/*', adminAuth)
  app.route('/admin', admin)

  beforeAll(async () => {
    process.env.ADMIN_APIKEYS = TEST_API_KEY
    // Connect to MongoDB for API key tests
    if (process.env.MONGODB_URL) {
      try {
        await mongoDBService.connect()
      } catch (error) {
        console.error('Failed to connect to MongoDB for tests:', error)
      }
    }
  })

  afterAll(async () => {
    delete process.env.ADMIN_APIKEYS
    if (mongoDBService.isConnected()) {
      await mongoDBService.disconnect()
    }
  })

  beforeEach(async () => {
    // Clear all API keys before each test
    if (mongoDBService.isConnected()) {
      const collection = mongoDBService.getApiKeysCollection()
      await collection.deleteMany({})
    }
  })

  it('GET /admin/apikeys returns 503 when MongoDB not connected', async () => {
    if (mongoDBService.isConnected()) {
      await mongoDBService.disconnect()
    }
    const res = await app.fetch(req('/admin/apikeys'))
    const data = await res.json()
    expect(res.status).toBe(503)
    expect(data.error).toContain('MongoDB not connected')
  })

  it('POST /admin/apikeys creates a new API key', async () => {
    if (!mongoDBService.isConnected()) {
      await mongoDBService.connect()
    }
    const body = {
      key: 'test-key-123',
      description: 'Test API Key',
      models: ['gpt-4', 'claude-3-sonnet']
    }
    const res = await app.fetch(req('/admin/apikeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }))
    const data = await res.json()
    expect(res.status).toBe(201)
    expect(data.apiKey.key).toBe('test-key-123')
    expect(data.apiKey.description).toBe('Test API Key')
    expect(data.apiKey.models).toEqual(['gpt-4', 'claude-3-sonnet'])
    expect(data.apiKey.createdAt).toBeDefined()
  })

  it('POST /admin/apikeys returns 409 when key already exists', async () => {
    if (!mongoDBService.isConnected()) {
      await mongoDBService.connect()
    }
    const body = {
      key: 'test-key-123',
      description: 'Test API Key',
      models: ['gpt-4']
    }
    // Create first time
    await app.fetch(req('/admin/apikeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }))
    // Try to create again
    const res = await app.fetch(req('/admin/apikeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }))
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.error).toContain('already exists')
  })

  it('GET /admin/apikeys/:key returns a specific API key', async () => {
    if (!mongoDBService.isConnected()) {
      await mongoDBService.connect()
    }
    // Create API key first
    await app.fetch(req('/admin/apikeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'test-key-123',
        description: 'Test API Key',
        models: ['gpt-4']
      })
    }))
    // Get the API key
    const res = await app.fetch(req('/admin/apikeys/test-key-123'))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.apiKey.key).toBe('test-key-123')
  })

  it('PUT /admin/apikeys/:key updates an API key', async () => {
    if (!mongoDBService.isConnected()) {
      await mongoDBService.connect()
    }
    // Create API key first
    await app.fetch(req('/admin/apikeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'test-key-123',
        description: 'Test API Key',
        models: ['gpt-4']
      })
    }))
    // Update the API key
    const res = await app.fetch(req('/admin/apikeys/test-key-123', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Updated Description',
        models: ['gpt-4', 'claude-3']
      })
    }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.apiKey.description).toBe('Updated Description')
    expect(data.apiKey.models).toEqual(['gpt-4', 'claude-3'])
  })

  it('DELETE /admin/apikeys/:key deletes an API key', async () => {
    if (!mongoDBService.isConnected()) {
      await mongoDBService.connect()
    }
    // Create API key first
    await app.fetch(req('/admin/apikeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'test-key-123',
        description: 'Test API Key',
        models: ['gpt-4']
      })
    }))
    // Delete the API key
    const res = await app.fetch(req('/admin/apikeys/test-key-123', {
      method: 'DELETE'
    }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.message).toContain('deleted successfully')
  })
})

describe('Proxy API - API Key Authentication', () => {
  const app = new Hono()
  app.use('/v1/*', proxyAuth)
  app.route('/v1', proxy)

  beforeAll(async () => {
    // Connect to MongoDB for API key auth tests
    if (process.env.MONGODB_URL) {
      try {
        await mongoDBService.connect()
      } catch (error) {
        console.error('Failed to connect to MongoDB for tests:', error)
      }
    }
  })

  afterAll(async () => {
    if (mongoDBService.isConnected()) {
      await mongoDBService.disconnect()
    }
  })

  beforeEach(async () => {
    await clearAllModels()
    // TODO: Update to use metricsCollector.resetStats()
    // statsTracker.resetAllStats()
    // Clear all API keys
    if (mongoDBService.isConnected()) {
      const collection = mongoDBService.getApiKeysCollection()
      await collection.deleteMany({})
    }
  })

  it('returns 401 when no Authorization header', async () => {
    if (!mongoDBService.isConnected()) {
      console.log('Skipping test: MongoDB not available')
      return
    }
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] })
    }))
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 401 when invalid API key', async () => {
    if (!mongoDBService.isConnected()) {
      console.log('Skipping test: MongoDB not available')
      return
    }
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-key'
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] })
    }))
    const data = await res.json()
    expect(res.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 403 when API key does not have permission for model', async () => {
    if (!mongoDBService.isConnected()) {
      await mongoDBService.connect()
    }
    // Create API key with limited model access
    const collection = mongoDBService.getApiKeysCollection()
    await collection.insertOne({
      key: 'test-proxy-key',
      description: 'Test Proxy Key',
      models: ['claude-3-sonnet'],
      createdAt: new Date()
    })
    // Configure model
    await configManager.addModelConfig({
      model: 'gpt-4',
      backends: [{ id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true }],
      loadBalancingStrategy: 'weighted'
    })
    // Try to access gpt-4 with API key that only has access to claude-3-sonnet
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-key'
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] })
    }))
    const data = await res.json()
    expect(res.status).toBe(403)
    expect(data.error.message).toContain('does not have permission')
  })

  it('allows access with valid API key and correct model permission', async () => {
    if (!mongoDBService.isConnected()) {
      await mongoDBService.connect()
    }
    // Create API key with gpt-4 access
    const collection = mongoDBService.getApiKeysCollection()
    await collection.insertOne({
      key: 'test-proxy-key',
      description: 'Test Proxy Key',
      models: ['gpt-4'],
      createdAt: new Date()
    })
    // Configure model
    await configManager.addModelConfig({
      model: 'gpt-4',
      backends: [{ id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true }],
      loadBalancingStrategy: 'weighted'
    })
    // Try to access gpt-4 (should pass auth but fail on backend call)
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-proxy-key'
      },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] })
    }))
    // Should not be 401 or 403 (auth passed)
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})

describe('Backend Model Remapping', () => {
  const app = new Hono()
  app.use('/admin/*', adminAuth)
  app.route('/admin', admin)

  beforeAll(() => {
    process.env.ADMIN_APIKEYS = TEST_API_KEY
  })

  afterAll(() => {
    delete process.env.ADMIN_APIKEYS
  })

  beforeEach(async () => {
    await clearAllModels()
    // TODO: Update to use metricsCollector.resetStats()
    // statsTracker.resetAllStats()
  })

  it('Backend with model field can be created and retrieved', async () => {
    const backend: BackendConfig = {
      id: 'b1',
      url: 'https://api.test',
      apiKey: 'k1',
      weight: 1,
      enabled: true,
      model: 'gpt-4-turbo'
    }
    const body: ModelConfig = {
      model: 'gpt-4',
      backends: [backend],
      loadBalancingStrategy: 'weighted'
    }

    // Create model with backend that has model field
    const createRes = await app.fetch(req('/admin/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }))
    const createData = await createRes.json()
    expect(createRes.status).toBe(201)
    expect(createData.model.backends[0].model).toBe('gpt-4-turbo')

    // Get the model and verify model field is preserved
    const getRes = await app.fetch(req('/admin/models/gpt-4'))
    const getData = await getRes.json()
    expect(getRes.status).toBe(200)
    expect(getData.model.backends[0].model).toBe('gpt-4-turbo')
  })

  it('Backend model field can be updated', async () => {
    // Create initial backend without model field
    await configManager.addModelConfig({
      model: 'gpt-4',
      backends: [{
        id: 'b1',
        url: 'https://a.test',
        apiKey: 'k1',
        weight: 1,
        enabled: true
      }],
      loadBalancingStrategy: 'weighted'
    })

    // Update backend to add model field
    const updateRes = await app.fetch(req('/admin/models/gpt-4/backends/b1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4-turbo' })
    }))
    const updateData = await updateRes.json()
    expect(updateRes.status).toBe(200)
    expect(updateData.model.backends[0].model).toBe('gpt-4-turbo')

    // Verify the update persisted
    const getRes = await app.fetch(req('/admin/models/gpt-4/backends/b1'))
    const getData = await getRes.json()
    expect(getRes.status).toBe(200)
    expect(getData.backend.model).toBe('gpt-4-turbo')
  })

  it('Backend without model field works as before', async () => {
    const backend: BackendConfig = {
      id: 'b1',
      url: 'https://api.test',
      apiKey: 'k1',
      weight: 1,
      enabled: true
    }
    const body: ModelConfig = {
      model: 'gpt-4',
      backends: [backend],
      loadBalancingStrategy: 'weighted'
    }

    // Create backend without model field
    const createRes = await app.fetch(req('/admin/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }))
    const createData = await createRes.json()
    expect(createRes.status).toBe(201)
    expect(createData.model.backends[0].model).toBeUndefined()

    // Verify it's still undefined
    const getRes = await app.fetch(req('/admin/models/gpt-4'))
    const getData = await getRes.json()
    expect(getRes.status).toBe(200)
    expect(getData.model.backends[0].model).toBeUndefined()
  })
})

