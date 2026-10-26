import { DurableObject } from 'cloudflare:workers'

const SLOT_TTL_MS = 30 * 60_000

export class BackendConcurrency extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS slots (slot_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL)'
    )
  }

  acquire(slotId: string, limit: number): boolean {
    const now = Date.now()
    this.ctx.storage.sql.exec('DELETE FROM slots WHERE started_at <= ?', now - SLOT_TTL_MS)
    const { total } = this.ctx.storage.sql
      .exec<{ total: number }>('SELECT COUNT(*) AS total FROM slots')
      .one()
    if (total >= limit) return false
    // All three SQL operations are synchronous: no other RPC can interleave.
    this.ctx.storage.sql.exec('INSERT INTO slots (slot_id, started_at) VALUES (?, ?)', slotId, now)
    return true
  }

  release(slotId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM slots WHERE slot_id = ?', slotId)
  }

  count(): number {
    this.ctx.storage.sql.exec('DELETE FROM slots WHERE started_at <= ?', Date.now() - SLOT_TTL_MS)
    return this.ctx.storage.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM slots').one()
      .total
  }
}
