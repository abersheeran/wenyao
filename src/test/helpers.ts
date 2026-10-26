import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { expect, vi } from 'vitest'

import worker from '../index.js'

import type { BackendConfig, ModelConfig } from '../types/backend.js'
import type { Bindings } from '../types/context.js'

export const ADMIN_KEY = 'admin-test-key'
export const PROXY_KEY = 'proxy-test-key'
export const MODEL = 'gpt-test'

export function createTestOpenAIBackend(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    id: 'b1',
    provider: 'openai',
    enabled: true,
    weight: 1,
    openaiConfig: { url: 'https://b1.example', apiKey: 'upstream-secret' },
    ...overrides,
  }
}

export function createTestBedrockBackend(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    id: 'bedrock',
    provider: 'bedrock',
    enabled: true,
    weight: 1,
    bedrockConfig: {
      region: 'us-east-1',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    ...overrides,
  }
}

export function modelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    model: MODEL,
    provider: 'openai',
    loadBalancingStrategy: 'weighted',
    backends: [createTestOpenAIBackend()],
    ...overrides,
  }
}

export async function request(
  path: string,
  init: RequestInit = {},
  bindings: Bindings = env
): Promise<Response> {
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(`https://proxy.example${path}`, init),
    bindings,
    context
  )
  // Consume streams before waiting: completion writes are scheduled by stream finalization.
  const bytes = await response.arrayBuffer()
  await waitOnExecutionContext(context)
  return new Response(bytes, { status: response.status, headers: response.headers })
}

export function admin(path: string, method = 'GET', body?: unknown): Promise<Response> {
  return request(`/admin${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export async function seed(config = modelConfig(), models = [config.model]): Promise<void> {
  expect((await admin('/models', 'POST', config)).status).toBe(201)
  expect(
    (
      await admin('/apikeys', 'POST', {
        key: PROXY_KEY,
        description: 'Local test key',
        models,
      })
    ).status
  ).toBe(201)
}

export function proxy(
  body: Record<string, unknown> = {},
  headers: HeadersInit = {},
  path = '/v1/chat/completions'
): Promise<Response> {
  const requestHeaders = new Headers(headers)
  if (!requestHeaders.has('Authorization'))
    requestHeaders.set('Authorization', `Bearer ${PROXY_KEY}`)
  requestHeaders.set('Content-Type', 'application/json')
  return request(path, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }], ...body }),
  })
}

export function upstream(handler: (request: Request) => Response | Promise<Response>) {
  return vi
    .mocked(fetch)
    .mockImplementation(async (input, init) => handler(new Request(input, init)))
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

export async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number
  }>()
  return row!.count
}

export async function insertStats(
  backendId: string,
  options: {
    minute?: number
    total?: number
    success?: number
    failure?: number
    streamingSum?: number
    streamingCount?: number
    nonStreamingSum?: number
    nonStreamingCount?: number
  } = {}
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO backend_stats_minute
      (backend_id, minute, total, success, failure, streaming_ttft_sum, streaming_ttft_count,
       non_streaming_ttft_sum, non_streaming_ttft_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      backendId,
      options.minute ?? Math.floor(Date.now() / 60_000) * 60_000,
      options.total ?? 20,
      options.success ?? 20,
      options.failure ?? 0,
      options.streamingSum ?? 0,
      options.streamingCount ?? 0,
      options.nonStreamingSum ?? 0,
      options.nonStreamingCount ?? 0
    )
    .run()
}

export async function insertAffinity(
  sessionId: string,
  backendId: string,
  lastAccessedAt = Date.now(),
  model = MODEL
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO affinity_mappings
      (model, session_id, backend_id, created_at, last_accessed_at, access_count)
     VALUES (?, ?, ?, ?, ?, 1)`
  )
    .bind(model, sessionId, backendId, lastAccessedAt, lastAccessedAt)
    .run()
}
