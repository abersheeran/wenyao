import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

async function migrate(models: { model: string; backends: { id: string; enabled: boolean }[] }[]) {
  const initial = env.TEST_MIGRATIONS.find(({ name }) => name === '0001_init.sql')!
  await env.DB.batch([
    env.DB.prepare('DROP TABLE backend_stats_minute'),
    env.DB.prepare(
      initial.queries.find((query) => query.includes('CREATE TABLE backend_stats_minute ('))!
    ),
    env.DB.prepare('CREATE INDEX idx_backend_stats_minute ON backend_stats_minute (minute)'),
    ...models.map((model) =>
      env.DB.prepare('INSERT INTO models (model, config) VALUES (?, ?)').bind(
        model.model,
        JSON.stringify(model)
      )
    ),
    env.DB.prepare(
      `INSERT INTO backend_stats_minute VALUES
        ('azure', 60000, 5, 3, 2, 300, 2, 900, 3),
        ('azure', 120000, 7, 6, 1, 400, 4, 600, 2)`
    ),
  ])
  const migration = env.TEST_MIGRATIONS.find(({ name }) => name === '0004_model_backend_stats.sql')
  expect(migration).toBeDefined()
  await env.DB.batch(migration!.queries.map((query) => env.DB.prepare(query)))
  return (await env.DB.prepare('SELECT * FROM backend_stats_minute ORDER BY minute').all()).results
}

describe('Model/backend statistics migration 0004', () => {
  it('assigns unique IDs to their model including disabled backends and preserves all counters', async () => {
    const model = "vendor/model.v1'中文"
    const rows = await migrate([
      { model, backends: [{ id: 'azure', enabled: false }] },
      { model: 'other', backends: [{ id: 'different', enabled: true }] },
    ])
    expect(rows).toEqual([
      {
        model,
        backend_id: 'azure',
        minute: 60000,
        total: 5,
        success: 3,
        failure: 2,
        streaming_ttft_sum: 300,
        streaming_ttft_count: 2,
        non_streaming_ttft_sum: 900,
        non_streaming_ttft_count: 3,
      },
      {
        model,
        backend_id: 'azure',
        minute: 120000,
        total: 7,
        success: 6,
        failure: 1,
        streaming_ttft_sum: 400,
        streaming_ttft_count: 4,
        non_streaming_ttft_sum: 600,
        non_streaming_ttft_count: 2,
      },
    ])
    const columns = (
      await env.DB.prepare('PRAGMA table_info(backend_stats_minute)').all<{
        name: string
        pk: number
        notnull: number
      }>()
    ).results
    expect(columns.filter(({ pk }) => pk > 0).map(({ name, pk }) => [name, pk])).toEqual([
      ['model', 1],
      ['backend_id', 2],
      ['minute', 3],
    ])
    expect(columns.find(({ name }) => name === 'model')!.notnull).toBe(1)
    expect(
      (await env.DB.prepare('PRAGMA index_info(idx_backend_stats_minute)').all()).results
    ).toEqual([{ seqno: 0, cid: 2, name: 'minute' }])
    await env.DB.prepare(
      'INSERT INTO backend_stats_minute (model, backend_id, minute) VALUES (?, ?, ?)'
    )
      .bind('other', 'azure', 60000)
      .run()
    await expect(
      env.DB.prepare(
        'INSERT INTO backend_stats_minute (model, backend_id, minute) VALUES (?, ?, ?)'
      )
        .bind(model, 'azure', 60000)
        .run()
    ).rejects.toThrow('UNIQUE constraint failed')
  })

  it('discards mixed IDs shared by multiple models even when one backend is disabled', async () => {
    expect(
      await migrate([
        { model: 'model-a', backends: [{ id: 'azure', enabled: true }] },
        { model: 'model-b', backends: [{ id: 'azure', enabled: false }] },
      ])
    ).toEqual([])
  })

  it('discards orphan IDs absent from every current model config', async () => {
    expect(
      await migrate([{ model: 'model-a', backends: [{ id: 'other', enabled: true }] }])
    ).toEqual([])
  })
})
