import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { admin, createTestOpenAIBackend, MODEL, modelConfig } from './helpers.js'
import { ConfigManager } from '../services/config-manager.js'

import type { Connection } from '../types/connection.js'

const openai: Connection = {
  id: 'shared',
  name: '',
  provider: 'openai',
  openaiConfig: { url: 'https://upstream.example', apiKey: 'first-secret' },
}
const bedrock: Connection = {
  id: 'aws',
  name: '',
  provider: 'bedrock',
  bedrockConfig: { region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' },
}
const jev: Connection = {
  id: 'jev',
  name: '',
  provider: 'jev',
  jevConfig: { url: 'https://api.typesafe.ai', apiKey: 'jev-secret' },
}

function configuration(connection: Connection) {
  const { id: _id, name: _name, provider: _provider, ...config } = connection
  return config
}

async function error(response: Response, status: number): Promise<string> {
  expect(response.status).toBe(status)
  return ((await response.json()) as { error: string }).error
}

function databaseBeforeWrite(prefix: string, beforeWrite: () => Promise<void>): D1Database {
  let injected = false
  const matching = new WeakSet<D1PreparedStatement>()
  async function inject(): Promise<void> {
    if (injected) return
    injected = true
    await beforeWrite()
  }
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((statement) => matching.has(statement))) await inject()
          return target.batch(statements)
        }
      }
      if (property === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query)
          if (!query.startsWith(prefix)) return statement
          function wrap(statement: D1PreparedStatement): D1PreparedStatement {
            const wrapped = new Proxy(statement, {
              get(target, property) {
                if (property === 'bind') {
                  return (...values: unknown[]) => wrap(target.bind(...values))
                }
                if (property === 'run') {
                  return async () => {
                    await inject()
                    return target.run()
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
            matching.add(wrapped)
            return wrapped
          }
          return wrap(statement)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

describe('Shared connections management', () => {
  it.each([
    { label: 'trimmed', name: ' \tShared upstream\n ', expectedName: 'Shared upstream' },
    { label: 'omitted', name: undefined, expectedName: '' },
    { label: 'whitespace-only', name: ' \t\n ', expectedName: '' },
  ])(
    'returns the same $label name when creating, listing and reading',
    async ({ name, expectedName }) => {
      const { name: _name, ...unnamed } = openai
      const response = await admin(
        '/connections',
        'POST',
        name === undefined ? unnamed : { ...unnamed, name }
      )
      expect(response.status).toBe(201)
      const connection = { ...openai, name: expectedName }
      expect(await response.json()).toEqual({ connection })
      expect(await (await admin('/connections')).json()).toEqual({ connections: [connection] })
      expect(await (await admin('/connections/shared')).json()).toEqual({ connection })
    }
  )

  it('allows connections to share the same display name', async () => {
    expect((await admin('/connections', 'POST', { ...openai, name: 'Shared' })).status).toBe(201)
    expect((await admin('/connections', 'POST', { ...bedrock, name: 'Shared' })).status).toBe(201)
  })

  it('creates, lists, reads, replaces and deletes all provider configurations', async () => {
    expect((await admin('/connections', 'POST', openai)).status).toBe(201)
    expect((await admin('/connections', 'POST', bedrock)).status).toBe(201)
    expect((await admin('/connections', 'POST', jev)).status).toBe(201)
    const listed = (await (await admin('/connections')).json()) as { connections: Connection[] }
    expect(listed.connections).toEqual([bedrock, jev, openai])
    expect(await (await admin('/connections/shared')).json()).toEqual({ connection: openai })
    expect(await (await admin('/connections/jev')).json()).toEqual({ connection: jev })
    const replacement = { url: 'https://replacement.example', apiKey: 'rotated-secret' }
    const changed = await admin('/connections/shared', 'PUT', { openaiConfig: replacement })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ connection: { ...openai, openaiConfig: replacement } })
    expect(
      await env.DB.prepare('SELECT config FROM connections WHERE id = ?')
        .bind('shared')
        .first('config')
    ).toBe(JSON.stringify(replacement))
    const newBedrock = {
      region: 'eu-west-1',
      accessKeyId: 'new-access',
      secretAccessKey: 'new-secret',
    }
    expect(
      await (await admin('/connections/aws', 'PUT', { bedrockConfig: newBedrock })).json()
    ).toEqual({ connection: { ...bedrock, bedrockConfig: newBedrock } })
    const changedJev = await admin('/connections/jev', 'PUT', { jevConfig: replacement })
    expect(changedJev.status).toBe(200)
    expect(await changedJev.json()).toEqual({ connection: { ...jev, jevConfig: replacement } })
    expect(await (await admin('/connections/jev')).json()).toEqual({
      connection: { ...jev, jevConfig: replacement },
    })
    expect((await admin('/connections/shared', 'DELETE')).status).toBe(200)
    expect((await admin('/connections/aws', 'DELETE')).status).toBe(200)
    expect((await admin('/connections/jev', 'DELETE')).status).toBe(200)
    expect(await (await admin('/connections')).json()).toEqual({ connections: [] })
  })

  it.each([openai, bedrock, jev])(
    'updates only supplied name and configuration fields for $provider',
    async (connection) => {
      const path = `/connections/${connection.id}`
      expect(
        (await admin('/connections', 'POST', { ...connection, name: 'Original' })).status
      ).toBe(201)
      const renamed = { ...connection, name: 'Renamed' }
      const nameResponse = await admin(path, 'PUT', { name: '  Renamed  ' })
      expect(nameResponse.status).toBe(200)
      expect(await nameResponse.json()).toEqual({ connection: renamed })
      expect(await (await admin(path)).json()).toEqual({ connection: renamed })

      const replacement =
        connection.provider === 'bedrock'
          ? {
              bedrockConfig: {
                region: 'eu-west-1',
                accessKeyId: 'replacement-access',
                secretAccessKey: 'replacement-secret',
              },
            }
          : {
              [`${connection.provider}Config`]: {
                url: 'https://replacement.example',
                apiKey: 'replacement-secret',
              },
            }
      const reconfigured = { ...renamed, ...replacement }
      const configResponse = await admin(path, 'PUT', replacement)
      expect(configResponse.status).toBe(200)
      expect(await configResponse.json()).toEqual({ connection: reconfigured })
      expect(await (await admin(path)).json()).toEqual({ connection: reconfigured })

      const originalConfig = configuration(connection)
      const combined = { ...connection, name: 'Together' }
      const combinedResponse = await admin(path, 'PUT', { name: ' Together ', ...originalConfig })
      expect(combinedResponse.status).toBe(200)
      expect(await combinedResponse.json()).toEqual({ connection: combined })
      expect(await (await admin(path)).json()).toEqual({ connection: combined })

      const cleared = await admin(path, 'PUT', { name: ' \t\n ' })
      expect(cleared.status).toBe(200)
      expect(await cleared.json()).toEqual({ connection })
      expect(await (await admin(path)).json()).toEqual({ connection })
    }
  )

  it.each([openai, bedrock, jev])(
    'rejects empty updates, mismatched configurations and multiple configurations for $provider',
    async (connection) => {
      expect((await admin('/connections', 'POST', connection)).status).toBe(201)
      const path = `/connections/${connection.id}`
      const mismatched = [openai, bedrock, jev]
        .filter((candidate) => candidate.provider !== connection.provider)
        .map((candidate) => ({ name: 'Rejected', ...configuration(candidate) }))
      for (const input of [
        {},
        ...mismatched,
        {
          name: 'Rejected',
          openaiConfig: openai.openaiConfig,
          bedrockConfig: bedrock.bedrockConfig,
        },
        { openaiConfig: openai.openaiConfig, jevConfig: jev.jevConfig },
        { bedrockConfig: bedrock.bedrockConfig, jevConfig: jev.jevConfig },
      ]) {
        expect((await admin(path, 'PUT', input)).status).toBe(400)
      }
      expect(await (await admin(path)).json()).toEqual({ connection })
    }
  )

  it('rejects invalid IDs, mismatched fields, duplicate IDs and immutable fields', async () => {
    for (const id of ['', 'with space', 'a/b', '中文', 'a?']) {
      expect((await admin('/connections', 'POST', { ...openai, id })).status).toBe(400)
    }
    expect(
      (
        await admin('/connections', 'POST', {
          id: 'bad',
          provider: 'openai',
          bedrockConfig: bedrock.bedrockConfig,
        })
      ).status
    ).toBe(400)
    expect(
      (
        await admin('/connections', 'POST', {
          id: 'bad',
          provider: 'bedrock',
          openaiConfig: openai.openaiConfig,
        })
      ).status
    ).toBe(400)
    expect((await admin('/connections', 'POST', openai)).status).toBe(201)
    await error(await admin('/connections', 'POST', openai), 409)
    await error(
      await admin('/connections/shared', 'PUT', { bedrockConfig: bedrock.bedrockConfig }),
      400
    )
    expect(
      (
        await admin('/connections/shared', 'PUT', {
          id: 'renamed',
          openaiConfig: openai.openaiConfig,
        })
      ).status
    ).toBe(400)
    expect(
      (
        await admin('/connections/shared', 'PUT', {
          provider: 'bedrock',
          openaiConfig: openai.openaiConfig,
        })
      ).status
    ).toBe(400)
    expect(
      (await admin('/connections/shared', 'PUT', { openaiConfig: { apiKey: 'partial' } })).status
    ).toBe(400)
    const valid = { ...openai, id: 'valid.ID_1-2' }
    expect((await admin('/connections', 'POST', valid)).status).toBe(201)
  })

  it('returns 404 for absent connections on read, update and delete', async () => {
    await error(await admin('/connections/missing'), 404)
    await error(
      await admin('/connections/missing', 'PUT', { openaiConfig: openai.openaiConfig }),
      404
    )
    await error(await admin('/connections/missing', 'PUT', { name: 'Missing' }), 404)
    await error(await admin('/connections/missing', 'DELETE'), 404)
  })

  it('requires a connection on backend creation and validates all model/backend write paths', async () => {
    const manager = new ConfigManager(env.DB)
    await manager.addConnection(openai)
    await manager.addConnection(bedrock)
    await manager.addModelConfig(modelConfig({ backends: [] }))
    const backend = createTestOpenAIBackend({ id: 'target', connectionId: 'shared' })
    const { connectionId: _connectionId, ...withoutConnection } = backend
    expect((await admin(`/models/${MODEL}/backends`, 'POST', withoutConnection)).status).toBe(400)
    expect(
      (
        await admin('/models', 'POST', {
          ...modelConfig({ model: 'missing-id' }),
          backends: [withoutConnection],
        })
      ).status
    ).toBe(400)
    expect((await admin(`/models/${MODEL}`, 'PUT', { backends: [withoutConnection] })).status).toBe(
      400
    )
    expect((await admin(`/models/${MODEL}/backends`, 'POST', backend)).status).toBe(201)
    for (const connectionId of ['missing', 'aws']) {
      const invalid = { ...backend, connectionId }
      const requests = [
        admin(`/models/${MODEL}/backends`, 'POST', { ...invalid, id: 'new' }),
        admin(`/models/${MODEL}/backends/target`, 'PUT', { connectionId }),
        admin(
          '/models',
          'POST',
          modelConfig({ model: `invalid-${connectionId}`, backends: [invalid] })
        ),
        admin(`/models/${MODEL}`, 'PUT', { backends: [invalid] }),
      ]
      for (const response of await Promise.all(requests)) {
        const message = await error(response, 400)
        expect(message).toContain(connectionId)
        expect(message).toMatch(/target|new/)
      }
    }
  })

  it('requires Jev models to reference Jev connections and resolves credentials only for proxying', async () => {
    expect((await admin('/connections', 'POST', openai)).status).toBe(201)
    expect((await admin('/connections', 'POST', jev)).status).toBe(201)
    const config = modelConfig({
      model: 'jev-model',
      provider: 'jev',
      backends: [createTestOpenAIBackend({ provider: 'jev', connectionId: 'shared' })],
    })
    const mismatch = await error(await admin('/models', 'POST', config), 400)
    expect(mismatch).toContain("provider 'openai'")
    expect(mismatch).toContain("model provider 'jev'")
    config.backends[0].connectionId = 'jev'
    const created = await admin('/models', 'POST', config)
    expect(created.status).toBe(201)
    for (const path of [
      '/models',
      '/models/jev-model',
      '/models/jev-model/backends',
      '/models/jev-model/backends/b1',
    ]) {
      const response = await admin(path)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"connectionId":"jev"')
      expect(text).not.toMatch(/jevConfig|apiKey|jev-secret/)
    }
    expect(await (await admin('/connections/jev')).json()).toEqual({ connection: jev })
    expect((await new ConfigManager(env.DB).getSnapshot()).models[0].backends[0]).toMatchObject({
      ...config.backends[0],
      jevConfig: jev.jevConfig,
    })
  })

  it('lists referencing models and backends in 409 and allows deletion after unlinking', async () => {
    const manager = new ConfigManager(env.DB)
    await manager.addConnection(openai)
    await manager.addConnection({ ...openai, id: 'spare' })
    await manager.addModelConfig(
      modelConfig({ backends: [createTestOpenAIBackend({ connectionId: 'shared' })] })
    )
    await manager.addModelConfig(
      modelConfig({
        model: 'other-model',
        backends: [createTestOpenAIBackend({ id: 'other-backend', connectionId: 'shared' })],
      })
    )
    const message = await error(await admin('/connections/shared', 'DELETE'), 409)
    expect(message).toContain(`${MODEL}/b1`)
    expect(message).toContain('other-model/other-backend')
    expect(
      (await admin(`/models/${MODEL}/backends/b1`, 'PUT', { connectionId: 'spare' })).status
    ).toBe(200)
    expect((await admin('/models/other-model', 'DELETE')).status).toBe(200)
    expect((await admin('/connections/shared', 'DELETE')).status).toBe(200)
  })

  it('never includes provider credentials in model or backend management responses', async () => {
    const manager = new ConfigManager(env.DB)
    await manager.addConnection(openai)
    await manager.addModelConfig(
      modelConfig({ backends: [createTestOpenAIBackend({ connectionId: 'shared' })] })
    )
    // Direct imports may still contain obsolete fields; management must not expose them.
    await env.DB.prepare(
      "UPDATE models SET config = json_set(config, '$.backends[0].openaiConfig', json(?), '$.backends[0].bedrockConfig', json(?), '$.backends[0].jevConfig', json(?)) WHERE model = ?"
    )
      .bind(
        JSON.stringify(openai.openaiConfig),
        JSON.stringify(bedrock.bedrockConfig),
        JSON.stringify(jev.jevConfig),
        MODEL
      )
      .run()
    for (const path of [
      '/models',
      `/models/${MODEL}`,
      `/models/${MODEL}/backends`,
      `/models/${MODEL}/backends/b1`,
    ]) {
      const response = await admin(path)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"connectionId":"shared"')
      expect(text).not.toMatch(
        /openaiConfig|bedrockConfig|jevConfig|apiKey|accessKeyId|secretAccessKey|first-secret|jev-secret/
      )
    }
  })

  async function migratedBackends() {
    const manager = new ConfigManager(env.DB)
    await manager.addConnection(openai)
    const backends = [
      createTestOpenAIBackend({ id: 'first', connectionId: 'shared', weight: 2 }),
      createTestOpenAIBackend({ id: 'second', connectionId: 'shared', enabled: false }),
      createTestOpenAIBackend({ id: 'normal', connectionId: 'shared' }),
    ].map((backend, index) => {
      if (index === 2) return backend
      const { connectionId: _connectionId, ...withoutConnection } = backend
      return withoutConnection
    })
    await env.DB.prepare('INSERT INTO models (model, config) VALUES (?, ?)')
      .bind(MODEL, JSON.stringify({ ...modelConfig(), backends }))
      .run()
    return { manager, backends }
  }

  it('repairs migrated backends independently through backend updates', async () => {
    const { manager, backends } = await migratedBackends()
    expect(
      (await admin(`/models/${MODEL}/backends/first`, 'PUT', { connectionId: 'shared' })).status
    ).toBe(200)
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual([
      { ...backends[0], connectionId: 'shared' },
      backends[1],
      backends[2],
    ])
    expect(
      (await admin(`/models/${MODEL}/backends/second`, 'PUT', { connectionId: 'shared' })).status
    ).toBe(200)
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual(
      backends.map((backend) => ({ ...backend, connectionId: 'shared' }))
    )
  })

  it('deletes one migrated backend while another still has no connection', async () => {
    const { manager, backends } = await migratedBackends()
    expect((await admin(`/models/${MODEL}/backends/first`, 'DELETE')).status).toBe(200)
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual(backends.slice(1))
  })

  it('updates a valid backend while migrated backends still have no connection', async () => {
    const { manager, backends } = await migratedBackends()
    expect(
      (await admin(`/models/${MODEL}/backends/normal`, 'PUT', { enabled: false })).status
    ).toBe(200)
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual([
      ...backends.slice(0, 2),
      { ...backends[2], enabled: false },
    ])
  })

  it('rejects modifying an invalid backend without selecting its connection', async () => {
    const { manager, backends } = await migratedBackends()
    const message = await error(
      await admin(`/models/${MODEL}/backends/first`, 'PUT', { enabled: false }),
      400
    )
    expect(message).toContain('first')
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual(backends)
  })

  it('changes model strategy without revalidating unchanged migrated backends', async () => {
    const { manager, backends } = await migratedBackends()
    expect(
      (await admin(`/models/${MODEL}`, 'PUT', { loadBalancingStrategy: 'lowest-ttft' })).status
    ).toBe(200)
    expect(await manager.getModelConfig(MODEL)).toMatchObject({
      loadBalancingStrategy: 'lowest-ttft',
      backends,
    })
  })

  it('compares model backends by ID and content regardless of object key or array order', async () => {
    const { manager } = await migratedBackends()
    const original = (await manager.getModelConfig(MODEL))!
    const backends = original.backends
      .map((backend) => {
        const reordered = Object.fromEntries(Object.entries(backend).reverse()) as typeof backend
        return backend.id === 'normal' ? { ...reordered, enabled: false } : reordered
      })
      .reverse()
    const updated = await admin(`/models/${MODEL}`, 'PUT', { backends })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ model: { backends } })
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual(backends)
  })

  it('validates an existing connection again when another backend field changes', async () => {
    const { manager, backends } = await migratedBackends()
    await env.DB.prepare('DELETE FROM connections WHERE id = ?').bind('shared').run()
    const message = await error(
      await admin(`/models/${MODEL}/backends/normal`, 'PUT', { enabled: false }),
      400
    )
    expect(message).toContain('normal')
    expect(message).toContain('shared')
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual(backends)
  })
})

describe('Shared connection write concurrency', () => {
  it.each(['add-backend', 'update-backend', 'update-model'])(
    'does not commit a reference via %s if its connection is deleted after validation before CAS',
    async (operation) => {
      const manager = new ConfigManager(env.DB)
      await manager.addConnection(openai)
      await manager.addConnection({ ...openai, id: 'spare' })
      const original = createTestOpenAIBackend({ connectionId: 'spare' })
      await manager.addModelConfig(modelConfig({ backends: [original] }))
      const database = databaseBeforeWrite('UPDATE models SET config = ?', async () => {
        await manager.deleteConnection('shared')
      })
      const writer = new ConfigManager(database)
      const backend = { ...original, connectionId: 'shared' }
      const write =
        operation === 'add-backend'
          ? writer.addBackendToModel(MODEL, { ...backend, id: 'new' })
          : operation === 'update-backend'
            ? writer.updateBackendInModel(MODEL, original.id, { connectionId: 'shared' })
            : writer.updateModelConfig(MODEL, { backends: [backend] })
      await expect(write).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('shared'),
      })
      expect((await manager.getModelConfig(MODEL))!.backends).toEqual([original])
    }
  )

  it.each(['update-backend', 'update-model'])(
    'checks an unchanged connection ID in the %s CAS when another backend field changes',
    async (operation) => {
      const manager = new ConfigManager(env.DB)
      await manager.addConnection(openai)
      const original = createTestOpenAIBackend({ connectionId: 'shared' })
      await manager.addModelConfig(modelConfig({ backends: [original] }))
      const database = databaseBeforeWrite('UPDATE models SET config = ?', async () => {
        await env.DB.prepare('DELETE FROM connections WHERE id = ?').bind('shared').run()
      })
      const writer = new ConfigManager(database)
      await expect(
        operation === 'update-backend'
          ? writer.updateBackendInModel(MODEL, original.id, { enabled: false })
          : writer.updateModelConfig(MODEL, { backends: [{ ...original, enabled: false }] })
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('shared') })
      expect((await manager.getModelConfig(MODEL))!.backends).toEqual([original])
    }
  )

  it('recomputes changed backends after a competing write changes the stored version', async () => {
    const manager = new ConfigManager(env.DB)
    await manager.addConnection(openai)
    const original = createTestOpenAIBackend({ connectionId: 'shared' })
    const { connectionId: _connectionId, ...legacy } = createTestOpenAIBackend({ id: 'legacy' })
    await env.DB.prepare('INSERT INTO models (model, config) VALUES (?, ?)')
      .bind(MODEL, JSON.stringify({ ...modelConfig(), backends: [original, legacy] }))
      .run()
    const backends = (await manager.getModelConfig(MODEL))!.backends.map((backend) =>
      backend.id === original.id ? { ...backend, enabled: false } : backend
    )
    const database = databaseBeforeWrite('UPDATE models SET config = ?', async () => {
      await manager.deleteBackendFromModel(MODEL, 'legacy')
    })
    await expect(
      new ConfigManager(database).updateModelConfig(MODEL, { backends })
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('legacy') })
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual([original])
  })

  it('does not insert a model if its connection disappears after validation', async () => {
    const manager = new ConfigManager(env.DB)
    await manager.addConnection(openai)
    const database = databaseBeforeWrite('INSERT OR IGNORE INTO models', async () => {
      await env.DB.prepare('DELETE FROM connections WHERE id = ?').bind('shared').run()
    })
    await expect(
      new ConfigManager(database).addModelConfig(
        modelConfig({ backends: [createTestOpenAIBackend({ connectionId: 'shared' })] })
      )
    ).rejects.toMatchObject({ status: 400 })
    expect(await manager.getModelConfig(MODEL)).toBeUndefined()
  })

  it.each(['insert', 'update'])(
    'checks provider in the %s statement if a connection is recreated after validation',
    async (operation) => {
      const manager = new ConfigManager(env.DB)
      await manager.addConnection(openai)
      if (operation === 'update') await manager.addModelConfig(modelConfig({ backends: [] }))
      const database = databaseBeforeWrite(
        operation === 'insert' ? 'INSERT OR IGNORE INTO models' : 'UPDATE models SET config = ?',
        async () => {
          await manager.deleteConnection('shared')
          await manager.addConnection({ ...bedrock, id: 'shared' })
        }
      )
      const writer = new ConfigManager(database)
      const backend = createTestOpenAIBackend({ connectionId: 'shared' })
      await expect(
        operation === 'insert'
          ? writer.addModelConfig(modelConfig({ backends: [backend] }))
          : writer.addBackendToModel(MODEL, backend)
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('provider') })
      expect((await manager.getModelConfig(MODEL))?.backends).toEqual(
        operation === 'insert' ? undefined : []
      )
    }
  )

  it('checks references in the DELETE when a backend is committed immediately before deletion', async () => {
    const manager = new ConfigManager(env.DB)
    await manager.addConnection(openai)
    const database = databaseBeforeWrite('DELETE FROM connections', async () => {
      await manager.addModelConfig(
        modelConfig({ backends: [createTestOpenAIBackend({ connectionId: 'shared' })] })
      )
    })
    await expect(new ConfigManager(database).deleteConnection('shared')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`${MODEL}/b1`),
    })
    expect(await manager.getConnection('shared')).toEqual(openai)
  })

  it('retains the 409 reference details when another write unlinks immediately after the delete batch', async () => {
    const manager = new ConfigManager(env.DB)
    await manager.addConnection(openai)
    await manager.addModelConfig(
      modelConfig({ backends: [createTestOpenAIBackend({ connectionId: 'shared' })] })
    )
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements)
            await manager.deleteBackendFromModel(MODEL, 'b1')
            return results
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expect(new ConfigManager(database).deleteConnection('shared')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`${MODEL}/b1`),
    })
    expect((await manager.getModelConfig(MODEL))!.backends).toEqual([])
    expect(await manager.getConnection('shared')).toEqual(openai)
  })
})
