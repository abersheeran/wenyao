import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  MAX_STATEMENT_BYTES,
  migrationFinish,
  migrationPreamble,
  modelSql,
} from '../../scripts/mongodb-migration-sql.js'

interface LegacyModel extends Record<string, unknown> {
  model: string
  backends: Record<string, unknown>[]
}

function legacyModels(): LegacyModel[] {
  const backends = Array.from({ length: 12 }, (_, index) => ({
    id: `a-${index}`,
    provider: 'openai',
    weight: index,
    enabled: index % 2 === 0,
    model: `upstream-${index}`,
    streamingTTFTTimeout: index * 100,
    nonStreamingTTFTTimeout: index * 200,
    recordRequests: true,
    recordResponses: index % 2 === 1,
    maxConcurrentRequests: index + 1,
    extra: { keep: ['中文', null, index] },
    openaiConfig:
      index === 2
        ? { apiKey: 'second-key', url: 'https://second.test/v1', ignored: 'discard' }
        : index === 10
          ? { url: 'https://tenth.test/v1', apiKey: 'tenth-key' }
          : { url: 'https://shared.test/v1', apiKey: 'shared-key' },
  }))
  return [
    {
      model: 'z-last',
      provider: 'openai',
      backends: [
        {
          id: 'shared-reordered',
          provider: 'openai',
          weight: 7,
          enabled: true,
          openaiConfig: {
            ignored: { unknown: 'field' },
            apiKey: 'shared-key',
            url: 'https://shared.test/v1',
          },
          bedrockConfig: { region: 'unused' },
        },
        {
          id: 'last-new',
          provider: 'openai',
          openaiConfig: { apiKey: 'last-key', url: 'https://last.test/v1' },
        },
      ],
      loadBalancingStrategy: 'weighted',
    },
    {
      model: 'b-bedrock',
      provider: 'bedrock',
      backends: [
        {
          id: 'bedrock-a',
          provider: 'bedrock',
          bedrockConfig: {
            secretAccessKey: 'aws-secret',
            ignored: 'discard',
            accessKeyId: 'aws-key',
            region: 'us-east-1',
          },
        },
        {
          id: 'bedrock-b',
          provider: 'bedrock',
          bedrockConfig: {
            region: 'us-east-1',
            accessKeyId: 'aws-key',
            secretAccessKey: 'aws-secret',
          },
        },
      ],
    },
    {
      model: 'a-first',
      provider: 'openai',
      backends: [
        ...backends,
        { id: 'missing', provider: 'openai', weight: 1, enabled: false },
        { id: 'empty', provider: 'openai', openaiConfig: { url: 'https://test', apiKey: '' } },
        {
          id: 'wrong-type',
          provider: 'openai',
          openaiConfig: { url: 'https://test', apiKey: 42 },
        },
        {
          id: 'wrong-provider-config',
          provider: 'openai',
          bedrockConfig: { region: 'us-west-2', accessKeyId: 'key', secretAccessKey: 'secret' },
        },
        { id: 'null-config', provider: 'openai', openaiConfig: null },
        { id: 'scalar-config', provider: 'openai', openaiConfig: 'invalid' },
        {
          id: 'incomplete-bedrock',
          provider: 'bedrock',
          bedrockConfig: { region: 'us-west-2', accessKeyId: 'key' },
        },
      ],
      loadBalancingStrategy: 'lowest-ttft',
      enableAffinity: true,
      minErrorRateOptions: { minRequests: 5 },
    },
    { model: 'empty', provider: 'openai', backends: [] },
  ]
}

async function readData() {
  const [connections, models] = await env.DB.batch<{
    id: string
    provider: string
    config: string
    model: string
  }>([
    env.DB.prepare('SELECT * FROM connections ORDER BY id'),
    env.DB.prepare('SELECT * FROM models ORDER BY model'),
  ])
  return {
    connections: connections.results.map(({ id, provider, config }) => ({
      id,
      provider,
      config: JSON.parse(config),
    })),
    models: models.results.map(({ config }) => JSON.parse(config) as LegacyModel),
  }
}

async function runMigration(models: LegacyModel[]) {
  await env.DB.prepare('DROP TABLE connections').run()
  await env.DB.batch(
    models.map((model) =>
      env.DB.prepare('INSERT INTO models (model, config) VALUES (?, ?)').bind(
        model.model,
        JSON.stringify(model)
      )
    )
  )
  for (const name of ['0002_connections.sql', '0003_connection_names.sql']) {
    const migration = env.TEST_MIGRATIONS.find((migration) => migration.name === name)
    expect(migration).toBeDefined()
    await env.DB.batch(migration!.queries.map((query) => env.DB.prepare(query)))
  }
  return readData()
}

function expectedModels(models: LegacyModel[]) {
  return models
    .map((model) => ({
      ...model,
      backends: model.backends.map((backend) => {
        const { openaiConfig, bedrockConfig, ...converted } = backend
        const id = String(backend.id)
        const connectionId = id.startsWith('bedrock-')
          ? 'bedrock-1'
          : id === 'last-new'
            ? 'openai-4'
            : id === 'a-2'
              ? 'openai-2'
              : id === 'a-10'
                ? 'openai-3'
                : id.startsWith('a-') || id === 'shared-reordered'
                  ? 'openai-1'
                  : undefined
        return connectionId ? { ...converted, connectionId } : converted
      }),
    }))
    .sort((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0))
}

describe('Shared connection migrations', () => {
  it('defaults names to an empty string for connections created before 0003', async () => {
    const migrated = await runMigration(legacyModels())
    const names = await env.DB.prepare('SELECT id, name FROM connections ORDER BY id').all()
    expect(names.results).toEqual(migrated.connections.map(({ id }) => ({ id, name: '' })))
  })

  it('normalizes known config fields, numbers first occurrences, and preserves complete backend order', async () => {
    const source = legacyModels()
    const migrated = await runMigration(source)
    expect(migrated.connections).toEqual([
      {
        id: 'bedrock-1',
        provider: 'bedrock',
        config: { region: 'us-east-1', accessKeyId: 'aws-key', secretAccessKey: 'aws-secret' },
      },
      {
        id: 'openai-1',
        provider: 'openai',
        config: { url: 'https://shared.test/v1', apiKey: 'shared-key' },
      },
      {
        id: 'openai-2',
        provider: 'openai',
        config: { url: 'https://second.test/v1', apiKey: 'second-key' },
      },
      {
        id: 'openai-3',
        provider: 'openai',
        config: { url: 'https://tenth.test/v1', apiKey: 'tenth-key' },
      },
      {
        id: 'openai-4',
        provider: 'openai',
        config: { url: 'https://last.test/v1', apiKey: 'last-key' },
      },
    ])
    expect(migrated.models).toEqual(expectedModels(source))
    expect(
      (
        await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE '_wenyao_connection_%'"
        ).all()
      ).results
    ).toEqual([])
  })

  it('converts MongoDB models using the same normalization, IDs and model contents as 0002', async () => {
    const source = legacyModels()
    const original = structuredClone(source)
    const expected = await runMigration(source)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM models'),
      env.DB.prepare('DELETE FROM connections'),
    ])
    const connections = new Map<string, string>()
    const statements = source
      .toSorted((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0))
      .flatMap((model) => [...modelSql({ _id: 'old-object-id', ...model }, connections)])
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)))
    expect(await readData()).toEqual(expected)
    expect(source).toEqual(original)
  })

  it('numbers interleaved providers independently, compares every field, and preserves order with reversed scans', async () => {
    const openaiConfig = { url: 'https://shared.test/v1', apiKey: 'shared-key' }
    const bedrockConfig = {
      region: 'us-east-1',
      accessKeyId: 'aws-key',
      secretAccessKey: 'aws-secret',
    }
    const configs = [
      { provider: 'openai', openaiConfig },
      { provider: 'bedrock', bedrockConfig },
      { provider: 'openai', openaiConfig: { ...openaiConfig, url: 'https://other.test/v1' } },
      { provider: 'bedrock', bedrockConfig: { ...bedrockConfig, region: 'us-west-2' } },
      { provider: 'openai', openaiConfig: { ...openaiConfig, apiKey: 'other-key' } },
      { provider: 'bedrock', bedrockConfig: { ...bedrockConfig, accessKeyId: 'other-key' } },
      { provider: 'bedrock', bedrockConfig: { ...bedrockConfig, secretAccessKey: 'other-secret' } },
      {
        provider: 'bedrock',
        bedrockConfig: {
          secretAccessKey: 'aws-secret',
          accessKeyId: 'aws-key',
          region: 'us-east-1',
          ignored: true,
        },
      },
    ]
    const source: LegacyModel[] = [
      {
        model: 'all-fields',
        backends: configs.map((config, index) => ({ id: `backend-${index}`, ...config })),
      },
    ]
    await env.DB.prepare('PRAGMA reverse_unordered_selects = ON').run()
    try {
      const migrated = await runMigration(source)
      expect(migrated.connections).toHaveLength(7)
      expect(migrated.models[0].backends).toEqual(
        configs.map(({ provider }, index) => ({
          id: `backend-${index}`,
          provider,
          connectionId: `${provider}-${[1, 1, 2, 2, 3, 3, 4, 1][index]}`,
        }))
      )
      await env.DB.batch([
        env.DB.prepare('DELETE FROM models'),
        env.DB.prepare('DELETE FROM connections'),
      ])
      await env.DB.batch([...modelSql(source[0])].map((statement) => env.DB.prepare(statement)))
      expect(await readData()).toEqual(migrated)
    } finally {
      await env.DB.prepare('PRAGMA reverse_unordered_selects = OFF').run()
    }
  })

  it('preserves nonempty fields starting with NUL consistently in SQLite and MongoDB conversion', async () => {
    const source: LegacyModel[] = [
      {
        model: 'a-openai',
        provider: 'openai',
        backends: [
          {
            id: 'nul-openai',
            provider: 'openai',
            openaiConfig: { url: '\0https://test', apiKey: "\0key'中文" },
          },
        ],
      },
      {
        model: 'b-bedrock',
        provider: 'bedrock',
        backends: [
          {
            id: 'nul-bedrock',
            provider: 'bedrock',
            bedrockConfig: {
              region: '\0us-east-1',
              accessKeyId: '\0key',
              secretAccessKey: '\0secret',
            },
          },
        ],
      },
    ]
    const migrated = await runMigration(source)
    expect(migrated.connections).toHaveLength(2)
    expect(migrated.connections.find(({ id }) => id === 'openai-1')?.config).toEqual(
      source[0].backends[0].openaiConfig
    )
    expect(migrated.connections.find(({ id }) => id === 'bedrock-1')?.config).toEqual(
      source[1].backends[0].bedrockConfig
    )
    await env.DB.batch([
      env.DB.prepare('DELETE FROM models'),
      env.DB.prepare('DELETE FROM connections'),
    ])
    const connections = new Map<string, string>()
    await env.DB.batch(
      source
        .flatMap((model) => [...modelSql(model, connections)])
        .map((statement) => env.DB.prepare(statement))
    )
    expect(await readData()).toEqual(migrated)
  })

  it('preserves escaping, UTF-8 chunks, statement limits and idempotent connection replacement', async () => {
    const apiKey = `quoted'\\\0${'中文'.repeat(25_000)}`
    const source = {
      model: "quoted'\0model",
      provider: 'openai',
      backends: [
        {
          id: 'chunked',
          provider: 'openai',
          openaiConfig: { apiKey, url: 'https://shared.test/v1' },
        },
      ],
    }
    await env.DB.prepare(
      "INSERT INTO connections (id, provider, config) VALUES ('openai-1', 'openai', '{}')"
    ).run()
    const statements = [migrationPreamble, ...modelSql(source), migrationFinish]
    expect(statements.some((statement) => statement.includes("CAST(X'"))).toBe(true)
    expect(
      statements.every(
        (statement) => new TextEncoder().encode(statement).byteLength < MAX_STATEMENT_BYTES
      )
    ).toBe(true)
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)))
    const migrated = await readData()
    expect(migrated.connections).toEqual([
      {
        id: 'openai-1',
        provider: 'openai',
        config: { url: 'https://shared.test/v1', apiKey },
      },
    ])
    expect(migrated.models).toEqual([
      {
        ...source,
        backends: [{ id: 'chunked', provider: 'openai', connectionId: 'openai-1' }],
      },
    ])
  })
})
