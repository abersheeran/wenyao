import { BaseProvider, prepareJsonHeaders } from './base-provider.js'

import type { StandardizedRequest } from './base-provider.js'
import type { ResolvedBackendConfig as BackendConfig } from '../types/backend.js'
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
    return prepareJsonHeaders(headers, backend.openaiConfig.apiKey)
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
