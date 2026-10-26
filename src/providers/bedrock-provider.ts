import { AwsV4Signer } from 'aws4fetch'

import { BaseProvider } from './base-provider.js'

import type { StandardizedRequest } from './base-provider.js'
import type { BackendConfig } from '../types/backend.js'
import type { Context } from 'hono'

export class BedrockProvider extends BaseProvider {
  readonly name = 'bedrock'

  validateRequest(_c: Context, body: Record<string, unknown>): void {
    if (!Array.isArray(body.messages) || body.messages.length === 0)
      throw new Error('Messages array is required and cannot be empty')
  }

  parseRequest(c: Context, body: Record<string, unknown>): StandardizedRequest {
    const model = c.req.param('modelId')
    if (!model) throw new Error('Model ID not found in URL path')
    return {
      model,
      stream: new URL(c.req.url).pathname.endsWith('/invoke-with-response-stream'),
      originalHeaders: c.req.header(),
      originalBody: body,
    }
  }

  async prepareHeaders(
    backend: BackendConfig,
    stream: boolean,
    url: string,
    _headers: Record<string, string>,
    body: string
  ): Promise<Record<string, string>> {
    if (!backend.bedrockConfig) throw new Error('Bedrock configuration is missing for this backend')
    const signer = new AwsV4Signer({
      ...backend.bedrockConfig,
      service: 'bedrock',
      method: 'POST',
      url,
      body,
      allHeaders: true,
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'application/vnd.amazon.eventstream' : 'application/json',
        'x-amz-content-sha256': await sha256(body),
      },
    })
    const signed = await signer.sign()
    return Object.fromEntries(signed.headers.entries())
  }

  prepareRequestBody(
    request: StandardizedRequest,
    _backend: BackendConfig
  ): Record<string, unknown> {
    return {
      ...request.originalBody,
      anthropic_version: request.originalBody.anthropic_version || 'bedrock-2023-05-31',
    }
  }

  getTargetUrl(backend: BackendConfig, request: StandardizedRequest): string {
    if (!backend.bedrockConfig) throw new Error('Bedrock configuration is missing for this backend')
    const model = encodeURI(backend.model || request.model)
    const endpoint = request.stream ? 'invoke-with-response-stream' : 'invoke'
    return `https://bedrock-runtime.${backend.bedrockConfig.region}.amazonaws.com/model/${model}/${endpoint}`
  }
}

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
