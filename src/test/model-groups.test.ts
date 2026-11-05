import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { admin, createTestOpenAIBackend, MODEL, modelConfig, seedConnections } from './helpers.js'
import { ConfigManager } from '../services/config-manager.js'

import type { ModelConfig } from '../types/backend.js'

async function expectGroup(response: Response, group: string, status = 200): Promise<void> {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ model: { group } })
}

async function expectReads(group: string): Promise<void> {
  await expectGroup(await admin(`/models/${MODEL}`), group)
  const list = await admin('/models')
  expect(list.status).toBe(200)
  expect(await list.json()).toMatchObject({ models: [{ group }] })
  const snapshot = await new ConfigManager(env.DB).getSnapshot()
  expect(snapshot.models[0].group).toBe(group)
}

async function storedModel(): Promise<ModelConfig> {
  const row = await env.DB.prepare('SELECT config FROM models WHERE model = ?')
    .bind(MODEL)
    .first<{ config: string }>()
  return JSON.parse(row!.config) as ModelConfig
}

describe('Admin-only model groups', () => {
  it('trims and persists groups on creation and includes them in every read', async () => {
    await expectGroup(
      await admin('/models', 'POST', modelConfig({ group: '  production  ', backends: [] })),
      'production',
      201
    )
    expect((await storedModel()).group).toBe('production')
    await expectReads('production')
  })

  it('defaults omitted groups to an empty string in responses and stored JSON', async () => {
    const { group: _group, ...config } = modelConfig({ backends: [] })
    await expectGroup(await admin('/models', 'POST', config), '', 201)
    expect((await storedModel()).group).toBe('')
    await expectReads('')
  })

  it('normalizes legacy JSON on reads, snapshots and backend mutations', async () => {
    await seedConnections()
    const { group: _group, ...config } = modelConfig()
    await env.DB.prepare('INSERT INTO models (model, config) VALUES (?, ?)')
      .bind(MODEL, JSON.stringify(config))
      .run()
    await expectReads('')
    await expectGroup(await admin(`/models/${MODEL}/backends/b1`, 'PUT', { weight: 2 }), '')
    expect((await storedModel()).group).toBe('')
  })

  it('accepts group-only updates, trims them and allows clearing', async () => {
    await admin('/models', 'POST', modelConfig({ backends: [] }))
    for (const [input, expected] of [
      ['  test  ', 'test'],
      ['', ''],
      ['   ', ''],
    ]) {
      await expectGroup(await admin(`/models/${MODEL}`, 'PUT', { group: input }), expected)
      expect((await storedModel()).group).toBe(expected)
      await expectReads(expected)
    }
  })

  it('checks length after trimming for both POST and PUT', async () => {
    const group = 'a'.repeat(64)
    await expectGroup(
      await admin('/models', 'POST', modelConfig({ group: `  ${group}  `, backends: [] })),
      group,
      201
    )
    expect((await storedModel()).group).toBe(group)
    const updatedGroup = 'b'.repeat(64)
    await expectGroup(
      await admin(`/models/${MODEL}`, 'PUT', { group: `  ${updatedGroup}  ` }),
      updatedGroup
    )
    expect((await storedModel()).group).toBe(updatedGroup)
    for (const invalid of ['a'.repeat(65), `  ${'a'.repeat(65)}  `]) {
      expect(
        (
          await admin(
            '/models',
            'POST',
            modelConfig({ model: 'invalid', group: invalid, backends: [] })
          )
        ).status
      ).toBe(400)
      expect((await admin(`/models/${MODEL}`, 'PUT', { group: invalid })).status).toBe(400)
    }
    await expectReads(updatedGroup)
  })

  it('preserves and returns groups through backend add, update, reorder and delete', async () => {
    await seedConnections()
    await expectGroup(
      await admin('/models', 'POST', modelConfig({ group: 'production' })),
      'production',
      201
    )
    await expectGroup(
      await admin(`/models/${MODEL}/backends`, 'POST', createTestOpenAIBackend({ id: 'b2' })),
      'production',
      201
    )
    await expectGroup(
      await admin(`/models/${MODEL}/backends/b2`, 'PUT', { weight: 3 }),
      'production'
    )
    await expectGroup(
      await admin(`/models/${MODEL}/backend-order`, 'PUT', { backendIds: ['b2', 'b1'] }),
      'production'
    )
    expect((await storedModel()).backends.map((backend) => backend.id)).toEqual(['b2', 'b1'])
    await expectGroup(await admin(`/models/${MODEL}/backends/b2`, 'DELETE'), 'production')
    expect((await storedModel()).group).toBe('production')
    await expectReads('production')
  })
})
