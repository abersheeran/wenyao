import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import {
  admin,
  count,
  createTestBedrockBackend,
  createTestOpenAIBackend,
  insertAffinity,
  jsonResponse,
  MODEL,
  modelConfig,
  proxy,
  PROXY_KEY,
  request,
  seed,
  upstream,
} from './helpers.js'
import worker from '../index.js'
import { ConcurrencyLimiter } from '../services/concurrency-limiter.js'

function twoBackends() {
  return [
    createTestOpenAIBackend(),
    createTestOpenAIBackend({
      id: 'b2',
      openaiConfig: { url: 'https://b2.example', apiKey: 'second-secret' },
    }),
  ]
}

function concurrency(backendId = 'b1') {
  return env.CONCURRENCY.get(env.CONCURRENCY.idFromName(backendId))
}

function limitedBackends() {
  return twoBackends().map((backend) => ({ ...backend, maxConcurrentRequests: 1 }))
}

function proxyWithConcurrency(namespace: Env['CONCURRENCY']) {
  return request(
    '/v1/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${PROXY_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }] }),
    },
    { ...env, CONCURRENCY: namespace }
  )
}

describe('Proxy authentication and selection', () => {
  it.each([undefined, 'Bearer invalid'])(
    'returns 401 for missing or invalid credentials: %s',
    async (authorization) => {
      await seed()
      const response = await request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }] }),
      })
      expect(response.status).toBe(401)
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('returns 403 when key cannot access the requested model', async () => {
    await seed(modelConfig(), ['other-model'])
    expect((await proxy()).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('honors weighted selection and excludes disabled and zero weight backends', async () => {
    await seed(
      modelConfig({
        backends: [
          ...twoBackends().map((backend, index) => ({ ...backend, weight: index === 0 ? 1 : 3 })),
          createTestOpenAIBackend({ id: 'zero', weight: 0 }),
          createTestOpenAIBackend({ id: 'disabled', enabled: false, weight: 100 }),
        ],
      })
    )
    const calls: string[] = []
    upstream((req) => {
      calls.push(new URL(req.url).hostname)
      return jsonResponse({ ok: true })
    })
    const random = vi.spyOn(Math, 'random')
    random.mockReturnValue(0.1)
    expect((await proxy()).status).toBe(200)
    random.mockReturnValue(0.9)
    expect((await proxy()).status).toBe(200)
    expect(calls).toEqual(['b1.example', 'b2.example'])
  })

  it('X-Backend-ID forces the selected backend including weight zero', async () => {
    await seed(modelConfig({ backends: [twoBackends()[0], { ...twoBackends()[1], weight: 0 }] }))
    let host = ''
    upstream((req) => {
      host = new URL(req.url).hostname
      return jsonResponse({ ok: true })
    })
    expect((await proxy({}, { 'X-Backend-ID': 'b2' })).status).toBe(200)
    expect(host).toBe('b2.example')
  })

  it('returns 400 for a forced disabled or missing backend', async () => {
    await seed(modelConfig({ backends: [createTestOpenAIBackend({ enabled: false })] }))
    expect((await proxy({}, { 'X-Backend-ID': 'b1' })).status).toBe(400)
    expect((await proxy({}, { 'X-Backend-ID': 'missing' })).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('replaces authentication and removes client and Cloudflare forwarding headers', async () => {
    await seed()
    let forwarded = new Headers()
    upstream((req) => {
      forwarded = req.headers
      return jsonResponse({ ok: true })
    })
    const response = await proxy(
      {},
      {
        Host: 'client.example',
        'Content-Length': '999',
        'X-Authorization': `Bearer ${PROXY_KEY}`,
        'CF-Ray': 'ray-id',
        'CF-Connecting-IP': '192.0.2.1',
        'X-Forwarded-For': '192.0.2.2',
        'X-Forwarded-Host': 'private.example',
        'X-Real-IP': '192.0.2.3',
        'CDN-Loop': 'cloudflare',
        'X-Custom': 'keep-me',
      }
    )
    expect(response.status).toBe(200)
    expect(forwarded.get('authorization')).toBe('Bearer upstream-secret')
    for (const header of [
      'host',
      'content-length',
      'x-authorization',
      'cf-ray',
      'cf-connecting-ip',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-real-ip',
      'cdn-loop',
    ]) {
      expect(forwarded.has(header), header).toBe(false)
    }
    expect(forwarded.get('x-custom')).toBe('keep-me')
  })

  it('throttles last_used_at writes for a key inside the same isolate', async () => {
    await seed()
    upstream(() => jsonResponse({ ok: true }))
    const key = 'unique-last-used-key'
    await admin('/apikeys', 'POST', { key, description: 'Throttle test', models: [MODEL] })
    await proxy({}, { Authorization: `Bearer ${key}` })
    const first = await env.DB.prepare('SELECT last_used_at FROM api_keys WHERE key = ?')
      .bind(key)
      .first<{ last_used_at: number }>()
    expect(first!.last_used_at).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await proxy({}, { Authorization: `Bearer ${key}` })
    const second = await env.DB.prepare('SELECT last_used_at FROM api_keys WHERE key = ?')
      .bind(key)
      .first<{ last_used_at: number }>()
    expect(second!.last_used_at).toBe(first!.last_used_at)
  })
})

describe('Fallback and byte preserving proxy', () => {
  it('falls back after HTTP 500 and records success and failure separately', async () => {
    await seed(modelConfig({ backends: limitedBackends() }))
    const calls: string[] = []
    upstream((req) => {
      const host = new URL(req.url).hostname
      calls.push(host)
      return host === 'b1.example'
        ? jsonResponse({ error: 'first-failed' }, 500)
        : jsonResponse({ ok: true })
    })
    const response = await proxy({}, { 'X-Backend-ID': 'b1' })
    expect(response.status).toBe(200)
    expect(calls).toEqual(['b1.example', 'b2.example'])
    const rows = await env.DB.prepare(
      'SELECT backend_id, total, success, failure FROM backend_stats_minute ORDER BY backend_id'
    ).all()
    expect(rows.results).toEqual([
      { backend_id: 'b1', total: 1, success: 0, failure: 1 },
      { backend_id: 'b2', total: 1, success: 1, failure: 0 },
    ])
    expect(await concurrency().count()).toBe(0)
    expect(await concurrency('b2').count()).toBe(0)
  })

  it('returns the last upstream error unchanged when all attempts fail', async () => {
    await seed(modelConfig({ backends: limitedBackends() }))
    upstream((req) =>
      new URL(req.url).hostname === 'b1.example'
        ? new Response('first failed', { status: 500 })
        : new Response('last failed', { status: 502, headers: { 'X-Upstream-Error': 'last' } })
    )
    const response = await proxy({}, { 'X-Backend-ID': 'b1' })
    expect(response.status).toBe(502)
    expect(await response.text()).toBe('last failed')
    expect(response.headers.get('x-upstream-error')).toBe('last')
    expect(await concurrency().count()).toBe(0)
    expect(await concurrency('b2').count()).toBe(0)
  })

  it('passes OpenAI SSE bytes through unchanged across split UTF-8 and invalid byte sequences', async () => {
    await seed(modelConfig({ backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })] }))
    const bytes = new Uint8Array([100, 97, 116, 97, 58, 32, 0xe6, 0x96, 0x87, 0xff, 13, 10, 13, 10])
    upstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 7))
              controller.enqueue(bytes.slice(7, 8))
              controller.enqueue(bytes.slice(8))
              controller.close()
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
    )
    const response = await proxy({ stream: true })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(await concurrency().count()).toBe(0)
  })

  it('passes Bedrock binary event-stream bytes through unchanged', async () => {
    const model = 'anthropic.claude-3-5-sonnet-20240620-v1:0'
    await seed(modelConfig({ model, provider: 'bedrock', backends: [createTestBedrockBackend()] }))
    const bytes = new Uint8Array([0, 0, 0, 32, 0xff, 0xfe, 0x80, 0, 13, 10, 255, 128, 1])
    let upstreamUrl = ''
    let authorization = ''
    upstream((req) => {
      upstreamUrl = req.url
      authorization = req.headers.get('authorization') ?? ''
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 6))
            controller.enqueue(bytes.slice(6))
            controller.close()
          },
        }),
        { headers: { 'Content-Type': 'application/vnd.amazon.eventstream' } }
      )
    })
    const response = await proxy(
      {},
      {},
      `/v1/model/${encodeURIComponent(model)}/invoke-with-response-stream`
    )
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(decodeURIComponent(upstreamUrl)).toContain(`/model/${model}/invoke-with-response-stream`)
    expect(authorization).toContain('AWS4-HMAC-SHA256')
  })

  it.each([true, false])(
    'TTFT timeout cancels upstream body and falls back (stream=%s)',
    async (stream) => {
      await seed(
        modelConfig({
          backends: [
            createTestOpenAIBackend({
              maxConcurrentRequests: 1,
              streamingTTFTTimeout: 10,
              nonStreamingTTFTTimeout: 10,
            }),
            limitedBackends()[1],
          ],
        })
      )
      const cancel = vi.fn()
      upstream((req) =>
        new URL(req.url).hostname === 'b1.example'
          ? new Response(new ReadableStream({ cancel }), {
              headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' },
            })
          : new Response(stream ? 'data: recovered\n\n' : '{"recovered":true}', {
              headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' },
            })
      )
      const response = await proxy({ stream }, { 'X-Backend-ID': 'b1' })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('recovered')
      expect(cancel).toHaveBeenCalledOnce()
      expect(await concurrency().count()).toBe(0)
      expect(await concurrency('b2').count()).toBe(0)
    }
  )

  it.each([true, false])(
    'removes stale content-length and content-encoding (stream=%s)',
    async (stream) => {
      await seed()
      upstream(
        () =>
          new Response(stream ? 'data: ok\n\n' : '{"ok":true}', {
            headers: {
              'Content-Type': stream ? 'text/event-stream' : 'application/json',
              'Content-Length': '9999',
              'Content-Encoding': 'gzip',
            },
          })
      )
      const response = await proxy({ stream })
      expect(response.status).toBe(200)
      expect(response.headers.has('content-length')).toBe(false)
      expect(response.headers.has('content-encoding')).toBe(false)
      expect(await response.text()).toContain('ok')
    }
  )
})

describe('DO concurrency admission', () => {
  it('falls back to the next backend when the first backend has no free slots', async () => {
    await seed(modelConfig({ backends: limitedBackends() }))
    expect(await concurrency().acquire('occupied', 1)).toBe(true)
    const hosts: string[] = []
    upstream((req) => {
      hosts.push(new URL(req.url).hostname)
      return jsonResponse({ ok: true })
    })
    const response = await proxy({}, { 'X-Backend-ID': 'b1' })
    expect(response.status).toBe(200)
    expect(hosts).toEqual(['b2.example'])
    expect(await concurrency().count()).toBe(1)
    expect(await concurrency('b2').count()).toBe(0)
  })

  it('returns 429 all_backends_at_capacity when every backend is full', async () => {
    await seed(modelConfig({ backends: limitedBackends() }))
    await concurrency().acquire('occupied-first', 1)
    await concurrency('b2').acquire('occupied-second', 1)
    const response = await proxy({}, { 'X-Backend-ID': 'b1' })
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({
      error: { code: 'all_backends_at_capacity' },
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(await count('backend_stats_minute')).toBe(0)
  })

  it.each([undefined, 0])(
    'does not access the DO namespace when maxConcurrentRequests is %s',
    async (maxConcurrentRequests) => {
      await seed(modelConfig({ backends: [createTestOpenAIBackend({ maxConcurrentRequests })] }))
      const idFromName = vi.fn(() => {
        throw new Error('An unlimited backend must not use Durable Objects')
      })
      const get = vi.fn(() => {
        throw new Error('An unlimited backend must not use Durable Objects')
      })
      const namespace = { idFromName, get } as unknown as Env['CONCURRENCY']
      upstream(() => jsonResponse({ ok: true }))
      const response = await proxyWithConcurrency(namespace)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(idFromName).not.toHaveBeenCalled()
      expect(get).not.toHaveBeenCalled()
      expect(await count('backend_stats_minute')).toBe(1)
    }
  )

  it('fails open and logs when the acquire RPC fails', async () => {
    await seed(modelConfig({ backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })] }))
    const error = new Error('DO is unavailable')
    const acquire = vi.fn().mockRejectedValue(error)
    const release = vi.fn().mockResolvedValue(undefined)
    const id = env.CONCURRENCY.idFromName('b1')
    const idFromName = vi.fn(() => id)
    const get = vi.fn(() => ({ acquire, release }))
    const namespace = { idFromName, get } as unknown as Env['CONCURRENCY']
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    upstream(() => jsonResponse({ ok: true }))
    expect((await proxyWithConcurrency(namespace)).status).toBe(200)
    expect(idFromName).toHaveBeenCalledWith('b1')
    expect(acquire).toHaveBeenCalledWith(expect.stringMatching(/^[\da-f-]{36}$/i), 1)
    expect(release).toHaveBeenCalledWith(acquire.mock.calls[0][0])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('b1'), error)
    expect(await count('backend_stats_minute')).toBe(1)
  })

  it('logs a failed release RPC without failing the response or metrics write', async () => {
    await seed(modelConfig({ backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })] }))
    const error = new Error('DO release is unavailable')
    const acquire = vi.fn().mockResolvedValue(true)
    const release = vi.fn().mockRejectedValue(error)
    const idFromName = vi.fn(() => env.CONCURRENCY.idFromName('b1'))
    const get = vi.fn(() => ({ acquire, release }))
    const namespace = { idFromName, get } as unknown as Env['CONCURRENCY']
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    upstream(() => jsonResponse({ ok: true }))
    expect((await proxyWithConcurrency(namespace)).status).toBe(200)
    expect(release).toHaveBeenCalledWith(acquire.mock.calls[0][0])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('b1'), error)
    expect(await count('backend_stats_minute')).toBe(1)
  })

  it('still releases the DO slot if the D1 completion batch fails', async () => {
    await seed(modelConfig({ backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })] }))
    upstream(() => jsonResponse({ ok: true }))
    await proxy()
    const error = new Error('D1 is overloaded')
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect((await proxy()).status).toBe(200)
    expect(await concurrency().count()).toBe(0)
    expect(log).toHaveBeenCalledWith('Request completion batch failed', error)
  })

  it.each([true, false])(
    'releases its DO slot after a successful response (stream=%s)',
    async (stream) => {
      await seed(modelConfig({ backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })] }))
      upstream(() => new Response(stream ? 'data: ok\n\n' : '{"ok":true}'))
      expect((await proxy({ stream })).status).toBe(200)
      expect(await concurrency().count()).toBe(0)
      expect(await concurrency().acquire('next-request', 1)).toBe(true)
    }
  )
})

describe('Proxy completion lifecycle', () => {
  it('uses separate UUID slots even when simultaneous clients reuse x-request-id', async () => {
    await seed(modelConfig({ backends: [createTestOpenAIBackend({ maxConcurrentRequests: 2 })] }))
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller)
              controller.enqueue(new TextEncoder().encode('data: first\n\n'))
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
    )
    const requests = [
      proxy({ stream: true }, { 'X-Request-ID': 'same-client-id' }),
      proxy({ stream: true }, { 'X-Request-ID': 'same-client-id' }),
    ]
    for (let i = 0; i < 100 && controllers.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    try {
      expect(controllers).toHaveLength(2)
      const slots = await runInDurableObject(concurrency(), (_instance, state) =>
        state.storage.sql.exec<{ slot_id: string }>('SELECT slot_id FROM slots').toArray()
      )
      expect(slots).toHaveLength(2)
      expect(new Set(slots.map((row) => row.slot_id)).size).toBe(2)
      for (const row of slots) expect(row.slot_id).toMatch(/^[\da-f-]{36}$/i)
    } finally {
      for (const controller of controllers) controller.close()
      await Promise.all(requests)
    }
    expect(await concurrency().count()).toBe(0)
  })

  it('generates a fresh UUID for each fallback attempt', async () => {
    await seed(modelConfig({ backends: limitedBackends() }))
    const acquire = vi.spyOn(ConcurrencyLimiter.prototype, 'tryAcquire')
    upstream((req) =>
      new URL(req.url).hostname === 'b1.example'
        ? new Response('failed', { status: 500 })
        : jsonResponse({ ok: true })
    )
    expect((await proxy({}, { 'X-Backend-ID': 'b1', 'X-Request-ID': 'client-id' })).status).toBe(
      200
    )
    expect(acquire).toHaveBeenCalledTimes(2)
    const slots = acquire.mock.calls.map(([, slotId]) => slotId)
    expect(new Set(slots).size).toBe(2)
    for (const slotId of slots) expect(slotId).toMatch(/^[\da-f-]{36}$/i)
  })

  it('finishes a warmed request with one batch containing only metrics and affinity UPSERTs', async () => {
    await seed(
      modelConfig({
        enableAffinity: true,
        backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })],
      })
    )
    upstream(() => jsonResponse({ ok: true }))
    await proxy()
    const batch = vi.spyOn(env.DB, 'batch')
    const prepare = vi.spyOn(env.DB, 'prepare')
    expect((await proxy({}, { 'X-Session-ID': 'batch-session' })).status).toBe(200)
    expect(batch).toHaveBeenCalledOnce()
    expect(batch.mock.calls[0][0]).toHaveLength(2)
    const writes = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /\b(?:INSERT|DELETE)\b/i.test(sql))
    expect(writes).toHaveLength(2)
    expect(
      writes.every((sql) => /INSERT INTO (?:backend_stats_minute|affinity_mappings)/.test(sql))
    ).toBe(true)
    expect(writes.every((sql) => /ON CONFLICT/.test(sql))).toBe(true)
    expect(await concurrency().count()).toBe(0)
    expect(await count('affinity_mappings')).toBe(1)
  })

  it('invalid tokens use the existing snapshot without querying D1', async () => {
    await seed()
    upstream(() => jsonResponse({ ok: true }))
    await proxy()
    const batch = vi.spyOn(env.DB, 'batch')
    const prepare = vi.spyOn(env.DB, 'prepare')
    expect((await proxy({}, { Authorization: 'Bearer invalid' })).status).toBe(401)
    expect(batch).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })
})

describe('Interrupted request completion', () => {
  async function startStreamingProxy() {
    const context = createExecutionContext()
    const response = await worker.fetch(
      new Request('https://proxy.example/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PROXY_KEY}`,
          'Content-Type': 'application/json',
          'X-Session-ID': 'interrupted',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      }),
      env,
      context
    )
    expect(response.status).toBe(200)
    return { response, context }
  }

  async function expectFailedCompletion() {
    expect(await concurrency().count()).toBe(0)
    expect(await count('affinity_mappings')).toBe(0)
    const stats = await env.DB.prepare(
      'SELECT total, success, failure FROM backend_stats_minute WHERE backend_id = ?'
    )
      .bind('b1')
      .first()
    expect(stats).toEqual({ total: 1, success: 0, failure: 1 })
  }

  it('client cancellation after the first chunk cancels upstream, records failure and releases its slot', async () => {
    await seed(
      modelConfig({
        enableAffinity: true,
        backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })],
      })
    )
    const cancel = vi.fn()
    upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: first\n\n'))
            },
            cancel,
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
    )
    const { response, context } = await startStreamingProxy()
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    expect(await concurrency().count()).toBe(1)
    await reader.cancel('client stopped')
    await waitOnExecutionContext(context)
    expect(cancel).toHaveBeenCalledOnce()
    await expectFailedCompletion()
  })

  it('upstream stream errors after the first chunk record failure and release without affinity', async () => {
    await seed(
      modelConfig({
        enableAffinity: true,
        backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })],
      })
    )
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined
    upstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstreamController = controller
              controller.enqueue(new TextEncoder().encode('data: first\n\n'))
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
    )
    const { response, context } = await startStreamingProxy()
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    upstreamController!.error(new Error('Upstream disconnected'))
    await expect(reader.read()).rejects.toThrow('Upstream disconnected')
    await waitOnExecutionContext(context)
    await expectFailedCompletion()
  })

  it.each([true, false])(
    'client abort before upstream headers releases the slot (stream=%s)',
    async (stream) => {
      await seed(
        modelConfig({
          enableAffinity: true,
          backends: [createTestOpenAIBackend({ maxConcurrentRequests: 1 })],
        })
      )
      let upstreamStarted!: () => void
      const started = new Promise<void>((resolve) => {
        upstreamStarted = resolve
      })
      upstream((request) => {
        upstreamStarted()
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          })
        })
      })
      const abort = new AbortController()
      const context = createExecutionContext()
      const pending = worker.fetch(
        new Request('https://proxy.example/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${PROXY_KEY}`,
            'Content-Type': 'application/json',
            'X-Session-ID': 'interrupted',
          },
          body: JSON.stringify({ model: MODEL, messages: [], stream }),
          signal: abort.signal,
        }),
        env,
        context
      )
      await started
      try {
        expect(await concurrency().count()).toBe(1)
      } finally {
        abort.abort(new Error('Client disconnected'))
      }
      expect((await pending).status).toBe(500)
      await waitOnExecutionContext(context)
      await expectFailedCompletion()
    }
  )

  it.each([true, false])(
    'TTFT aborts fetch before headers arrive and falls back (stream=%s)',
    async (stream) => {
      await seed(
        modelConfig({
          backends: [
            createTestOpenAIBackend({
              maxConcurrentRequests: 1,
              streamingTTFTTimeout: 10,
              nonStreamingTTFTTimeout: 10,
            }),
            limitedBackends()[1],
          ],
        })
      )
      const aborted = vi.fn()
      upstream((request) => {
        if (new URL(request.url).hostname === 'b2.example')
          return new Response(stream ? 'recovered' : '"recovered"')
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => {
              aborted()
              reject(request.signal.reason)
            },
            { once: true }
          )
        })
      })
      const response = await proxy({ stream }, { 'X-Backend-ID': 'b1' })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(stream ? 'recovered' : '"recovered"')
      expect(aborted).toHaveBeenCalledOnce()
      expect(await concurrency().count()).toBe(0)
      expect(await concurrency('b2').count()).toBe(0)
    }
  )
})

describe('Session affinity routing', () => {
  it('writes mappings only after success and routes the same session consistently', async () => {
    await seed(modelConfig({ enableAffinity: true, backends: twoBackends() }))
    const hosts: string[] = []
    upstream((req) => {
      hosts.push(new URL(req.url).hostname)
      return jsonResponse({ ok: true })
    })
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1)
    expect((await proxy({}, { 'X-Session-ID': 'session' })).status).toBe(200)
    random.mockReturnValue(0.9)
    expect((await proxy({}, { 'X-Session-ID': 'session' })).status).toBe(200)
    expect(hosts).toEqual(['b1.example', 'b1.example'])
    const mapping = await env.DB.prepare(
      'SELECT backend_id, access_count FROM affinity_mappings WHERE model = ? AND session_id = ?'
    )
      .bind(MODEL, 'session')
      .first()
    expect(mapping).toEqual({ backend_id: 'b1', access_count: 2 })
    expect((await admin(`/affinity/${MODEL}/session`, 'DELETE')).status).toBe(200)
    await proxy({}, { 'X-Session-ID': 'session' })
    expect(hosts[2]).toBe('b2.example')
  })

  it.each(['disabled', 'zero', 'missing'])(
    'ignores and deletes mapping to unavailable backend: %s',
    async (state) => {
      await seed(
        modelConfig({
          enableAffinity: true,
          backends:
            state === 'missing'
              ? [createTestOpenAIBackend({ id: 'b2', enabled: false })]
              : [
                  createTestOpenAIBackend({
                    enabled: state !== 'disabled',
                    weight: state === 'zero' ? 0 : 1,
                  }),
                ],
        })
      )
      await insertAffinity('session', 'b1')
      expect((await proxy({}, { 'X-Session-ID': 'session' })).status).toBe(503)
      expect(await count('affinity_mappings')).toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('ignores mappings more than one hour old', async () => {
    await seed(modelConfig({ enableAffinity: true, backends: twoBackends() }))
    await insertAffinity('old-session', 'b1', Date.now() - 3_600_001)
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    let host = ''
    upstream((req) => {
      host = new URL(req.url).hostname
      return jsonResponse({ ok: true })
    })
    expect((await proxy({}, { 'X-Session-ID': 'old-session' })).status).toBe(200)
    expect(host).toBe('b2.example')
  })

  it('does not create a mapping for a failed request', async () => {
    await seed(modelConfig({ enableAffinity: true }))
    upstream(() => new Response('failed', { status: 500 }))
    expect((await proxy({}, { 'X-Session-ID': 'failed-session' })).status).toBe(500)
    expect(await count('affinity_mappings')).toBe(0)
  })
})
