import { AwsV4Signer } from 'aws4fetch'
import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import {
  admin,
  createTestBedrockBackend,
  createTestOpenAIBackend,
  jsonResponse,
  MODEL,
  modelConfig,
  proxy,
  seed,
  upstream,
} from './helpers.js'
import { ConfigManager } from '../services/config-manager.js'

async function seedSharedConnection(): Promise<void> {
  await seed(modelConfig(), [MODEL, 'other-model'])
  expect(
    (
      await admin(
        '/models',
        'POST',
        modelConfig({ model: 'other-model', backends: [createTestOpenAIBackend({ id: 'other' })] })
      )
    ).status
  ).toBe(201)
}

describe('Shared connections in proxy snapshots', () => {
  it('rotates one connection key for backends in two models after a management write', async () => {
    await seedSharedConnection()
    const calls: { model: string; authorization: string | null }[] = []
    upstream(async (request) => {
      const body = (await request.json()) as { model: string }
      calls.push({ model: body.model, authorization: request.headers.get('authorization') })
      return jsonResponse({ ok: true })
    })
    for (const model of [MODEL, 'other-model']) expect((await proxy({ model })).status).toBe(200)
    expect(
      (
        await admin('/connections/openai-test', 'PUT', {
          openaiConfig: { url: 'https://b1.example', apiKey: 'rotated-secret' },
        })
      ).status
    ).toBe(200)
    for (const model of [MODEL, 'other-model']) expect((await proxy({ model })).status).toBe(200)
    expect(calls).toEqual([
      { model: MODEL, authorization: 'Bearer upstream-secret' },
      { model: 'other-model', authorization: 'Bearer upstream-secret' },
      { model: MODEL, authorization: 'Bearer rotated-secret' },
      { model: 'other-model', authorization: 'Bearer rotated-secret' },
    ])
  })

  it('refreshes shared connection credentials after the 10 second TTL in one three-table batch', async () => {
    await seedSharedConnection()
    const keys: (string | null)[] = []
    upstream((request) => {
      keys.push(request.headers.get('authorization'))
      return jsonResponse({ ok: true })
    })
    expect((await proxy()).status).toBe(200)
    await env.DB.prepare('UPDATE connections SET config = ? WHERE id = ?')
      .bind(
        JSON.stringify({ url: 'https://b1.example', apiKey: 'external-rotation' }),
        'openai-test'
      )
      .run()
    expect((await proxy({ model: 'other-model' })).status).toBe(200)
    const batch = vi.spyOn(env.DB, 'batch')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001)
    const snapshot = await new ConfigManager(env.DB).getSnapshot()
    expect(batch).toHaveBeenCalledOnce()
    expect(batch.mock.calls[0][0]).toHaveLength(3)
    expect(
      snapshot.models.every(
        (model) => model.backends[0].openaiConfig?.apiKey === 'external-rotation'
      )
    ).toBe(true)
    for (const model of [MODEL, 'other-model']) expect((await proxy({ model })).status).toBe(200)
    expect(keys).toEqual([
      'Bearer upstream-secret',
      'Bearer upstream-secret',
      'Bearer external-rotation',
      'Bearer external-rotation',
    ])
  })

  it('signs Bedrock requests with the region, access key and secret from its connection', async () => {
    const model = 'claude-connection'
    await seed(modelConfig({ model, provider: 'bedrock', backends: [createTestBedrockBackend()] }))
    const config = {
      region: 'eu-west-1',
      accessKeyId: 'connection-access-key',
      secretAccessKey: 'connection-secret-key',
    }
    expect(
      (await admin('/connections/bedrock-test', 'PUT', { bedrockConfig: config })).status
    ).toBe(200)
    let captured: Request | undefined
    upstream((request) => {
      captured = request
      return jsonResponse({ ok: true })
    })
    expect((await proxy({}, {}, `/v1/model/${model}/invoke`)).status).toBe(200)
    const request = captured!
    expect(new URL(request.url).hostname).toBe('bedrock-runtime.eu-west-1.amazonaws.com')
    const headers = new Headers(request.headers)
    const authorization = headers.get('authorization')
    headers.delete('authorization')
    const signed = await new AwsV4Signer({
      ...config,
      method: 'POST',
      service: 'bedrock',
      url: request.url,
      headers,
      body: await request.text(),
      datetime: headers.get('x-amz-date')!,
      allHeaders: true,
    }).sign()
    expect(authorization).toContain('Credential=connection-access-key/')
    expect(authorization).toBe(signed.headers.get('authorization'))
  })

  it.each(['missing', 'wrong-provider'])(
    'uses the existing configuration-missing fallback for an imported %s reference',
    async (reference) => {
      await seed(modelConfig({ backends: [createTestOpenAIBackend({ id: 'fallback' })] }))
      const invalid = createTestOpenAIBackend({
        id: 'invalid',
        connectionId: reference === 'missing' ? 'not-found' : 'bedrock-test',
      })
      const imported = modelConfig({
        backends: [invalid, createTestOpenAIBackend({ id: 'fallback' })],
      })
      await env.DB.prepare('UPDATE models SET config = ? WHERE model = ?')
        .bind(JSON.stringify(imported), MODEL)
        .run()
      const calls: string[] = []
      upstream((request) => {
        calls.push(request.url)
        return jsonResponse({ recovered: true })
      })
      const response = await proxy({}, { 'X-Backend-ID': 'invalid' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ recovered: true })
      expect(calls).toEqual(['https://b1.example/v1/chat/completions'])
      const stats = await env.DB.prepare(
        'SELECT backend_id, failure FROM backend_stats_minute ORDER BY backend_id'
      ).all()
      expect(stats.results).toEqual([
        { backend_id: 'fallback', failure: 0 },
        { backend_id: 'invalid', failure: 1 },
      ])
    }
  )
})
