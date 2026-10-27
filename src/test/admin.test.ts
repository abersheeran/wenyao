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

import type { ApiKey } from '../types/apikey.js'
import type { ModelConfig, RecordedRequest } from '../types/backend.js'

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
  it('returns and resets stats and history without instanceId', async () => {
    await insertStats('b1', {
      streamingSum: 300,
      streamingCount: 2,
      nonStreamingSum: 900,
      nonStreamingCount: 3,
    })
    const stats = (await (await admin('/stats/b1')).json()) as {
      stats: { averageStreamingTTFT: number; averageNonStreamingTTFT: number }
    }
    expect(stats.stats.averageStreamingTTFT).toBe(150)
    expect(stats.stats.averageNonStreamingTTFT).toBe(300)
    const history = (await (await admin('/stats/history/b1')).json()) as {
      dataPoints: Record<string, unknown>[]
    }
    expect(history.dataPoints).toHaveLength(1)
    expect(history.dataPoints[0]).not.toHaveProperty('instanceId')
    const allHistory = (await (await admin('/stats/history')).json()) as {
      history: { b1: unknown[] }
    }
    expect(allHistory.history.b1).toHaveLength(1)
    const removed = (await (await admin('/stats/b1', 'DELETE')).json()) as { deletedCount: number }
    expect(removed.deletedCount).toBe(1)
    await expectError(await admin('/stats/b1'), 404)
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
  })
})
