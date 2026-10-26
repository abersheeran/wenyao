import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import type { BackendConcurrency } from '../durable-objects/backend-concurrency.js'

function newStub() {
  return env.CONCURRENCY.get(env.CONCURRENCY.idFromName(crypto.randomUUID()))
}

describe('BackendConcurrency SQLite slots', () => {
  it('admits exactly N out of N+M concurrent acquisitions', async () => {
    const stub = newStub()
    const slots = Array.from({ length: 8 }, () => crypto.randomUUID())
    const acquired = await Promise.all(slots.map((slot) => stub.acquire(slot, 3)))
    expect(acquired.filter(Boolean)).toHaveLength(3)
    expect(await stub.count()).toBe(3)
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ slot_id: string }>('SELECT slot_id FROM slots')
        .toArray()
      expect(rows.map((row) => row.slot_id).sort()).toEqual(
        slots.filter((_slot, index) => acquired[index]).sort()
      )
    })
  })

  it('permits another acquisition after release and ignores releases for absent slots', async () => {
    const stub = newStub()
    expect(await stub.acquire('first', 1)).toBe(true)
    expect(await stub.acquire('full', 1)).toBe(false)
    await stub.release('absent')
    expect(await stub.count()).toBe(1)
    await stub.release('first')
    await stub.release('first')
    expect(await stub.count()).toBe(0)
    expect(await stub.acquire('next', 1)).toBe(true)
  })

  it('acquire deletes expired slots, including the exact thirty-minute boundary', async () => {
    const stub = newStub()
    await runInDurableObject<BackendConcurrency, void>(stub, (instance, state) => {
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      try {
        state.storage.sql.exec('INSERT INTO slots VALUES (?, ?)', 'expired', now - 1_800_001)
        state.storage.sql.exec('INSERT INTO slots VALUES (?, ?)', 'boundary', now - 1_800_000)
        state.storage.sql.exec('INSERT INTO slots VALUES (?, ?)', 'current', now - 1_799_999)
        expect(instance.acquire('new', 2)).toBe(true)
        expect(instance.acquire('full', 2)).toBe(false)
        expect(
          state.storage.sql
            .exec<{ slot_id: string }>('SELECT slot_id FROM slots ORDER BY slot_id')
            .toArray()
        ).toEqual([{ slot_id: 'current' }, { slot_id: 'new' }])
      } finally {
        clock.mockRestore()
      }
    })
  })

  it('count also physically deletes expired slots before returning the active total', async () => {
    const stub = newStub()
    await runInDurableObject<BackendConcurrency, void>(stub, (instance, state) => {
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      try {
        state.storage.sql.exec('INSERT INTO slots VALUES (?, ?)', 'expired', now - 1_800_001)
        state.storage.sql.exec('INSERT INTO slots VALUES (?, ?)', 'boundary', now - 1_800_000)
        state.storage.sql.exec('INSERT INTO slots VALUES (?, ?)', 'current', now)
        expect(instance.count()).toBe(1)
        expect(
          state.storage.sql.exec<{ slot_id: string }>('SELECT slot_id FROM slots').toArray()
        ).toEqual([{ slot_id: 'current' }])
      } finally {
        clock.mockRestore()
      }
    })
  })

  it('keeps SQLite slots after eviction and when obtaining a new stub for the same backend', async () => {
    const backendId = crypto.randomUUID()
    const id = env.CONCURRENCY.idFromName(backendId)
    const stub = env.CONCURRENCY.get(id)
    expect(await stub.acquire('persisted', 1)).toBe(true)
    await evictDurableObject(stub)
    const reopened = env.CONCURRENCY.get(env.CONCURRENCY.idFromName(backendId))
    expect(await reopened.count()).toBe(1)
    expect(await reopened.acquire('over-capacity', 1)).toBe(false)
    await runInDurableObject(reopened, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT slot_id FROM slots').toArray()).toEqual([
        { slot_id: 'persisted' },
      ])
    })
  })
})
