import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  admin,
  ADMIN_KEY,
  count,
  createTestBedrockBackend,
  createTestOpenAIBackend,
  insertAffinity,
  insertStats,
  jsonResponse,
  MODEL,
  modelConfig,
  proxy,
  PROXY_KEY,
  request,
  seed,
  seedConnections,
  upstream,
} from './helpers.js'
import { DbMetricsCollector } from '../services/metrics/db-collector.js'

import type { ApiKey } from '../types/apikey.js'
import type {
  BackendStats,
  ModelConfig,
  RecordedRequest,
  StatsDataPoint,
} from '../types/backend.js'

interface Recorded extends RecordedRequest {
  _id: string
}

async function expectError(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(await response.json()).toHaveProperty('error')
}

describe('Worker entry and management authentication', () => {
  it('health no longer exposes process instance information', async () => {
    const response = await request('/health')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).not.toHaveProperty('instanceId')
    expect(body).not.toHaveProperty('metricsEnabled')
  })

  it('fails closed if ADMIN_APIKEYS is absent', async () => {
    await expectError(await request('/admin/models', {}, { ...env, ADMIN_APIKEYS: '' }), 503)
  })

  it.each([undefined, 'Bearer invalid', 'Basic invalid'])(
    'rejects invalid admin credentials: %s',
    async (authorization) => {
      const headers = new Headers(authorization ? { Authorization: authorization } : {})
      await expectError(await request('/admin/models', { headers }), 401)
    }
  )

  it('accepts a configured key including comma separated secrets', async () => {
    const response = await request(
      '/admin/models',
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      { ...env, ADMIN_APIKEYS: `other-key, ${ADMIN_KEY}` }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ models: [] })
  })

  it('removes instance management endpoints', async () => {
    expect((await admin('/instances')).status).toBe(404)
    expect((await admin('/instances/old-instance/stats')).status).toBe(404)
  })
})

describe('Management CRUD persists to D1', () => {
  it('creates, lists, reads, updates and deletes a model', async () => {
    await seedConnections()
    const config = modelConfig({
      backends: [
        createTestOpenAIBackend({ id: 'a', weight: 1 }),
        createTestOpenAIBackend({ id: 'b', weight: 3 }),
        createTestOpenAIBackend({ id: 'off', weight: 9, enabled: false }),
      ],
    })
    expect((await admin('/models', 'POST', config)).status).toBe(201)
    const stored = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(JSON.parse(stored!.config)).toMatchObject(config)
    const { models } = (await (await admin('/models')).json()) as { models: ModelConfig[] }
    expect(models).toHaveLength(1)
    const { model } = (await (await admin(`/models/${MODEL}`)).json()) as {
      model: Omit<ModelConfig, 'backends'> & { backends: { trafficRatio: number }[] }
    }
    expect(model.backends.map((backend) => backend.trafficRatio)).toEqual([0.25, 0.75, 0])
    expect((await admin(`/models/${MODEL}`, 'PUT', { enableAffinity: true })).status).toBe(200)
    const updated = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(JSON.parse(updated!.config).enableAffinity).toBe(true)
    expect((await admin(`/models/${MODEL}`, 'DELETE')).status).toBe(200)
    expect(await count('models')).toBe(0)
  })

  it('creates, lists, reads, updates and deletes backends within model JSON', async () => {
    await seed()
    const backend = createTestOpenAIBackend({ id: 'b2' })
    expect((await admin(`/models/${MODEL}/backends`, 'POST', backend)).status).toBe(201)
    const listed = (await (await admin(`/models/${MODEL}/backends`)).json()) as {
      backends: { id: string }[]
    }
    expect(listed.backends.map((item) => item.id)).toEqual(['b1', 'b2'])
    const read = (await (await admin(`/models/${MODEL}/backends/b2`)).json()) as {
      backend: { id: string }
    }
    expect(read.backend.id).toBe('b2')
    expect(
      (await admin(`/models/${MODEL}/backends/b2`, 'PUT', { weight: 3, enabled: false })).status
    ).toBe(200)
    const stored = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(JSON.parse(stored!.config).backends[1]).toMatchObject({
      id: 'b2',
      weight: 3,
      enabled: false,
    })
    expect((await admin(`/models/${MODEL}/backends/b2`, 'DELETE')).status).toBe(200)
    const afterDelete = (await (await admin(`/models/${MODEL}/backends`)).json()) as {
      backends: { id: string }[]
    }
    expect(afterDelete.backends.map((item) => item.id)).toEqual(['b1'])
  })

  it('creates, lists, reads, updates and deletes API keys', async () => {
    expect(
      (await admin('/apikeys', 'POST', { key: PROXY_KEY, description: 'First', models: [MODEL] }))
        .status
    ).toBe(201)
    const stored = await env.DB.prepare('SELECT * FROM api_keys WHERE key = ?')
      .bind(PROXY_KEY)
      .first<{ description: string; models: string; created_at: number }>()
    expect(stored!.description).toBe('First')
    expect(JSON.parse(stored!.models)).toEqual([MODEL])
    expect(stored!.created_at).toBeGreaterThan(0)
    const listed = (await (await admin('/apikeys')).json()) as { apiKeys: ApiKey[] }
    expect(listed.apiKeys).toHaveLength(1)
    const read = (await (await admin(`/apikeys/${PROXY_KEY}`)).json()) as { apiKey: ApiKey }
    expect(read.apiKey.key).toBe(PROXY_KEY)
    expect(read.apiKey.createdAt).toBeTruthy()
    expect(
      (await admin(`/apikeys/${PROXY_KEY}`, 'PUT', { description: 'Updated', models: ['other'] }))
        .status
    ).toBe(200)
    const updated = await env.DB.prepare('SELECT description, models FROM api_keys WHERE key = ?')
      .bind(PROXY_KEY)
      .first<{ description: string; models: string }>()
    expect(updated!.description).toBe('Updated')
    expect(JSON.parse(updated!.models)).toEqual(['other'])
    expect((await admin(`/apikeys/${PROXY_KEY}`, 'DELETE')).status).toBe(200)
    expect(await count('api_keys')).toBe(0)
  })

  it('returns JSON 404, 409 and 400 for business errors', async () => {
    await expectError(
      await admin('/models', 'POST', modelConfig({ backends: [createTestBedrockBackend()] })),
      400
    )
    await expectError(await admin('/models/missing'), 404)
    await expectError(await admin('/models/missing', 'PUT', { enableAffinity: true }), 404)
    await expectError(await admin('/models/missing', 'DELETE'), 404)
    await seed()
    await expectError(await admin('/models', 'POST', modelConfig()), 409)
    await expectError(
      await admin(`/models/${MODEL}/backends`, 'POST', createTestOpenAIBackend()),
      409
    )
    await expectError(
      await admin(`/models/${MODEL}/backends`, 'POST', createTestBedrockBackend()),
      400
    )
    await expectError(await admin(`/models/${MODEL}/backends/missing`, 'PUT', { weight: 2 }), 404)
    await expectError(await admin(`/models/${MODEL}/backends/missing`, 'DELETE'), 404)
    await expectError(
      await admin('/apikeys', 'POST', {
        key: PROXY_KEY,
        description: 'Duplicate',
        models: [MODEL],
      }),
      409
    )
    await expectError(await admin('/apikeys/missing'), 404)
    await expectError(await admin('/apikeys/missing', 'PUT', { description: 'Missing' }), 404)
    await expectError(await admin('/apikeys/missing', 'DELETE'), 404)
  })

  it('invalidates current isolate model and key caches after writes', async () => {
    await seed()
    upstream(() => jsonResponse({ ok: true }))
    expect((await proxy()).status).toBe(200)
    expect((await admin(`/models/${MODEL}/backends/b1`, 'PUT', { enabled: false })).status).toBe(
      200
    )
    expect((await proxy()).status).toBe(503)
    expect((await admin(`/models/${MODEL}/backends/b1`, 'PUT', { enabled: true })).status).toBe(200)
    expect((await proxy()).status).toBe(200)
    expect((await admin(`/apikeys/${PROXY_KEY}`, 'PUT', { models: ['other'] })).status).toBe(200)
    expect((await proxy()).status).toBe(403)
    expect((await admin(`/apikeys/${PROXY_KEY}`, 'DELETE')).status).toBe(200)
    expect((await proxy()).status).toBe(401)
  })

  it('invalidates an old proxy snapshot when a management update already matches D1', async () => {
    await seed()
    upstream(() => jsonResponse({ ok: true }))
    expect((await proxy()).status).toBe(200)
    const changed = modelConfig({ backends: [createTestOpenAIBackend({ enabled: false })] })
    await env.DB.prepare('UPDATE models SET config = ? WHERE model = ?')
      .bind(JSON.stringify(changed), MODEL)
      .run()
    // The isolate still holds the earlier enabled-backend snapshot.
    expect((await proxy()).status).toBe(200)
    expect((await admin(`/models/${MODEL}/backends/b1`, 'PUT', { enabled: false })).status).toBe(
      200
    )
    expect((await proxy()).status).toBe(503)
  })

  it('persists both backends added concurrently to one model', async () => {
    await seed()
    const responses = await Promise.all([
      admin(`/models/${MODEL}/backends`, 'POST', createTestOpenAIBackend({ id: 'b2' })),
      admin(`/models/${MODEL}/backends`, 'POST', createTestOpenAIBackend({ id: 'b3' })),
    ])
    expect(responses.map((response) => response.status)).toEqual([201, 201])
    const stored = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    const model = JSON.parse(stored!.config) as ModelConfig
    expect(model.backends.map((backend) => backend.id).sort()).toEqual(['b1', 'b2', 'b3'])
  })

  it('preserves different model fields updated concurrently', async () => {
    await seed()
    const responses = await Promise.all([
      admin(`/models/${MODEL}`, 'PUT', { enableAffinity: true }),
      admin(`/models/${MODEL}`, 'PUT', { loadBalancingStrategy: 'lowest-ttft' }),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const stored = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(JSON.parse(stored!.config)).toMatchObject({
      enableAffinity: true,
      loadBalancingStrategy: 'lowest-ttft',
    })
  })

  it('preserves model and backend fields updated concurrently', async () => {
    await seed()
    const responses = await Promise.all([
      admin(`/models/${MODEL}`, 'PUT', { enableAffinity: true }),
      admin(`/models/${MODEL}/backends/b1`, 'PUT', { weight: 7 }),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const stored = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(JSON.parse(stored!.config)).toMatchObject({
      enableAffinity: true,
      backends: [{ id: 'b1', weight: 7 }],
    })
  })

  it('preserves different API key fields updated concurrently', async () => {
    await seed()
    const responses = await Promise.all([
      admin(`/apikeys/${PROXY_KEY}`, 'PUT', { description: 'Changed concurrently' }),
      admin(`/apikeys/${PROXY_KEY}`, 'PUT', { models: ['other-model'] }),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const stored = await env.DB.prepare('SELECT description, models FROM api_keys WHERE key = ?')
      .bind(PROXY_KEY)
      .first<{ description: string; models: string }>()
    expect(stored!.description).toBe('Changed concurrently')
    expect(JSON.parse(stored!.models)).toEqual(['other-model'])
  })

  it('management reads bypass the proxy configuration cache', async () => {
    await seed()
    upstream(() => jsonResponse({ ok: true }))
    await proxy()
    const changed = modelConfig({ enableAffinity: true })
    await env.DB.prepare('UPDATE models SET config = ? WHERE model = ?')
      .bind(JSON.stringify(changed), MODEL)
      .run()
    const body = (await (await admin(`/models/${MODEL}`)).json()) as { model: ModelConfig }
    expect(body.model.enableAffinity).toBe(true)
  })
})

describe('Backend fallback order', () => {
  it('persists reordered stored objects without changing backend fields or affinity', async () => {
    await seed(
      modelConfig({
        enableAffinity: true,
        backends: [
          createTestOpenAIBackend({
            model: 'upstream-model',
            weight: 7,
            streamingTTFTTimeout: 1200,
            nonStreamingTTFTTimeout: 2300,
            recordRequests: true,
            recordResponses: true,
            maxConcurrentRequests: 4,
          }),
          createTestOpenAIBackend({ id: 'b2', connectionId: 'openai-second', weight: 0 }),
          createTestOpenAIBackend({ id: 'order', enabled: false }),
        ],
      })
    )
    await insertAffinity('keep-session', 'b1')
    const before = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    const original = JSON.parse(before!.config) as ModelConfig
    const expected = {
      ...original,
      backends: [original.backends[2], original.backends[0], original.backends[1]],
    }
    const response = await admin(`/models/${MODEL}/backend-order`, 'PUT', {
      backendIds: ['order', 'b1', 'b2'],
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ model: expected })
    const stored = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(JSON.parse(stored!.config)).toEqual(expected)
    expect(await count('affinity_mappings')).toBe(1)
    // A backend named "order" still has an independent backend update route.
    expect((await admin(`/models/${MODEL}/backends/order`, 'PUT', { weight: 2 })).status).toBe(200)
  })

  it('does not revalidate an unchanged legacy backend without a connection', async () => {
    const config = modelConfig({
      backends: [
        createTestOpenAIBackend({ connectionId: undefined }),
        createTestOpenAIBackend({ id: 'b2', connectionId: undefined, weight: 0 }),
      ],
    })
    await env.DB.prepare('INSERT INTO models (model, config) VALUES (?, ?)')
      .bind(MODEL, JSON.stringify(config))
      .run()
    const response = await admin(`/models/${MODEL}/backend-order`, 'PUT', {
      backendIds: ['b2', 'b1'],
    })
    expect(response.status).toBe(200)
    const expected = JSON.parse(
      JSON.stringify({ ...config, backends: [...config.backends].reverse() })
    )
    expect(await response.json()).toEqual({ model: expected })
    const stored = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(JSON.parse(stored!.config)).toEqual(expected)
  })

  it.each([{ backendIds: [] }, { backendIds: ['b1', 'b1'] }])(
    'rejects an empty or duplicate ID list: %j',
    async (body) => {
      await seed()
      const response = await admin(`/models/${MODEL}/backend-order`, 'PUT', body)
      expect(response.status).toBe(400)
      expect(response.headers.get('content-type')).toContain('application/json')
    }
  )

  it('returns 404 for an unknown model', async () => {
    await expectError(
      await admin('/models/missing/backend-order', 'PUT', { backendIds: ['b1'] }),
      404
    )
  })

  it.each([
    { backendIds: ['b1'] },
    { backendIds: ['b1', 'b2', 'extra'] },
    { backendIds: ['b1', 'unknown'] },
  ])('returns 409 for IDs that do not match current backends: %j', async (body) => {
    await seed(
      modelConfig({ backends: [createTestOpenAIBackend(), createTestOpenAIBackend({ id: 'b2' })] })
    )
    const before = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    await expectError(await admin(`/models/${MODEL}/backend-order`, 'PUT', body), 409)
    const after = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(after).toEqual(before)
  })

  it('preserves a backend edit made concurrently with reordering', async () => {
    await seed(
      modelConfig({ backends: [createTestOpenAIBackend(), createTestOpenAIBackend({ id: 'b2' })] })
    )
    const responses = await Promise.all([
      admin(`/models/${MODEL}/backend-order`, 'PUT', { backendIds: ['b2', 'b1'] }),
      admin(`/models/${MODEL}/backends/b1`, 'PUT', { weight: 7 }),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const stored = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
      .bind(MODEL)
      .first<{ config: string }>()
    expect(JSON.parse(stored!.config).backends).toMatchObject([
      { id: 'b2' },
      { id: 'b1', weight: 7 },
    ])
  })

  it('invalidates the proxy cache so fallback follows the new order and wraps around', async () => {
    await seed(
      modelConfig({
        backends: ['b1', 'b2', 'b3'].map((id) => createTestOpenAIBackend({ id, model: id })),
      })
    )
    const calls: string[] = []
    upstream(async (req) => {
      const body = (await req.json()) as { model: string }
      calls.push(body.model)
      return jsonResponse({ error: 'try-next' }, 500)
    })
    expect((await proxy({}, { 'X-Backend-ID': 'b1' })).status).toBe(500)
    expect(calls).toEqual(['b1', 'b2', 'b3'])
    expect(
      (await admin(`/models/${MODEL}/backend-order`, 'PUT', { backendIds: ['b3', 'b2', 'b1'] }))
        .status
    ).toBe(200)
    calls.length = 0
    expect((await proxy({}, { 'X-Backend-ID': 'b1' })).status).toBe(500)
    expect(calls).toEqual(['b1', 'b3', 'b2'])
  })
})

describe('Affinity management', () => {
  it('lists, filters and clears persistent mappings', async () => {
    await seed(modelConfig({ enableAffinity: true }))
    await insertAffinity('s1', 'b1')
    await insertAffinity('s2', 'b2')
    await insertAffinity('s3', 'b1', Date.now(), 'other')
    const all = (await (await admin('/affinity')).json()) as { total: number; mappings: unknown[] }
    expect(all.total).toBe(3)
    const filtered = (await (await admin(`/affinity?model=${MODEL}&backendId=b1`)).json()) as {
      total: number
      mappings: { sessionId: string }[]
    }
    expect(filtered.total).toBe(1)
    expect(filtered.mappings[0].sessionId).toBe('s1')
    const first = await env.DB.prepare(
      'SELECT access_count FROM affinity_mappings WHERE session_id = ?'
    )
      .bind('s1')
      .first<{ access_count: number }>()
    expect((await admin(`/affinity/${MODEL}/s1`)).status).toBe(200)
    const second = await env.DB.prepare(
      'SELECT access_count FROM affinity_mappings WHERE session_id = ?'
    )
      .bind('s1')
      .first<{ access_count: number }>()
    expect(second).toEqual(first)
    expect((await admin('/affinity', 'DELETE')).status).toBe(400)
    const removed = (await (await admin(`/affinity?model=${MODEL}`, 'DELETE')).json()) as {
      deletedCount: number
    }
    expect(removed.deletedCount).toBe(2)
    expect(await count('affinity_mappings')).toBe(1)
    await expectError(await admin(`/affinity/${MODEL}/s1`, 'DELETE'), 404)
    expect((await admin('/affinity/other/s3', 'DELETE')).status).toBe(200)
    expect(await count('affinity_mappings')).toBe(0)
  })
})

describe('Request recording in D1 and R2', () => {
  it('records request bytes and preserves list/read shapes and filtered deletion', async () => {
    await seed(modelConfig({ backends: [createTestOpenAIBackend({ recordRequests: true })] }))
    upstream(() => jsonResponse({ ok: true }))
    await proxy({ messages: [{ role: 'user', content: "Hello 文鳐 ' \\" }] })
    expect(await count('recorded_requests')).toBe(1)
    const response = await admin(`/recorded-requests?backendId=b1&model=${MODEL}`)
    const listed = (await response.json()) as {
      requests: Recorded[]
      total: number
      limit: number
      offset: number
    }
    expect(listed.total).toBe(1)
    expect(listed.limit).toBe(100)
    expect(listed.offset).toBe(0)
    const recorded = listed.requests[0]
    expect(recorded._id).toMatch(/^[\da-f-]{36}$/i)
    expect(recorded.backendId).toBe('b1')
    expect(JSON.parse(recorded.body).messages[0].content).toContain('文鳐')
    expect(await (await env.RECORDINGS.get(`recorded-requests/${recorded._id}`))!.text()).toBe(
      recorded.body
    )
    const detail = (await (await admin(`/recorded-requests/${recorded._id}`)).json()) as {
      request: Recorded
    }
    expect(detail.request).toEqual(recorded)
    await expectError(await admin('/recorded-requests/not-present'), 404)
    await expectError(await admin('/recorded-requests', 'DELETE'), 400)
    const removed = (await (await admin('/recorded-requests?backendId=b1', 'DELETE')).json()) as {
      deletedCount: number
    }
    expect(removed.deletedCount).toBe(1)
    expect(await count('recorded_requests')).toBe(0)
    expect(await env.RECORDINGS.get(`recorded-requests/${recorded._id}`)).toBeNull()
  })
})

describe('Statistics APIs', () => {
  it('aggregates epoch-aligned history buckets with weighted rates and TTFT per model/backend', async () => {
    const minute = Date.UTC(2026, 9, 21, 12)
    await insertStats('b1', {
      minute,
      total: 2,
      success: 1,
      failure: 1,
      streamingSum: 100,
      streamingCount: 1,
      nonStreamingSum: 200,
      nonStreamingCount: 1,
    })
    await insertStats('b1', {
      minute: minute + 60_000,
      total: 10,
      success: 8,
      failure: 2,
      streamingSum: 2700,
      streamingCount: 3,
      nonStreamingSum: 1800,
      nonStreamingCount: 3,
    })
    await insertStats('b1', {
      minute: minute + 5 * 60_000,
      total: 4,
      success: 3,
      failure: 1,
      streamingSum: 1600,
      streamingCount: 2,
      nonStreamingSum: 900,
      nonStreamingCount: 1,
    })
    await insertStats('b2', { minute, total: 30, success: 30 })
    await insertStats('b1', { minute, model: 'other-model', total: 9, success: 9 })
    const startTime = new Date(minute)
    const endTime = new Date(minute + 9 * 60_000)
    const query = new URLSearchParams({
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      intervalMinutes: '5',
    })
    const response = await admin(`/stats/history?${query}`)
    expect(response.status).toBe(200)
    const { history } = (await response.json()) as {
      history: Record<string, Record<string, StatsDataPoint[]>>
    }
    expect(history[MODEL].b1).toEqual([
      {
        model: MODEL,
        backendId: 'b1',
        timestamp: new Date(minute + 5 * 60_000).toISOString(),
        totalRequests: 4,
        successfulRequests: 3,
        failedRequests: 1,
        successRate: 3 / 4,
        averageStreamingTTFT: 800,
        averageNonStreamingTTFT: 900,
        requestsInPeriod: 4,
      },
      {
        model: MODEL,
        backendId: 'b1',
        timestamp: startTime.toISOString(),
        totalRequests: 12,
        successfulRequests: 9,
        failedRequests: 3,
        successRate: 9 / 12,
        averageStreamingTTFT: 700,
        averageNonStreamingTTFT: 500,
        requestsInPeriod: 12,
      },
    ])
    expect(history[MODEL].b2).toMatchObject([{ totalRequests: 30 }])
    expect(history['other-model'].b1).toMatchObject([{ totalRequests: 9 }])
    const single = await admin(`/stats/history/${encodeURIComponent(MODEL)}/b1?${query}`)
    expect(single.status).toBe(200)
    expect(await single.json()).toMatchObject({
      model: MODEL,
      backendId: 'b1',
      dataPoints: history[MODEL].b1,
    })

    // Limit applies after aggregation and preserves bucket DESC, model, backend ordering.
    const limited = await new DbMetricsCollector(env.DB).getHistoricalStats({
      startTime,
      endTime,
      intervalMinutes: 5,
      limit: 3,
    })
    expect(limited.map(({ model, backendId, timestamp }) => [model, backendId, timestamp])).toEqual(
      [
        [MODEL, 'b1', new Date(minute + 5 * 60_000)],
        [MODEL, 'b1', startTime],
        [MODEL, 'b2', startTime],
      ]
    )
  })

  it('includes whole intersecting history buckets at both window boundaries', async () => {
    const minute = Date.UTC(2026, 9, 21, 12)
    for (const [offset, total] of [
      [-1, 100],
      [0, 2],
      [4, 3],
      [5, 5],
      [9, 7],
      [10, 100],
    ]) {
      await insertStats('b1', { minute: minute + offset * 60_000, total, success: total })
    }
    const query = new URLSearchParams({
      startTime: new Date(minute + 2.5 * 60_000).toISOString(),
      endTime: new Date(minute + 6.5 * 60_000).toISOString(),
      intervalMinutes: '5',
    })
    const response = await admin(`/stats/history?${query}`)
    expect(response.status).toBe(200)
    const { history } = (await response.json()) as {
      history: Record<string, Record<string, StatsDataPoint[]>>
    }
    expect(history[MODEL].b1).toMatchObject([
      { timestamp: new Date(minute + 5 * 60_000).toISOString(), requestsInPeriod: 12 },
      { timestamp: new Date(minute).toISOString(), requestsInPeriod: 5 },
    ])
    expect(history[MODEL].b1).toHaveLength(2)
  })

  it('keeps explicit one-minute history identical to the default on both routes', async () => {
    const minute = Date.UTC(2026, 9, 21, 12)
    for (const offset of [-1, 0, 1, 2, 3]) {
      await insertStats('b1', {
        minute: minute + offset * 60_000,
        total: offset + 2,
        success: offset + 2,
      })
    }
    const query = new URLSearchParams({
      startTime: new Date(minute + 30_000).toISOString(),
      endTime: new Date(minute + 2 * 60_000).toISOString(),
    })
    for (const path of ['/stats/history', `/stats/history/${encodeURIComponent(MODEL)}/b1`]) {
      const defaultResponse = await admin(`${path}?${query}`)
      const explicitResponse = await admin(`${path}?${query}&intervalMinutes=1`)
      expect(defaultResponse.status).toBe(200)
      expect(explicitResponse.status).toBe(200)
      const defaultBody = await defaultResponse.json()
      expect(await explicitResponse.json()).toEqual(defaultBody)
      const { dataPoints, history } = defaultBody as {
        dataPoints?: StatsDataPoint[]
        history?: Record<string, Record<string, StatsDataPoint[]>>
      }
      expect((dataPoints ?? history![MODEL].b1).map((point) => point.timestamp)).toEqual(
        [2, 1, 0].map((offset) => new Date(minute + offset * 60_000).toISOString())
      )
    }
  })

  it('accepts a history interval equal to the 30-day retention period', async () => {
    const minute = Date.UTC(2026, 9, 21, 12)
    await insertStats('b1', { minute })
    const query = new URLSearchParams({
      startTime: new Date(minute).toISOString(),
      endTime: new Date(minute).toISOString(),
      intervalMinutes: '43200',
    })
    const response = await admin(`/stats/history/${encodeURIComponent(MODEL)}/b1?${query}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      dataPoints: [
        { timestamp: new Date(Math.floor(minute / 2_592_000_000) * 2_592_000_000).toISOString() },
      ],
    })
  })

  it.each(['0', '-1', '1.5', 'abc', '43201'])(
    'rejects invalid history intervalMinutes=%s with a JSON error on both routes',
    async (intervalMinutes) => {
      for (const path of ['/stats/history', `/stats/history/${encodeURIComponent(MODEL)}/b1`]) {
        await expectError(await admin(`${path}?intervalMinutes=${intervalMinutes}`), 400)
      }
    }
  )

  it('separates proxy metrics for shared backend IDs across models and deletes only the requested pair', async () => {
    const models = ['vendor/model.v1', 'other/model.v2%2F']
    const backendId = 'azure'
    await seed(
      modelConfig({ model: models[0], backends: [createTestOpenAIBackend({ id: backendId })] }),
      models
    )
    expect(
      (
        await admin(
          '/models',
          'POST',
          modelConfig({
            model: models[1],
            backends: [createTestOpenAIBackend({ id: backendId })],
          })
        )
      ).status
    ).toBe(201)
    upstream(async (request) => {
      const body = (await request.json()) as { model: string }
      return jsonResponse({ model: body.model }, body.model === models[0] ? 200 : 502)
    })
    expect((await proxy({ model: models[0] })).status).toBe(200)
    expect((await proxy({ model: models[1] })).status).toBe(502)
    expect(
      (
        await env.DB.prepare(
          'SELECT model, backend_id, total, success, failure FROM backend_stats_minute ORDER BY model'
        ).all()
      ).results
    ).toEqual([
      { model: models[1], backend_id: backendId, total: 1, success: 0, failure: 1 },
      { model: models[0], backend_id: backendId, total: 1, success: 1, failure: 0 },
    ])
    const all = (await (await admin('/stats')).json()) as { stats: BackendStats[] }
    expect(
      all.stats.map(({ model, backendId, totalRequests }) => ({ model, backendId, totalRequests }))
    ).toEqual([models[1], models[0]].map((model) => ({ model, backendId, totalRequests: 1 })))
    const history = (await (await admin('/stats/history')).json()) as {
      history: Record<string, Record<string, StatsDataPoint[]>>
    }
    for (const model of models) {
      expect(history.history[model][backendId]).toHaveLength(1)
      expect(history.history[model][backendId][0]).toMatchObject({
        model,
        backendId,
        totalRequests: 1,
      })
      const path = `${encodeURIComponent(model)}/${encodeURIComponent(backendId)}`
      const statsResponse = await admin(`/stats/${path}`)
      expect(statsResponse.status).toBe(200)
      const stats = (await statsResponse.json()) as { stats: BackendStats }
      expect(stats.stats).toMatchObject({
        model,
        backendId,
        totalRequests: 1,
        successfulRequests: model === models[0] ? 1 : 0,
      })
      const historicalResponse = await admin(`/stats/history/${path}`)
      expect(historicalResponse.status).toBe(200)
      const historical = (await historicalResponse.json()) as {
        model: string
        backendId: string
        dataPoints: StatsDataPoint[]
      }
      expect(historical).toMatchObject({ model, backendId })
      expect(historical.dataPoints).toHaveLength(1)
      expect(historical.dataPoints[0]).toMatchObject({ model, backendId, totalRequests: 1 })
    }
    const path = `${encodeURIComponent(models[0])}/${backendId}`
    const removed = (await (await admin(`/stats/${path}`, 'DELETE')).json()) as {
      deletedCount: number
    }
    expect(removed.deletedCount).toBe(1)
    await expectError(await admin(`/stats/${path}`), 404)
    expect(await (await admin(`/stats/history/${path}`)).json()).toMatchObject({
      model: models[0],
      backendId,
      dataPoints: [],
    })
    expect((await admin(`/stats/${encodeURIComponent(models[1])}/${backendId}`)).status).toBe(200)
    const remaining = (await (await admin('/stats/history')).json()) as typeof history
    expect(Object.keys(remaining.history)).toEqual([models[1]])
    expect(await count('backend_stats_minute')).toBe(1)
    expect((await admin('/stats', 'DELETE')).status).toBe(200)
    expect(await count('backend_stats_minute')).toBe(0)
  })

  it('supports encoded slash parameters, colliding display names and prototype-like history keys', async () => {
    const identities = [
      { model: 'a/b.v1', backendId: 'c' },
      { model: 'a', backendId: 'b.v1/c' },
      { model: '__proto__', backendId: 'constructor' },
      { model: 'constructor', backendId: '__proto__' },
    ]
    for (const { model, backendId } of identities) await insertStats(backendId, { model })
    const all = (await (await admin('/stats/history')).json()) as {
      history: Record<string, Record<string, StatsDataPoint[]>>
    }
    for (const { model, backendId } of identities) {
      expect(all.history[model][backendId]).toHaveLength(1)
      const path = `${encodeURIComponent(model)}/${encodeURIComponent(backendId)}`
      expect(await (await admin(`/stats/${path}`)).json()).toMatchObject({
        stats: { model, backendId },
      })
      expect(await (await admin(`/stats/history/${path}`)).json()).toMatchObject({
        model,
        backendId,
        dataPoints: [{ model, backendId }],
      })
    }
    expect((await admin('/stats/a/b.v1%2Fc', 'DELETE')).status).toBe(200)
    expect(await count('backend_stats_minute')).toBe(3)
    expect((await admin('/stats/a%2Fb.v1/c')).status).toBe(200)
  })

  it('removes the old single-parameter statistics routes', async () => {
    await insertStats('b1')
    for (const path of ['/stats/b1', '/stats/history/b1']) await expectError(await admin(path), 404)
    await expectError(await admin('/stats/b1', 'DELETE'), 404)
    expect(await count('backend_stats_minute')).toBe(1)
  })

  it('returns and resets stats and history without instanceId', async () => {
    await insertStats('b1', {
      streamingSum: 300,
      streamingCount: 2,
      nonStreamingSum: 900,
      nonStreamingCount: 3,
    })
    const stats = (await (await admin(`/stats/${encodeURIComponent(MODEL)}/b1`)).json()) as {
      stats: { averageStreamingTTFT: number; averageNonStreamingTTFT: number }
    }
    expect(stats.stats.averageStreamingTTFT).toBe(150)
    expect(stats.stats.averageNonStreamingTTFT).toBe(300)
    const history = (await (
      await admin(`/stats/history/${encodeURIComponent(MODEL)}/b1`)
    ).json()) as {
      dataPoints: Record<string, unknown>[]
    }
    expect(history.dataPoints).toHaveLength(1)
    expect(history.dataPoints[0]).not.toHaveProperty('instanceId')
    const allHistory = (await (await admin('/stats/history')).json()) as {
      history: Record<string, { b1: unknown[] }>
    }
    expect(allHistory.history[MODEL].b1).toHaveLength(1)
    const removed = (await (
      await admin(`/stats/${encodeURIComponent(MODEL)}/b1`, 'DELETE')
    ).json()) as { deletedCount: number }
    expect(removed.deletedCount).toBe(1)
    await expectError(await admin(`/stats/${encodeURIComponent(MODEL)}/b1`), 404)
    await insertStats('b2')
    expect((await admin('/stats', 'DELETE')).status).toBe(200)
    expect(await count('backend_stats_minute')).toBe(0)
  })

  it('retains every existing Prometheus metric name', async () => {
    await seed()
    await insertStats('b1')
    const response = await admin('/metrics')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    const text = await response.text()
    for (const name of [
      'llm_proxy_requests_total',
      'llm_proxy_request_duration_seconds_count',
      'llm_proxy_ttft_seconds_sum',
      'llm_proxy_ttft_seconds_count',
      'llm_proxy_success_rate',
      'llm_proxy_active_requests',
    ])
      expect(text).toContain(name)
    expect(text).toContain('backend_id="b1"')
    expect(text).toContain(`model="${MODEL}"`)
  })

  it('exports model labels for enabled pairs plus recent data without mixing shared backend IDs', async () => {
    const model = 'vendor/model.v1'
    await seed(
      modelConfig({
        model,
        backends: [
          createTestOpenAIBackend({ id: 'azure' }),
          createTestOpenAIBackend({ id: 'idle', weight: 0 }),
          createTestOpenAIBackend({ id: 'disabled', enabled: false }),
          createTestOpenAIBackend({ id: 'recent-disabled', enabled: false }),
        ],
      })
    )
    expect(
      (
        await admin(
          '/models',
          'POST',
          modelConfig({
            model: 'other/model.v2',
            backends: [createTestOpenAIBackend({ id: 'azure' })],
          })
        )
      ).status
    ).toBe(201)
    await insertStats('azure', {
      model,
      total: 2,
      success: 1,
      failure: 1,
      streamingSum: 300,
      streamingCount: 2,
      nonStreamingSum: 600,
      nonStreamingCount: 3,
    })
    await insertStats('azure', { model: 'other/model.v2', total: 9, success: 9 })
    await insertStats('recent-disabled', { model })
    await insertStats('removed', { model: 'archived' })
    await insertStats('stale', {
      model: 'archived',
      minute: Math.floor(Date.now() / 60_000) * 60_000 - 120_000,
    })
    const text = await (await admin('/metrics')).text()
    const pairs = [
      `model="${model}",backend_id="azure"`,
      `model="${model}",backend_id="idle"`,
      `model="${model}",backend_id="recent-disabled"`,
      'model="other/model.v2",backend_id="azure"',
      'model="archived",backend_id="removed"',
    ]
    for (const name of [
      'llm_proxy_requests_total',
      'llm_proxy_request_duration_seconds_count',
      'llm_proxy_ttft_seconds_sum',
      'llm_proxy_ttft_seconds_count',
      'llm_proxy_success_rate',
    ]) {
      const lines = text.split('\n').filter((line) => line.startsWith(`${name}{`))
      expect(lines).toHaveLength(
        pairs.length * (name.includes('ttft') || name === 'llm_proxy_requests_total' ? 2 : 1)
      )
      for (const pair of pairs)
        expect(lines.some((line) => line.startsWith(`${name}{${pair}`))).toBe(true)
    }
    expect(text).toContain(
      `llm_proxy_requests_total{model="${model}",backend_id="azure",status="success"} 1`
    )
    expect(text).toContain(
      'llm_proxy_requests_total{model="other/model.v2",backend_id="azure",status="success"} 9'
    )
    expect(text).toContain(
      `llm_proxy_request_duration_seconds_count{model="${model}",backend_id="azure"} 2`
    )
    expect(text).toContain(
      `llm_proxy_ttft_seconds_sum{model="${model}",backend_id="azure",stream_type="streaming"} 0.300`
    )
    expect(text).toContain(
      `llm_proxy_ttft_seconds_count{model="${model}",backend_id="azure",stream_type="non-streaming"} 3`
    )
    expect(text).toContain(`llm_proxy_success_rate{model="${model}",backend_id="azure"} 0.5000`)
    expect(text).toContain(
      `llm_proxy_requests_total{model="${model}",backend_id="idle",status="success"} 0`
    )
    expect(text).not.toContain('backend_id="disabled"')
    expect(text).not.toContain('backend_id="stale"')
  })

  it('escapes model and backend labels in Prometheus output', async () => {
    await insertStats('back"\\\nend', { model: 'model"\\\nname' })
    const text = await (await admin('/metrics')).text()
    expect(text).toContain(
      'llm_proxy_requests_total{model="model\\"\\\\\\nname",backend_id="back\\"\\\\\\nend",status="success"} 20'
    )
  })
})
