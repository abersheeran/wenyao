import type { BackendConfig } from '../types/backend.js'
import type { Context } from 'hono'

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'validation_failed'
  ) {
    super(message)
  }
}

export function prepareJsonHeaders(
  headers: Record<string, string>,
  apiKey: string
): Record<string, string> {
  const result: Record<string, string> = {}
  const blocked = new Set([
    'host',
    'content-length',
    'content-encoding',
    'authorization',
    'x-authorization',
    'x-real-ip',
    'cdn-loop',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer',
    'proxy-authorization',
    'proxy-authenticate',
  ])
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'connection')
      for (const field of value.split(',')) blocked.add(field.trim().toLowerCase())
  }
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!blocked.has(lower) && !lower.startsWith('cf-') && !lower.startsWith('x-forwarded-'))
      result[lower] = value
  }
  result.authorization = `Bearer ${apiKey}`
  result['content-type'] = 'application/json'
  return result
}

export function createErrorResponse(
  message: string,
  type: string,
  code: string,
  status: number
): Response {
  return Response.json({ error: { message, type, code } }, { status })
}

export interface StandardizedRequest {
  model: string
  stream: boolean
  originalHeaders: Record<string, string>
  originalBody: Record<string, unknown>
}

export abstract class BaseProvider {
  abstract readonly name: string
  readBody(c: Context): Promise<Record<string, unknown>> {
    return c.req.json<Record<string, unknown>>()
  }

  abstract validateRequest(c: Context, body: Record<string, unknown>): void
  abstract parseRequest(c: Context, body: Record<string, unknown>): StandardizedRequest
  abstract prepareHeaders(
    backend: BackendConfig,
    stream: boolean,
    url: string,
    headers: Record<string, string>,
    body: string
  ): Promise<Record<string, string>>
  abstract prepareRequestBody(
    request: StandardizedRequest,
    backend: BackendConfig
  ): Record<string, unknown>
  abstract getTargetUrl(backend: BackendConfig, request: StandardizedRequest): string
}
