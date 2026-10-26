import type { AffinityMapping, BackendConfig } from '../types/backend.js'

interface AffinityRow {
  model: string
  session_id: string
  backend_id: string
  created_at: number
  last_accessed_at: number
  access_count: number
}

interface AffinityFilter {
  model?: string
  sessionId?: string
  backendId?: string
}

const MAX_AGE_MS = 60 * 60 * 1000

function fromRow(row: AffinityRow): AffinityMapping {
  return {
    model: row.model,
    sessionId: row.session_id,
    backendId: row.backend_id,
    createdAt: new Date(row.created_at),
    lastAccessedAt: new Date(row.last_accessed_at),
    accessCount: row.access_count,
  }
}

function where(
  filter: AffinityFilter = {},
  includeExpiry = false
): { sql: string; values: (string | number)[] } {
  const clauses: string[] = []
  const values: (string | number)[] = []
  if (includeExpiry) {
    clauses.push('last_accessed_at > ?')
    values.push(Date.now() - MAX_AGE_MS)
  }
  for (const [field, column] of [
    ['model', 'model'],
    ['sessionId', 'session_id'],
    ['backendId', 'backend_id'],
  ] as const) {
    if (filter[field] !== undefined) {
      clauses.push(`${column} = ?`)
      values.push(filter[field])
    }
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values }
}

export class AffinityManager {
  constructor(private readonly db: D1Database) {}

  async getMapping(model: string, sessionId: string): Promise<AffinityMapping | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM affinity_mappings WHERE model = ? AND session_id = ? AND last_accessed_at > ?'
      )
      .bind(model, sessionId, Date.now() - MAX_AGE_MS)
      .first<AffinityRow>()
    return row ? fromRow(row) : null
  }

  async getAffinityBackend(
    model: string,
    sessionId: string,
    backends: BackendConfig[],
    ctx?: Pick<ExecutionContext, 'waitUntil'>
  ): Promise<BackendConfig | null> {
    const mapping = await this.getMapping(model, sessionId)
    if (!mapping) return null
    const backend = backends.find(
      (candidate) => candidate.id === mapping.backendId && candidate.enabled && candidate.weight > 0
    )
    if (backend) return backend
    const cleanup = this.clearMappings({ model, sessionId }).catch((error) => {
      console.error('Failed to remove invalid affinity mapping:', error)
    })
    if (ctx) ctx.waitUntil(cleanup)
    else await cleanup
    return null
  }

  upsertStatement(model: string, sessionId: string, backendId: string): D1PreparedStatement {
    const now = Date.now()
    return this.db
      .prepare(
        `INSERT INTO affinity_mappings
      (model, session_id, backend_id, created_at, last_accessed_at, access_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (model, session_id) DO UPDATE SET backend_id = excluded.backend_id,
        last_accessed_at = excluded.last_accessed_at, access_count = access_count + 1`
      )
      .bind(model, sessionId, backendId, now, now)
  }

  async setAffinityBackend(model: string, sessionId: string, backendId: string): Promise<void> {
    await this.upsertStatement(model, sessionId, backendId).run()
  }

  async getAllMappings(
    filter: AffinityFilter = {},
    limit = 100,
    offset = 0
  ): Promise<{ mappings: AffinityMapping[]; total: number }> {
    const clause = where(filter, true)
    const [rows, count] = await this.db.batch([
      this.db
        .prepare(
          `SELECT * FROM affinity_mappings${clause.sql} ORDER BY last_accessed_at DESC LIMIT ? OFFSET ?`
        )
        .bind(...clause.values, limit, offset),
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM affinity_mappings${clause.sql}`)
        .bind(...clause.values),
    ])
    return {
      mappings: (rows.results as unknown as AffinityRow[]).map(fromRow),
      total: (count.results[0] as { total: number }).total,
    }
  }

  async clearMappings(filter: AffinityFilter = {}): Promise<number> {
    const clause = where(filter)
    const result = await this.db
      .prepare(`DELETE FROM affinity_mappings${clause.sql}`)
      .bind(...clause.values)
      .run()
    return result.meta.changes
  }

  async cleanupBackendMappings(backendId: string): Promise<number> {
    return this.clearMappings({ backendId })
  }

  async cleanupModelMappings(model: string): Promise<number> {
    return this.clearMappings({ model })
  }
}
