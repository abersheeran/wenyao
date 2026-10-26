import { applyD1Migrations, env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, vi } from 'vitest'

import { ConfigManager } from '../services/config-manager.js'
import { DbMetricsCollector } from '../services/metrics/db-collector.js'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await new DbMetricsCollector(env.DB).resetStats()
  await env.DB.batch(
    ['models', 'api_keys', 'backend_stats_minute', 'affinity_mappings', 'recorded_requests'].map(
      (table) => env.DB.prepare(`DELETE FROM ${table}`)
    )
  )
  const concurrencyIds = await listDurableObjectIds(env.CONCURRENCY)
  await Promise.all(
    concurrencyIds.map((id) =>
      runInDurableObject(env.CONCURRENCY.get(id), (_instance, state) => {
        state.storage.sql.exec('DELETE FROM slots')
      })
    )
  )
  new ConfigManager(env.DB).invalidate()
  const objects = await env.RECORDINGS.list()
  if (objects.objects.length) {
    await env.RECORDINGS.delete(objects.objects.map((object) => object.key))
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected upstream request')))
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
