import { BaseProvider } from './base-provider.js'

import type { StandardizedRequest } from './base-provider.js'
import type { BackendConfig } from '../types/backend.js'
import type { Context } from 'hono'

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai'

  validateRequest(_c: Context, body: Record<string, unknown>): void {
    if (typeof body.model !== 'string' || !body.model)
      throw new Error('Model is required in the request')
  }

  parseRequest(c: Context, body: Record<string, unknown>): StandardizedRequest {
    return {
      model: body.model as string,
      stream: body.stream === true,
      originalHeaders: c.req.header(),
      originalBody: body,
    }
  }

  async prepareHeaders(
    backend: BackendConfig,
    _stream: boolean,
    _url: string,
    headers: Record<string, string>,
    _body: string
  ): Promise<Record<string, string>> {
    if (!backend.openaiConfig) throw new Error('OpenAI configuration is missing for this backend')
    const result: Record<string, string> = {}
    const blocked = new Set([
      'host',
      'content-length',
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
    result.authorization = `Bearer ${backend.openaiConfig.apiKey}`
    result['content-type'] = 'application/json'
    return result
  }

  prepareRequestBody(
    request: StandardizedRequest,
    backend: BackendConfig
  ): Record<string, unknown> {
    return { ...request.originalBody, model: backend.model || request.model }
  }

  getTargetUrl(backend: BackendConfig, _request: StandardizedRequest): string {
    if (!backend.openaiConfig) throw new Error('OpenAI configuration is missing for this backend')
    return new URL('v1/chat/completions', backend.openaiConfig.url).toString()
  }
}
