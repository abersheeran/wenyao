import { BaseProvider, prepareJsonHeaders } from './base-provider.js'
import { decodeJevBody } from './jev-request-body.js'

import type { StandardizedRequest } from './base-provider.js'
import type { ResolvedBackendConfig as BackendConfig } from '../types/backend.js'
import type { Context } from 'hono'

export class JevProvider extends BaseProvider {
  readonly name = 'jev'

  readBody(c: Context): Promise<Record<string, unknown>> {
    return decodeJevBody(c.req.raw)
  }

  validateRequest(_c: Context, body: Record<string, unknown>): void {
    if (typeof body.model !== 'string' || !body.model)
      throw new Error('Model is required in the request')
  }

  parseRequest(c: Context, body: Record<string, unknown>): StandardizedRequest {
    return {
      model: body.model as string,
      stream: false,
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
    if (!backend.jevConfig) throw new Error('Jev configuration is missing for this backend')
    return prepareJsonHeaders(headers, backend.jevConfig.apiKey)
  }

  prepareRequestBody(
    request: StandardizedRequest,
    backend: BackendConfig
  ): Record<string, unknown> {
    return { ...request.originalBody, model: backend.model || request.model }
  }

  getTargetUrl(backend: BackendConfig, _request: StandardizedRequest): string {
    if (!backend.jevConfig) throw new Error('Jev configuration is missing for this backend')
    return new URL('v1/systemone', backend.jevConfig.url).toString()
  }
}
