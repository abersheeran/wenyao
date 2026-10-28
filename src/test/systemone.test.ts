import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

import {
  CONCATENATED_ZSTD_BASE64,
  JPEG_BASE64,
  JSON_ZSTD_BASE64,
  LARGE_WINDOW_ZSTD_BASE64,
  MULTIPART_ZSTD_BASE64,
  OVERSIZED_FCS_ZSTD_BASE64,
  PNG_BASE64,
  UNKNOWN_SIZE_ZSTD_BOMB_BASE64,
} from './fixtures/systemone.js'
import {
  createTestBedrockBackend,
  createTestJevBackend,
  insertAffinity,
  jsonResponse,
  MODEL,
  modelConfig,
  PROXY_KEY,
  request,
  seed,
  seedJevConnections,
  upstream,
} from './helpers.js'
import { LoadBalancer } from '../services/load-balancer.js'

import type { ModelConfig } from '../types/backend.js'

function jevModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return modelConfig({ provider: 'jev', backends: [createTestJevBackend()], ...overrides })
}

async function seedJev(config = jevModelConfig(), models = [config.model]): Promise<void> {
  await seedJevConnections()
  await seed(config, models)
}

const path = '/v1/systemone'
const encoder = new TextEncoder()
const boundary = 'wenyao-systemone-test'
const multipartContentType = `multipart/form-data; boundary=${boundary}`
const compressedBody = {
  model: MODEL,
  state: 'x'.repeat(2048),
  questions: [{ question: 'Ready?', answers: ['yes', 'no'] }],
}
const multipartPayload = {
  model: MODEL,
  state: { text: 'Choose an image' },
  questions: [],
  assets: {
    front: { type: 'image', part: 'png-image' },
    back: { type: 'image', part: 'jpeg-image' },
  },
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

const imageParts = [
  { name: 'png-image', bytes: fromBase64(PNG_BASE64), contentType: 'application/octet-stream' },
  { name: 'jpeg-image', bytes: fromBase64(JPEG_BASE64), contentType: 'image/jpeg' },
]

function multipartBody(
  payload: unknown = multipartPayload,
  parts: { name: string; bytes: Uint8Array; contentType: string }[] = imageParts,
  requestPart: string | null = JSON.stringify(payload)
) {
  const chunks: Uint8Array[] = []
  if (requestPart !== null)
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${requestPart}\r\n`
      )
    )
  for (const part of parts) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.name}"\r\nContent-Type: ${part.contentType}\r\n\r\n`
      ),
      part.bytes,
      encoder.encode('\r\n')
    )
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`))
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function encodedSystemone(body: BodyInit, headers: HeadersInit = {}) {
  const requestHeaders = new Headers({
    Authorization: `Bearer ${PROXY_KEY}`,
    'Content-Type': 'application/json',
  })
  new Headers(headers).forEach((value, name) => requestHeaders.set(name, value))
  return request(path, {
    method: 'POST',
    headers: requestHeaders,
    body,
  })
}

async function gzip(body: BodyInit) {
  const compressed = new Response(body).body!.pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(compressed).arrayBuffer())
}

async function expectInvalidBody(response: Response, status = 400) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error' } })
  expect(fetch).not.toHaveBeenCalled()
}

function systemone(body: unknown = { model: MODEL }, headers: HeadersInit = {}) {
  return encodedSystemone(JSON.stringify(body), headers)
}

function twoBackends() {
  return [
    createTestJevBackend({ maxConcurrentRequests: 1 }),
    createTestJevBackend({
      id: 'b2',
      connectionId: 'jev-second',
      maxConcurrentRequests: 1,
    }),
  ]
}

function concurrency(backendId = 'b1') {
  return env.CONCURRENCY.get(env.CONCURRENCY.idFromName(backendId))
}

describe('System One API proxy', () => {
  it('rewrites the model and auth, preserves fields and JSON bytes, and records the exchange', async () => {
    await seedJev(
      jevModelConfig({
        backends: [
          createTestJevBackend({
            model: 'jev-1.14',
            recordRequests: true,
            recordResponses: true,
          }),
        ],
      })
    )
    const body = {
      model: MODEL,
      state: { text: '文鳐', nested: [1, null, true] },
      questions: [{ question: 'Proceed?', answers: ['yes', 'no'] }],
      assets: { image: { type: 'image', format: 'png', data_base64: 'aW1hZ2U=' } },
      provider: { order: ['TypeSafe'] },
      session_id: 'upstream-session',
    }
    const bytes = new TextEncoder().encode(
      ' { "id": "systemone-1", "model": "jev-1.14", "provider": "TypeSafe", "answers": ["文鳐"], "usage": {} }\n'
    )
    upstream(async (req) => {
      expect(req.url).toBe('https://jev.example/v1/systemone')
      expect(req.method).toBe('POST')
      expect(req.headers.get('authorization')).toBe('Bearer jev-upstream-secret')
      expect(req.headers.get('content-type')).toBe('application/json')
      for (const name of ['x-authorization', 'cf-ray', 'x-forwarded-for', 'x-private'])
        expect(req.headers.has(name), name).toBe(false)
      expect(req.headers.get('x-custom')).toBe('keep-me')
      expect(req.headers.get('typesafe-danger-zone-images')).toBe('true')
      expect(req.headers.get('typesafe-danger-zone-long-context')).toBe('true')
      expect(req.headers.get('x-typesafe-client')).toBe('official-sdk')
      expect(await req.json()).toEqual({ ...body, model: 'jev-1.14' })
      return new Response(bytes, {
        status: 201,
        headers: { 'Content-Type': 'application/json', 'X-TypeSafe-Request-ID': 'systemone-trace' },
      })
    })
    const response = await systemone(body, {
      'X-Authorization': `Bearer ${PROXY_KEY}`,
      'CF-Ray': 'client-ray',
      'X-Forwarded-For': '192.0.2.1',
      Connection: 'x-private',
      'X-Private': 'remove-me',
      'X-Custom': 'keep-me',
      'TypeSafe-Danger-Zone-Images': 'true',
      'TypeSafe-Danger-Zone-Long-Context': 'true',
      'X-TypeSafe-Client': 'official-sdk',
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('x-typesafe-request-id')).toBe('systemone-trace')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    const recorded = await env.DB.prepare(
      'SELECT id, url, headers, response_status, response_error FROM recorded_requests'
    ).first<{
      id: string
      url: string
      headers: string
      response_status: number
      response_error: string | null
    }>()
    expect(recorded).toMatchObject({
      url: 'https://jev.example/v1/systemone',
      response_status: 201,
      response_error: null,
    })
    expect(JSON.parse(recorded!.headers).authorization).toBe('Bearer jev-upstream-secret')
    expect(await (await env.RECORDINGS.get(`recorded-requests/${recorded!.id}`))!.json()).toEqual({
      ...body,
      model: 'jev-1.14',
    })
    expect(
      new Uint8Array(
        await (await env.RECORDINGS.get(`recorded-responses/${recorded!.id}`))!.arrayBuffer()
      )
    ).toEqual(bytes)
  })

  it('validates JSON and falls back with non-streaming metrics even when stream is true', async () => {
    await seedJev(jevModelConfig({ backends: twoBackends() }))
    const select = vi.spyOn(LoadBalancer.prototype, 'selectBackend')
    const urls: string[] = []
    upstream(async (req) => {
      urls.push(req.url)
      expect(await req.json()).toEqual({ model: MODEL, stream: true })
      return new URL(req.url).hostname === 'jev.example'
        ? new Response('data: this is not JSON\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          })
        : jsonResponse({ answers: ['recovered'] })
    })
    const response = await systemone({ model: MODEL, stream: true }, { 'X-Backend-ID': 'b1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answers: ['recovered'] })
    expect(urls).toEqual(['https://jev.example/v1/systemone', 'https://jev2.example/v1/systemone'])
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL }), 'b1', false)
    const stats = await env.DB.prepare(
      `SELECT backend_id, total, success, failure, streaming_ttft_count, non_streaming_ttft_count
       FROM backend_stats_minute ORDER BY backend_id`
    ).all()
    expect(stats.results).toEqual([
      {
        backend_id: 'b1',
        total: 1,
        success: 0,
        failure: 1,
        streaming_ttft_count: 0,
        non_streaming_ttft_count: 0,
      },
      {
        backend_id: 'b2',
        total: 1,
        success: 1,
        failure: 0,
        streaming_ttft_count: 0,
        non_streaming_ttft_count: 1,
      },
    ])
    expect(await concurrency().count()).toBe(0)
    expect(await concurrency('b2').count()).toBe(0)
  })

  it('falls back after an upstream 5xx and returns the second backend response', async () => {
    await seedJev(jevModelConfig({ backends: twoBackends() }))
    const hosts: string[] = []
    upstream((req) => {
      const host = new URL(req.url).hostname
      hosts.push(host)
      return host === 'jev.example'
        ? jsonResponse({ error: { code: 'unavailable', message: 'Try later' } }, 503)
        : new Response(' {"answers": ["second"]}\n', { status: 202 })
    })
    const response = await systemone({ model: MODEL }, { 'X-Backend-ID': 'b1' })
    expect(hosts).toEqual(['jev.example', 'jev2.example'])
    expect(response.status).toBe(202)
    expect(await response.text()).toBe(' {"answers": ["second"]}\n')
    expect(await concurrency().count()).toBe(0)
    expect(await concurrency('b2').count()).toBe(0)
  })

  it('uses the non-streaming timeout even when stream is true', async () => {
    await seedJev(
      jevModelConfig({
        backends: [
          {
            ...twoBackends()[0],
            streamingTTFTTimeout: 0,
            nonStreamingTTFTTimeout: 10,
          },
          twoBackends()[1],
        ],
      })
    )
    const cancel = vi.fn()
    upstream((req) =>
      new URL(req.url).hostname === 'jev.example'
        ? new Response(new ReadableStream({ cancel }))
        : jsonResponse({ answers: ['recovered'] })
    )
    const response = await systemone({ model: MODEL, stream: true }, { 'X-Backend-ID': 'b1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answers: ['recovered'] })
    expect(cancel).toHaveBeenCalledOnce()
    expect(await concurrency().count()).toBe(0)
  })

  it('uses session affinity and permits X-Backend-ID to override it', async () => {
    await seedJev(jevModelConfig({ enableAffinity: true, backends: twoBackends() }))
    await insertAffinity('systemone-session', 'b2')
    const hosts: string[] = []
    upstream((req) => {
      hosts.push(new URL(req.url).hostname)
      return jsonResponse({ answers: [] })
    })
    expect(
      (await systemone({ model: MODEL }, { 'X-Session-ID': 'systemone-session' })).status
    ).toBe(200)
    expect(
      (
        await systemone(
          { model: MODEL },
          { 'X-Session-ID': 'systemone-session', 'X-Backend-ID': 'b1' }
        )
      ).status
    ).toBe(200)
    expect(hosts).toEqual(['jev2.example', 'jev.example'])
    const mapping = await env.DB.prepare(
      'SELECT backend_id, access_count FROM affinity_mappings WHERE model = ? AND session_id = ?'
    )
      .bind(MODEL, 'systemone-session')
      .first()
    expect(mapping).toEqual({ backend_id: 'b1', access_count: 3 })
  })

  it('skips a backend at capacity and releases the successful fallback slot', async () => {
    await seedJev(jevModelConfig({ backends: twoBackends() }))
    expect(await concurrency().acquire('occupied', 1)).toBe(true)
    const hosts: string[] = []
    upstream((req) => {
      hosts.push(new URL(req.url).hostname)
      return jsonResponse({ answers: [] })
    })
    expect((await systemone({ model: MODEL }, { 'X-Backend-ID': 'b1' })).status).toBe(200)
    expect(hosts).toEqual(['jev2.example'])
    expect(await concurrency().count()).toBe(1)
    expect(await concurrency('b2').count()).toBe(0)
  })

  it.each([undefined, '', null, 42])('rejects an invalid model: %s', async (model) => {
    await seedJev()
    const response = await systemone({ model })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'validation_failed', message: 'Model is required in the request' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([null, [], 'text'])('requires a JSON object: %j', async (body) => {
    await seedJev()
    const response = await systemone(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'validation_failed', message: 'JSON object is required' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([{ model: MODEL }, { model: MODEL, state: false, questions: 'upstream validates' }])(
    'leaves state and questions validation to the upstream: %j',
    async (body) => {
      await seedJev()
      upstream(async (req) => {
        expect(await req.json()).toEqual(body)
        return jsonResponse({ answers: [] })
      })
      expect((await systemone(body)).status).toBe(200)
    }
  )

  it('returns 403 when the key cannot access the model', async () => {
    await seedJev(jevModelConfig(), ['other-model'])
    const response = await systemone()
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'model_not_allowed' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns 400 when an allowed model has no configuration', async () => {
    await seedJev(jevModelConfig(), ['missing'])
    const response = await systemone({ model: 'missing' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'model_not_found' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns provider_mismatch for a Bedrock model', async () => {
    await seedJev(jevModelConfig({ provider: 'bedrock', backends: [createTestBedrockBackend()] }))
    const response = await systemone()
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'provider_mismatch' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns provider_mismatch for an OpenAI model on System One', async () => {
    await seedJev(modelConfig())
    const response = await systemone()
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'provider_mismatch' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    '/v1/chat/completions',
    `/v1/model/${MODEL}/invoke`,
    `/v1/model/${MODEL}/invoke-with-response-stream`,
  ])('returns provider_mismatch for a Jev model on %s', async (route) => {
    await seedJev()
    const response = await request(route, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PROXY_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'provider_mismatch' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([undefined, 'Bearer invalid'])(
    'returns 401 for credentials: %s',
    async (authorization) => {
      await seedJev()
      const response = await request(path, {
        method: 'POST',
        headers: authorization ? { Authorization: authorization } : {},
        body: '{}',
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({
        error: 'Unauthorized',
        message: authorization ? 'Invalid API key' : 'Missing Authorization header',
      })
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('preserves authentication for unknown /v1 paths', async () => {
    const response = await request('/v1/unknown', { method: 'POST' })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Missing Authorization header',
    })
  })

  it('returns upstream validation errors and request IDs unchanged', async () => {
    await seedJev()
    const bytes = ' {"detail": [{"msg": "Invalid question"}]}\n'
    upstream(
      () =>
        new Response(bytes, {
          status: 422,
          headers: { 'X-TypeSafe-Request-ID': 'upstream-validation' },
        })
    )
    const response = await systemone()
    expect(response.status).toBe(422)
    expect(await response.text()).toBe(bytes)
    expect(response.headers.get('x-typesafe-request-id')).toBe('upstream-validation')
  })

  it('does not add a model listing route', async () => {
    await seedJev()
    const response = await request('/v1/models', {
      headers: { Authorization: `Bearer ${PROXY_KEY}` },
    })
    expect(response.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('System One request decoding', () => {
  it.each(['identity', 'gzip', 'x-gzip', 'zstd'])(
    'forwards %s JSON as uncompressed JSON',
    async (encoding) => {
      await seedJev()
      const bytes = encoder.encode(JSON.stringify(compressedBody))
      const body =
        encoding === 'zstd'
          ? fromBase64(JSON_ZSTD_BASE64)
          : encoding === 'identity'
            ? bytes
            : await gzip(bytes)
      upstream(async (req) => {
        expect(req.url).toBe('https://jev.example/v1/systemone')
        expect(req.headers.get('content-type')).toBe('application/json')
        expect(req.headers.has('content-encoding')).toBe(false)
        expect(await req.json()).toEqual(compressedBody)
        return jsonResponse({ answers: ['decoded'] })
      })
      const response = await encodedSystemone(body, { 'Content-Encoding': encoding })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ answers: ['decoded'] })
      expect(fetch).toHaveBeenCalledOnce()
    }
  )

  it.each(['identity', 'zstd'])(
    'inlines PNG and JPEG multipart images with %s encoding and records replayable JSON',
    async (encoding) => {
      await seedJev(jevModelConfig({ backends: [createTestJevBackend({ recordRequests: true })] }))
      const normalized = {
        ...multipartPayload,
        assets: {
          front: { type: 'image', format: 'png', data_base64: PNG_BASE64 },
          back: { type: 'image', format: 'jpeg', data_base64: JPEG_BASE64 },
        },
      }
      upstream(async (req) => {
        expect(req.headers.get('content-type')).toBe('application/json')
        expect(req.headers.has('content-encoding')).toBe(false)
        expect(await req.json()).toEqual(normalized)
        return jsonResponse({ answers: [] })
      })
      const response = await encodedSystemone(
        encoding === 'zstd' ? fromBase64(MULTIPART_ZSTD_BASE64) : multipartBody(),
        { 'Content-Type': multipartContentType, 'Content-Encoding': encoding }
      )
      expect(response.status, await response.clone().text()).toBe(200)
      const recorded = await env.DB.prepare(
        'SELECT id, url, headers FROM recorded_requests'
      ).first<{ id: string; url: string; headers: string }>()
      expect(recorded!.url).toBe('https://jev.example/v1/systemone')
      const headers = new Headers(JSON.parse(recorded!.headers))
      expect(headers.get('content-type')).toBe('application/json')
      expect(headers.has('content-encoding')).toBe(false)
      const recordedBody = await (await env.RECORDINGS.get(
        `recorded-requests/${recorded!.id}`
      ))!.json()
      expect(recordedBody).toEqual(normalized)
      // Replay submits this recorded JSON directly to the same proxy route.
      expect((await systemone(recordedBody)).status).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(2)
    }
  )

  it('base64 encodes a large image without overflowing the call stack', async () => {
    await seedJev()
    const png = fromBase64(PNG_BASE64)
    const bytes = new Uint8Array(256 * 1024)
    bytes.set(png)
    const payload = {
      model: MODEL,
      assets: { front: { type: 'image', part: 'large-image' } },
    }
    upstream(async (req) => {
      expect(await req.json()).toEqual({
        ...payload,
        assets: {
          front: {
            type: 'image',
            format: 'png',
            data_base64: btoa(atob(PNG_BASE64) + '\0'.repeat(bytes.byteLength - png.byteLength)),
          },
        },
      })
      return jsonResponse({ answers: [] })
    })
    const response = await encodedSystemone(
      multipartBody(payload, [{ name: 'large-image', bytes, contentType: 'image/png' }]),
      { 'Content-Type': multipartContentType }
    )
    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['br', 'gzip, zstd', 'gzip, gzip', 'identity, gzip'])(
    'rejects unsupported or layered Content-Encoding: %s',
    async (encoding) => {
      await seedJev()
      await expectInvalidBody(
        await encodedSystemone(JSON.stringify({ model: MODEL }), {
          'Content-Encoding': encoding,
        }),
        415
      )
    }
  )

  it.each(['gzip', 'zstd'])('rejects corrupt %s data', async (encoding) => {
    await seedJev()
    await expectInvalidBody(
      await encodedSystemone('this is not a compressed frame', { 'Content-Encoding': encoding })
    )
  })

  it.each(['a mismatched checksum', 'a truncated checksum'])(
    'rejects zstd with %s',
    async (damage) => {
      await seedJev()
      let bytes = fromBase64(JSON_ZSTD_BASE64)
      if (damage === 'a mismatched checksum') bytes[bytes.byteLength - 1] ^= 0xff
      else bytes = bytes.slice(0, -1)
      await expectInvalidBody(await encodedSystemone(bytes, { 'Content-Encoding': 'zstd' }))
    }
  )

  it('decodes concatenated zstd frames as one JSON request', async () => {
    await seedJev()
    upstream(async (req) => {
      expect(await req.json()).toEqual({
        model: MODEL,
        state: 'concatenated',
        questions: [],
      })
      expect(req.headers.has('content-encoding')).toBe(false)
      return jsonResponse({ answers: [] })
    })
    const response = await encodedSystemone(fromBase64(CONCATENATED_ZSTD_BASE64), {
      'Content-Encoding': 'zstd',
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    { name: 'an unknown-size frame expanding past 32 MiB', fixture: UNKNOWN_SIZE_ZSTD_BOMB_BASE64 },
    { name: 'an 8-byte declared content size above 32 MiB', fixture: OVERSIZED_FCS_ZSTD_BASE64 },
  ])('rejects zstd with $name', async ({ fixture }) => {
    await seedJev()
    await expectInvalidBody(
      await encodedSystemone(fromBase64(fixture), { 'Content-Encoding': 'zstd' }),
      413
    )
  })

  it('rejects a zstd frame whose window exceeds 8 MiB', async () => {
    await seedJev()
    await expectInvalidBody(
      await encodedSystemone(fromBase64(LARGE_WINDOW_ZSTD_BASE64), {
        'Content-Encoding': 'zstd',
      })
    )
  })

  it('accepts a zstd window of exactly 8 MiB', async () => {
    await seedJev()
    const bytes = fromBase64(JSON_ZSTD_BASE64)
    bytes[5] = 0x68 // Window_Log = 23 and no mantissa: exactly 8 MiB.
    upstream(async (req) => {
      expect(await req.json()).toEqual(compressedBody)
      return jsonResponse({ answers: [] })
    })
    const response = await encodedSystemone(bytes, {
      'Content-Encoding': 'zstd',
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('checks windows in later concatenated frames after a skippable frame', async () => {
    await seedJev()
    // These two frames form one valid JSON object, so a skipped window check would succeed.
    const bytes = fromBase64(CONCATENATED_ZSTD_BASE64)
    const secondOffset = bytes.findIndex(
      (value, index) =>
        index > 0 &&
        value === 0x28 &&
        bytes[index + 1] === 0xb5 &&
        bytes[index + 2] === 0x2f &&
        bytes[index + 3] === 0xfd
    )
    expect(secondOffset).toBeGreaterThan(0)
    bytes[secondOffset + 5] = 0x69 // The smallest representable window larger than 8 MiB.
    const skip = new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3])
    await expectInvalidBody(
      await encodedSystemone(
        new Uint8Array([
          ...bytes.subarray(0, secondOffset),
          ...skip,
          ...bytes.subarray(secondOffset),
        ]),
        { 'Content-Encoding': 'zstd' }
      )
    )
  })

  it('rejects a gzip bomb when decompressed bytes exceed 32 MiB', async () => {
    await seedJev()
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    let chunks = 0
    const compressed = await gzip(
      new ReadableStream({
        pull(controller) {
          if (chunks++ < 33) controller.enqueue(chunk)
          else controller.close()
        },
      })
    )
    expect(compressed.byteLength).toBeLessThan(64 * 1024)
    await expectInvalidBody(await encodedSystemone(compressed, { 'Content-Encoding': 'gzip' }), 413)
  })

  it.each(['identity', 'gzip'])(
    'counts raw %s request bytes while streaming and cancels after 32 MiB',
    async (encoding) => {
      await seedJev()
      const chunk = new Uint8Array(1024 * 1024)
      const cancel = vi.fn()
      let chunks = 0
      const body = new ReadableStream({
        pull(controller) {
          if (chunks++ < 100) controller.enqueue(chunk)
          else controller.close()
        },
        cancel,
      })
      await expectInvalidBody(await encodedSystemone(body, { 'Content-Encoding': encoding }), 413)
      expect(cancel).toHaveBeenCalledOnce()
      expect(chunks).toBeLessThan(100)
    }
  )

  it('rejects malformed JSON', async () => {
    await seedJev()
    await expectInvalidBody(await encodedSystemone('{"model":'))
  })

  it.each([
    {
      name: 'a non-PNG/JPEG image despite an image content type',
      payload: multipartPayload,
      parts: [
        { ...imageParts[0], bytes: encoder.encode('GIF89a'), contentType: 'image/png' },
        imageParts[1],
      ],
    },
    {
      name: 'a missing referenced image part',
      payload: multipartPayload,
      parts: [imageParts[0]],
    },
    {
      name: 'an unreferenced image part',
      payload: { ...multipartPayload, assets: { front: multipartPayload.assets.front } },
      parts: imageParts,
    },
    {
      name: 'an image part referenced twice',
      payload: {
        ...multipartPayload,
        assets: { front: multipartPayload.assets.front, back: multipartPayload.assets.front },
      },
      parts: [imageParts[0]],
    },
    {
      name: 'duplicate image part names',
      payload: { ...multipartPayload, assets: { front: multipartPayload.assets.front } },
      parts: [imageParts[0], imageParts[0]],
    },
  ])('rejects multipart with $name', async ({ payload, parts }) => {
    await seedJev()
    await expectInvalidBody(
      await encodedSystemone(multipartBody(payload, parts), {
        'Content-Type': multipartContentType,
      })
    )
  })

  it.each([null, 'not JSON', '[]', 'null'])(
    'rejects a missing or invalid multipart request part: %s',
    async (requestPart) => {
      await seedJev()
      await expectInvalidBody(
        await encodedSystemone(multipartBody(multipartPayload, imageParts, requestPart), {
          'Content-Type': multipartContentType,
        })
      )
    }
  )

  it('rejects duplicate request parts', async () => {
    await seedJev()
    await expectInvalidBody(
      await encodedSystemone(
        multipartBody({ model: MODEL }, [
          {
            name: 'request',
            bytes: encoder.encode(JSON.stringify({ model: MODEL })),
            contentType: 'application/json',
          },
        ]),
        { 'Content-Type': multipartContentType }
      )
    )
  })
})
