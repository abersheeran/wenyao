import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import {
  admin,
  count,
  createTestOpenAIBackend,
  insertAffinity,
  insertStats,
  MODEL,
  modelConfig,
  seed,
} from './helpers.js'
import worker from '../index.js'
import { ConcurrencyLimiter } from '../services/concurrency-limiter.js'
import { ConfigManager } from '../services/config-manager.js'
import { LoadBalancer } from '../services/load-balancer.js'
import { DbMetricsCollector } from '../services/metrics/db-collector.js'

import type { RequestCompleteData } from '../services/metrics/types.js'

function completion(overrides: Partial<RequestCompleteData> = {}): RequestCompleteData {
  return {
    model: MODEL,
    backendId: 'b1',
    requestId: crypto.randomUUID(),
    status: 'success',
    duration: 500,
    ...overrides,
  }
}

describe('Durable Object active-request monitoring', () => {
  it('reports DO counts only for enabled backends with a positive concurrency limit', async () => {
    const limited = createTestOpenAIBackend({ maxConcurrentRequests: 3 })
    await seed(
      modelConfig({
        backends: [
          limited,
          createTestOpenAIBackend({ id: 'unlimited' }),
          createTestOpenAIBackend({ id: 'zero-limit', maxConcurrentRequests: 0 }),
          createTestOpenAIBackend({
            id: 'disabled',
            enabled: false,
            maxConcurrentRequests: 3,
          }),
        ],
      })
    )
    const limiter = new ConcurrencyLimiter(env.CONCURRENCY)
    expect(await limiter.tryAcquire(limited, 'first')).toBe(true)
    expect(await limiter.tryAcquire(limited, 'second')).toBe(true)
    const result = (await (await admin('/active-requests')).json()) as {
      activeRequests: Record<string, unknown>
    }
    expect(result.activeRequests).toEqual({
      b1: {
        backendId: 'b1',
        model: MODEL,
        activeCount: 2,
        maxConcurrent: 3,
        utilizationPercent: 67,
      },
    })
    const metrics = await (await admin('/metrics')).text()
    expect(
      metrics.split('\n').filter((line) => line.startsWith('llm_proxy_active_requests{'))
    ).toEqual(['llm_proxy_active_requests{backend_id="b1"} 2'])
    await limiter.release('b1', 'first')
    const released = (await (await admin('/active-requests')).json()) as {
      activeRequests: Record<string, { activeCount: number }>
    }
    expect(released.activeRequests.b1.activeCount).toBe(1)
  })
})

describe('D1 minute aggregates', () => {
  it('keeps tuple identities distinct when slash-joined model/backend names would collide', async () => {
    const collector = new DbMetricsCollector(env.DB)
    await env.DB.batch([
      collector.completionStatement(completion({ model: 'a/b.v1', backendId: 'c' })),
      collector.completionStatement(
        completion({ model: 'a', backendId: 'b.v1/c', status: 'failure' })
      ),
    ])
    const stats = await collector.getRecentStatsMap(60_000)
    expect(stats.get('a/b.v1')!.get('c')).toMatchObject({
      model: 'a/b.v1',
      backendId: 'c',
      successfulRequests: 1,
      failedRequests: 0,
    })
    expect(stats.get('a')!.get('b.v1/c')).toMatchObject({
      model: 'a',
      backendId: 'b.v1/c',
      successfulRequests: 0,
      failedRequests: 1,
    })
    expect(await collector.getRecentStats('missing', 'c', 60_000)).toEqual({
      model: 'missing',
      backendId: 'c',
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      successRate: 0,
      averageStreamingTTFT: 0,
      averageNonStreamingTTFT: 0,
      ttftSamples: [],
    })
  })

  it('upserts success/failure and uses stream-specific sample counts for TTFT averages', async () => {
    const collector = new DbMetricsCollector(env.DB)
    const data = [
      completion({ ttft: 100, streamType: 'streaming' }),
      completion({ ttft: 300, streamType: 'streaming' }),
      completion({ ttft: 900, streamType: 'non-streaming' }),
      completion({ status: 'failure' }),
    ]
    await env.DB.batch(data.map((item) => collector.completionStatement(item)))
    const stats = await collector.getRecentStats(MODEL, 'b1', 60_000)
    expect(stats).toMatchObject({
      model: MODEL,
      backendId: 'b1',
      totalRequests: 4,
      successfulRequests: 3,
      failedRequests: 1,
      successRate: 0.75,
      averageStreamingTTFT: 200,
      averageNonStreamingTTFT: 900,
    })
    expect(await count('backend_stats_minute')).toBe(1)
  })

  it('aggregates TTFT sums and sample counts across minute buckets', async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    await insertStats('b1', {
      minute: minute - 60_000,
      total: 100,
      success: 100,
      streamingSum: 100,
      streamingCount: 1,
      nonStreamingSum: 900,
      nonStreamingCount: 3,
    })
    await insertStats('b1', {
      minute,
      total: 2,
      success: 2,
      streamingSum: 900,
      streamingCount: 3,
      nonStreamingSum: 500,
      nonStreamingCount: 1,
    })
    const stats = await new DbMetricsCollector(env.DB).getRecentStats(MODEL, 'b1', 120_000)
    expect(stats.totalRequests).toBe(102)
    expect(stats.averageStreamingTTFT).toBe(250)
    expect(stats.averageNonStreamingTTFT).toBe(350)
  })

  it('includes every minute bucket intersecting the requested window and excludes both neighbors', async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    for (let i = -2; i <= 2; i++)
      await insertStats('b1', { minute: minute + i * 60_000, total: i + 3, success: i + 3 })
    const collector = new DbMetricsCollector(env.DB)
    const stats = await collector.getStats(MODEL, 'b1', {
      startTime: new Date(minute - 30_000),
      endTime: new Date(minute + 30_000),
    })
    expect(stats.totalRequests).toBe(5) // previous minute (2) and current minute (3)
    const exact = await collector.getStats(MODEL, 'b1', {
      startTime: new Date(minute),
      endTime: new Date(minute),
    })
    expect(exact.totalRequests).toBe(3)
  })

  it('fetches all backend aggregates with one GROUP BY and caches ordinary data for 15 seconds', async () => {
    await insertStats('b1')
    await insertStats('b2')
    const collector = new DbMetricsCollector(env.DB)
    const query = vi.spyOn(collector, 'getAllStats')
    const first = await collector.getRecentStatsMap(900_000)
    expect([...first.keys()]).toEqual([MODEL])
    expect([...first.get(MODEL)!.keys()].sort()).toEqual(['b1', 'b2'])
    await env.DB.prepare(
      'UPDATE backend_stats_minute SET total = 99 WHERE model = ? AND backend_id = ?'
    )
      .bind(MODEL, 'b1')
      .run()
    expect(
      (await new DbMetricsCollector(env.DB).getRecentStatsMap(900_000)).get(MODEL)!.get('b1')!
        .totalRequests
    ).toBe(20)
    expect(query).toHaveBeenCalledOnce()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 15_001)
    expect((await collector.getRecentStatsMap(900_000)).get(MODEL)!.get('b1')!.totalRequests).toBe(
      99
    )
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe('Load balancing with real D1 statistics', () => {
  const backends = [createTestOpenAIBackend({ id: 'b1' }), createTestOpenAIBackend({ id: 'b2' })]

  it.each(['lowest-ttft', 'min-error-rate'] as const)(
    '%s ignores extreme statistics for the same backend IDs in another model',
    async (strategy) => {
      const collector = new DbMetricsCollector(env.DB)
      const lb = new LoadBalancer(collector)
      const model = modelConfig({ backends, loadBalancingStrategy: strategy })
      await insertStats('b1', {
        total: 100,
        success: 100,
        streamingSum: 100,
        streamingCount: 1,
        nonStreamingSum: 100,
        nonStreamingCount: 1,
      })
      await insertStats('b2', {
        total: 100,
        success: 0,
        failure: 100,
        streamingSum: 900,
        streamingCount: 1,
        nonStreamingSum: 900,
        nonStreamingCount: 1,
      })
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      expect((await lb.selectBackend(model, undefined, true))!.id).toBe('b1')

      const otherModel = 'vendor/other.v1'
      await insertStats('b1', {
        model: otherModel,
        total: 10_000,
        success: 0,
        failure: 10_000,
        streamingSum: 1e12,
        streamingCount: 10_000,
        nonStreamingSum: 1e12,
        nonStreamingCount: 10_000,
      })
      await insertStats('b2', {
        model: otherModel,
        total: 10_000,
        success: 10_000,
        streamingSum: 1,
        streamingCount: 10_000,
        nonStreamingSum: 1,
        nonStreamingCount: 10_000,
      })
      // Expire the shared cache so the new model's data is part of the same query.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_001)
      expect((await lb.selectBackend(model, undefined, true))!.id).toBe('b1')
      expect((await lb.selectBackend(model, undefined, false))!.id).toBe('b1')
      expect((await lb.selectBackend({ ...model, model: otherModel }, undefined, true))!.id).toBe(
        'b2'
      )
    }
  )

  it('lowest-ttft uses the request stream type', async () => {
    await insertStats('b1', {
      streamingSum: 100,
      streamingCount: 1,
      nonStreamingSum: 900,
      nonStreamingCount: 1,
    })
    await insertStats('b2', {
      streamingSum: 900,
      streamingCount: 1,
      nonStreamingSum: 100,
      nonStreamingCount: 1,
    })
    const lb = new LoadBalancer(new DbMetricsCollector(env.DB))
    const model = modelConfig({ backends, loadBalancingStrategy: 'lowest-ttft' })
    expect((await lb.selectBackend(model, undefined, true))!.id).toBe('b1')
    expect((await lb.selectBackend(model, undefined, false))!.id).toBe('b2')
  })

  it('min-error-rate weights inverse error rates using the configured weights', async () => {
    await insertStats('b1', { total: 100, success: 50, failure: 50 })
    await insertStats('b2', { total: 100, success: 90, failure: 10 })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const model = modelConfig({ backends, loadBalancingStrategy: 'min-error-rate' })
    const lb = new LoadBalancer(new DbMetricsCollector(env.DB))
    expect((await lb.selectBackend(model))!.id).toBe('b2')
  })

  it('circuit breaks backends above the error threshold when samples are sufficient', async () => {
    await insertStats('b1', { total: 100, success: 0, failure: 100 })
    await insertStats('b2', { total: 100, success: 50, failure: 50 })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const model = modelConfig({ backends, loadBalancingStrategy: 'min-error-rate' })
    const lb = new LoadBalancer(new DbMetricsCollector(env.DB))
    expect((await lb.selectBackend(model))!.id).toBe('b2')
  })

  it('retains weighted fallback if every backend is circuit broken', async () => {
    await insertStats('b1', { total: 100, success: 0, failure: 100 })
    await insertStats('b2', { total: 100, success: 0, failure: 100 })
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const lb = new LoadBalancer(new DbMetricsCollector(env.DB))
    expect(
      (await lb.selectBackend(modelConfig({ backends, loadBalancingStrategy: 'min-error-rate' })))!
        .id
    ).toBe('b2')
  })
})

describe('Configuration TTL and failure fallback', () => {
  it('holds parsed data for 10 seconds and refreshes using one batch', async () => {
    await seed()
    const manager = new ConfigManager(env.DB)
    const first = await manager.getSnapshot()
    expect(first.models[0].model).toBe(MODEL)
    await env.DB.prepare('DELETE FROM models').run()
    expect((await manager.getSnapshot()).models).toHaveLength(1)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_001)
    expect((await manager.getSnapshot()).models).toEqual([])
  })
})

describe('Configuration compare-and-swap writes', () => {
  function conflictingDatabase(failures: number) {
    let attempts = 0
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            if (query.startsWith('UPDATE models SET config = ?')) {
              attempts++
              // Exercise a genuine zero-row D1 UPDATE without changing the stored document.
              if (attempts <= failures) return target.prepare(`${query} AND 0`)
            }
            return target.prepare(query)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { database, attempts: () => attempts }
  }

  it('returns 409 after exactly three conflicting writes without changing the model', async () => {
    await seed()
    const { database, attempts } = conflictingDatabase(3)
    await expect(
      new ConfigManager(database).updateModelConfig(MODEL, { enableAffinity: true })
    ).rejects.toMatchObject({ status: 409 })
    expect(attempts()).toBe(3)
    expect((await new ConfigManager(env.DB).getModelConfig(MODEL))!.enableAffinity).not.toBe(true)
  })

  it('does not clear backend affinity when all three delete attempts conflict', async () => {
    await seed()
    await insertAffinity('session', 'b1')
    const { database, attempts } = conflictingDatabase(3)
    await expect(
      new ConfigManager(database).deleteBackendFromModel(MODEL, 'b1')
    ).rejects.toMatchObject({ status: 409 })
    expect(attempts()).toBe(3)
    expect(await count('affinity_mappings')).toBe(1)
    expect((await new ConfigManager(env.DB).getModelConfig(MODEL))!.backends).toHaveLength(1)
  })

  it('can succeed on the third CAS and clears only the removed backend affinity', async () => {
    await seed()
    await insertAffinity('removed-backend', 'b1')
    await insertAffinity('other-backend', 'b2')
    const { database, attempts } = conflictingDatabase(2)
    const updated = await new ConfigManager(database).deleteBackendFromModel(MODEL, 'b1')
    expect(attempts()).toBe(3)
    expect(updated.backends).toEqual([])
    const rows = await env.DB.prepare('SELECT session_id FROM affinity_mappings').all<{
      session_id: string
    }>()
    expect(rows.results).toEqual([{ session_id: 'other-backend' }])
  })
})

describe('Configuration refresh failures', () => {
  it('uses an existing snapshot on refresh failure and rejects with 503 when none exists', async () => {
    await seed()
    const manager = new ConfigManager(env.DB)
    const cached = await manager.getSnapshot()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_001)
    vi.spyOn(env.DB, 'batch').mockRejectedValue(new Error('Local simulated D1 outage'))
    expect(await manager.getSnapshot()).toEqual(cached)
    manager.invalidate()
    expect(await manager.getSnapshot()).toEqual(cached)
    const uncachedDatabase = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: env.DB.batch.bind(env.DB),
    } as D1Database
    await expect(new ConfigManager(uncachedDatabase).getSnapshot()).rejects.toMatchObject({
      status: 503,
    })
  })
})

describe('Scheduled expiration', () => {
  it('cleans expired affinity and metrics while retaining recent data and recordings', async () => {
    const now = Date.now()
    await insertAffinity('old', 'b1', now - 3_600_001)
    await insertAffinity('new', 'b1', now)
    await insertStats('b1', { minute: Math.floor((now - 31 * 86_400_000) / 60_000) * 60_000 })
    await insertStats('b1')
    await insertStats('b1', {
      model: 'other/model',
      minute: Math.floor((now - 31 * 86_400_000) / 60_000) * 60_000,
    })
    await insertStats('b1', { model: 'other/model' })
    await env.DB.prepare(
      'INSERT INTO recorded_requests (id, backend_id, model, timestamp, url, headers) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind('recording', 'b1', MODEL, now - 31 * 86_400_000, 'https://upstream.example', '{}')
      .run()
    await env.RECORDINGS.put('recorded-requests/recording', 'body')
    const context = createExecutionContext()
    await worker.scheduled(
      createScheduledController({ scheduledTime: now, cron: '*/5 * * * *' }),
      env,
      context
    )
    await waitOnExecutionContext(context)
    expect(await count('affinity_mappings')).toBe(1)
    expect(
      (
        await env.DB.prepare(
          'SELECT model, backend_id FROM backend_stats_minute ORDER BY model'
        ).all()
      ).results
    ).toEqual([
      { model: MODEL, backend_id: 'b1' },
      { model: 'other/model', backend_id: 'b1' },
    ])
    expect(await count('recorded_requests')).toBe(1)
    expect(await env.RECORDINGS.get('recorded-requests/recording')).not.toBeNull()
  })
})
