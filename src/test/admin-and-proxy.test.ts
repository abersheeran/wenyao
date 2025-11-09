import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import admin from '../routes/admin.js'
import proxy from '../routes/proxy.js'
import { configManager } from '../services/config-manager.js'
import { statsTracker } from '../services/stats-tracker.js'
import { adminAuth } from '../middleware/auth.js'
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
    statsTracker.resetAllStats()
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
    statsTracker.resetAllStats()
  })

  it('GET /admin/stats returns 503 when MongoDB not connected', async () => {
    // Without MongoDB connection, /admin/stats should return 503
    const res = await app.fetch(req('/admin/stats'))
    const data = await res.json()
    expect(res.status).toBe(503)
    expect(data.error).toContain('MongoDB not connected')
  })

  it('Stats track success and failure in memory', async () => {
    // Stats are still tracked in memory (Prometheus) for load balancing
    statsTracker.recordSuccess('b1', 100)
    statsTracker.recordFailure('b1')

    // But /admin/stats/:backendId now also requires MongoDB
    const res = await app.fetch(req('/admin/stats/b1'))
    const data = await res.json()
    expect(res.status).toBe(200)

    // Stats are retrieved from in-memory Prometheus metrics
    expect(data.stats.totalRequests).toBe(2)
    expect(data.stats.successfulRequests).toBe(1)
    expect(data.stats.failedRequests).toBe(1)
  })

  it('Reset stats for a backend', async () => {
    statsTracker.recordSuccess('b1', 100)
    const res = await app.fetch(req('/admin/stats/b1', { method: 'DELETE' }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.message).toContain('Statistics reset successfully')
  })

  it('Reset all stats', async () => {
    statsTracker.recordSuccess('b1', 100)
    statsTracker.recordSuccess('b2', 200)
    const res = await app.fetch(req('/admin/stats', { method: 'DELETE' }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.message).toContain('All statistics reset successfully')

    // After reset, in-memory stats should be cleared
    const allStats = await statsTracker.getAllStats()
    expect(allStats).toEqual([])
  })

  it('GET /admin/instances returns 503 when MongoDB not connected', async () => {
    const res = await app.fetch(req('/admin/instances'))
    const data = await res.json()
    expect(res.status).toBe(503)
    expect(data.error).toContain('MongoDB not connected')
  })

  it('GET /admin/stats/history returns 503 when MongoDB not connected', async () => {
    const res = await app.fetch(req('/admin/stats/history'))
    const data = await res.json()
    expect(res.status).toBe(503)
    expect(data.error).toContain('MongoDB not connected')
  })
})

describe('Proxy API - Load Balancing', () => {
  const app = new Hono()
  app.route('/v1', proxy)

  beforeEach(async () => {
    await clearAllModels()
    statsTracker.resetAllStats()
  })

  it('returns 400 when model not configured', async () => {
    const res = await app.fetch(req('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] }) }))
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('not found')
  })

  it('returns 503 when no enabled backends', async () => {
    await configManager.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false } ], loadBalancingStrategy: 'weighted' })
    const res = await app.fetch(req('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] }) }))
    const data = await res.json()
    expect(res.status).toBe(503)
    expect(data.error.message).toContain('No enabled backends')
  })

  it('returns 400 when X-Backend-ID not found', async () => {
    await configManager.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    const res = await app.fetch(req('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Backend-ID': 'nope' }, body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] }) }))
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('not found')
  })

  it('returns 400 when X-Backend-ID disabled', async () => {
    await configManager.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false }, { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    const res = await app.fetch(req('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Backend-ID': 'b1' }, body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] }) }))
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error.message).toContain('disabled')
  })
})

