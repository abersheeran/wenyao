import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import {
  admin,
  createTestOpenAIBackend,
  insertStats,
  MODEL,
  modelConfig,
  seedConnections,
} from './helpers.js'
import { ConfigManager } from '../services/config-manager.js'
import { LoadBalancer } from '../services/load-balancer.js'
import { DbMetricsCollector } from '../services/metrics/db-collector.js'

import type { MinErrorRateOptions, ModelConfig } from '../types/backend.js'

const options: MinErrorRateOptions = {
  minRequests: 5,
  circuitBreakerThreshold: 0.4,
  epsilon: 0.01,
  timeWindowMinutes: 30,
}

async function storedOptions(): Promise<MinErrorRateOptions | undefined> {
  const row = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
    .bind(MODEL)
    .first<{ config: string }>()
  return (JSON.parse(row!.config) as ModelConfig).minErrorRateOptions
}

function create(minErrorRateOptions: unknown, model = MODEL): Promise<Response> {
  return admin('/models', 'POST', {
    ...modelConfig({ model, backends: [], loadBalancingStrategy: 'min-error-rate' }),
    minErrorRateOptions,
  })
}

describe('min-error-rate options', () => {
  it('persists options on creation and replaces them as a whole on update', async () => {
    const created = await create(options)
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ model: { minErrorRateOptions: options } })
    expect(await storedOptions()).toEqual(options)
    expect(await (await admin(`/models/${MODEL}`)).json()).toMatchObject({
      model: { minErrorRateOptions: options },
    })

    // Fields edited without options keep the stored options.
    expect((await admin(`/models/${MODEL}`, 'PUT', { enableAffinity: true })).status).toBe(200)
    expect(await storedOptions()).toEqual(options)

    const updated = await admin(`/models/${MODEL}`, 'PUT', {
      minErrorRateOptions: { minRequests: 50 },
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      model: { minErrorRateOptions: { minRequests: 50 } },
    })
    expect(await storedOptions()).toEqual({ minRequests: 50 })
  })

  it('accepts boundary values', async () => {
    const boundary = {
      minRequests: 1,
      circuitBreakerThreshold: 1,
      epsilon: 1e-9,
      timeWindowMinutes: 43200,
    }
    expect((await create(boundary)).status).toBe(201)
    expect(await storedOptions()).toEqual(boundary)
    expect(
      (
        await admin(`/models/${MODEL}`, 'PUT', {
          minErrorRateOptions: { circuitBreakerThreshold: 0 },
        })
      ).status
    ).toBe(200)
    expect(await storedOptions()).toEqual({ circuitBreakerThreshold: 0 })
  })

  it.each([
    { minRequests: 0 },
    { minRequests: 1.5 },
    { circuitBreakerThreshold: -0.1 },
    { circuitBreakerThreshold: 1.1 },
    { epsilon: 0 },
    { epsilon: -0.001 },
    { timeWindowMinutes: 0 },
    { timeWindowMinutes: 1.5 },
    { timeWindowMinutes: 43201 },
    { minRequests: '20' },
  ])('rejects invalid options %o on create and update', async (invalid) => {
    expect((await create(invalid, 'invalid')).status).toBe(400)
    expect((await create(options)).status).toBe(201)
    expect((await admin(`/models/${MODEL}`, 'PUT', { minErrorRateOptions: invalid })).status).toBe(
      400
    )
    expect(await storedOptions()).toEqual(options)
  })

  it('applies options saved through the admin API to backend selection', async () => {
    await seedConnections()
    const backends = [
      createTestOpenAIBackend({ id: 'b1' }),
      createTestOpenAIBackend({ id: 'b2', connectionId: 'openai-second' }),
    ]
    await insertStats('b1', { total: 100, success: 50, failure: 50 })
    await insertStats('b2', { total: 100, success: 90, failure: 10 })
    // With a zero draw the first eligible backend wins, so b1 is chosen unless it is circuit broken.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const lb = new LoadBalancer(new DbMetricsCollector(env.DB))
    const select = async () => {
      const { models } = await new ConfigManager(env.DB).getSnapshot()
      return (await lb.selectBackend(models.find((model) => model.model === MODEL)!))!.id
    }

    const config = modelConfig({ backends, loadBalancingStrategy: 'min-error-rate' })
    expect((await admin('/models', 'POST', config)).status).toBe(201)
    expect(await select()).toBe('b1')

    expect(
      (
        await admin(`/models/${MODEL}`, 'PUT', {
          minErrorRateOptions: { circuitBreakerThreshold: 0.4 },
        })
      ).status
    ).toBe(200)
    expect(await select()).toBe('b2')
  })
})
