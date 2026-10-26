import type { BackendConfig, RecordedRequest, RecordedResponse } from '../types/backend.js'

export type ResponseRecordingError =
  | 'ttft_timeout'
  | 'network_error'
  | 'invalid_json'
  | 'stream_interrupted'
  | 'client_disconnected'

export interface ResponseRecordingInput {
  status: number | null
  headers: Record<string, string> | null
  body?: Uint8Array
  error: ResponseRecordingError | null
  truncated: boolean
  completedAt: number
}

interface RecordedRow {
  id: string
  backend_id: string
  model: string
  timestamp: number
  url: string
  headers: string
  response_status: number | null
  response_headers: string | null
  response_error: ResponseRecordingError | null
  response_truncated: number
  response_completed_at: number | null
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  }
  return btoa(chunks.join(''))
}

function isTextContentType(headers: Record<string, string> | null): boolean {
  const contentType = new Headers(headers ?? {})
    .get('content-type')
    ?.split(';')[0]
    .trim()
    .toLowerCase()
  return (
    !!contentType &&
    (contentType.startsWith('text/') ||
      contentType === 'application/json' ||
      contentType.endsWith('+json'))
  )
}

interface RecordedFilter {
  backendId?: string
  model?: string
  startTime?: string
  endTime?: string
}

function where(filter: RecordedFilter): { sql: string; values: (string | number)[] } {
  const clauses: string[] = []
  const values: (string | number)[] = []
  if (filter.backendId !== undefined) {
    clauses.push('backend_id = ?')
    values.push(filter.backendId)
  }
  if (filter.model !== undefined) {
    clauses.push('model = ?')
    values.push(filter.model)
  }
  if (filter.startTime !== undefined) {
    clauses.push('timestamp >= ?')
    values.push(new Date(filter.startTime).getTime())
  }
  if (filter.endTime !== undefined) {
    clauses.push('timestamp <= ?')
    values.push(new Date(filter.endTime).getTime())
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values }
}

export class RequestRecorder {
  constructor(
    private readonly db: D1Database,
    private readonly r2: R2Bucket
  ) {}

  async recordRequest(
    backend: BackendConfig,
    model: string,
    url: string,
    headers: Record<string, string>,
    body: unknown
  ): Promise<string | null> {
    if (!backend.recordRequests) return null
    const id = crypto.randomUUID()
    const objectKey = `recorded-requests/${id}`
    try {
      await this.r2.put(objectKey, typeof body === 'string' ? body : JSON.stringify(body), {
        httpMetadata: { contentType: 'application/json' },
      })
      try {
        await this.db
          .prepare(
            `INSERT INTO recorded_requests
          (id, backend_id, model, timestamp, url, headers) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(id, backend.id, model, Date.now(), url, JSON.stringify(headers))
          .run()
        return id
      } catch (error) {
        await this.r2.delete(objectKey)
        throw error
      }
    } catch (error) {
      console.error(`Failed to record request for backend ${backend.id}:`, error)
      return null
    }
  }

  async recordResponse(id: string, input: ResponseRecordingInput): Promise<void> {
    const objectKey = `recorded-responses/${id}`
    try {
      if (input.body !== undefined) {
        await this.r2.put(objectKey, input.body)
      }
      try {
        await this.db
          .prepare(
            `UPDATE recorded_requests SET response_status = ?, response_headers = ?,
            response_error = ?, response_truncated = ?, response_completed_at = ? WHERE id = ?`
          )
          .bind(
            input.status,
            input.headers === null ? null : JSON.stringify(input.headers),
            input.error,
            input.truncated ? 1 : 0,
            input.completedAt,
            id
          )
          .run()
      } catch (error) {
        if (input.body !== undefined) await this.r2.delete(objectKey)
        throw error
      }
    } catch (error) {
      console.error(`Failed to record response for request ${id}:`, error)
    }
  }

  private async responseFromRow(row: RecordedRow): Promise<RecordedResponse | null> {
    if (row.response_completed_at === null) return null
    const headers =
      row.response_headers === null
        ? null
        : (JSON.parse(row.response_headers) as Record<string, string>)
    const object = await this.r2.get(`recorded-responses/${row.id}`)
    const bytes = object ? new Uint8Array(await object.arrayBuffer()) : new Uint8Array()
    const text = isTextContentType(headers)
    return {
      status: row.response_status,
      headers,
      body: text ? new TextDecoder().decode(bytes) : base64(bytes),
      bodyEncoding: text ? 'utf8' : 'base64',
      error: row.response_error,
      truncated: row.response_truncated !== 0,
      completedAt: new Date(row.response_completed_at).toISOString(),
    }
  }

  private async fromRow(row: RecordedRow): Promise<RecordedRequest & { _id: string }> {
    const object = await this.r2.get(`recorded-requests/${row.id}`)
    return {
      _id: row.id,
      backendId: row.backend_id,
      model: row.model,
      timestamp: new Date(row.timestamp),
      url: row.url,
      headers: JSON.parse(row.headers) as Record<string, string>,
      body: object ? await object.text() : '',
      response: await this.responseFromRow(row),
    }
  }

  async list(
    filter: RecordedFilter = {},
    limit = 100,
    offset = 0
  ): Promise<{ requests: (RecordedRequest & { _id: string })[]; total: number }> {
    const clause = where(filter)
    const [rows, count] = await this.db.batch([
      this.db
        .prepare(
          `SELECT * FROM recorded_requests${clause.sql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
        )
        .bind(...clause.values, limit, offset),
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM recorded_requests${clause.sql}`)
        .bind(...clause.values),
    ])
    return {
      requests: await Promise.all(
        (rows.results as unknown as RecordedRow[]).map((row) => this.fromRow(row))
      ),
      total: (count.results[0] as { total: number }).total,
    }
  }

  async get(id: string): Promise<(RecordedRequest & { _id: string }) | null> {
    const row = await this.db
      .prepare('SELECT * FROM recorded_requests WHERE id = ?')
      .bind(id)
      .first<RecordedRow>()
    return row ? this.fromRow(row) : null
  }

  async delete(filter: RecordedFilter): Promise<number> {
    const clause = where(filter)
    const rows = await this.db
      .prepare(`SELECT id FROM recorded_requests${clause.sql}`)
      .bind(...clause.values)
      .all<{ id: string }>()
    let deleted = 0
    // Keep each query below D1's per-query parameter limit.
    for (let start = 0; start < rows.results.length; start += 100) {
      const ids = rows.results.slice(start, start + 100).map((row) => row.id)
      await this.r2.delete(
        ids.flatMap((id) => [`recorded-requests/${id}`, `recorded-responses/${id}`])
      )
      const result = await this.db
        .prepare(`DELETE FROM recorded_requests WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids)
        .run()
      deleted += result.meta.changes
    }
    return deleted
  }
}
