/**
 * OpenAI provider implementation
 * Handles OpenAI-compatible API format
 */

import { BaseProvider } from './base-provider.js'

import type { StandardizedRequest } from './base-provider.js'
import type { BackendConfig } from '../types/backend.js'
import type { Context } from 'hono'

/**
 * OpenAI provider for handling OpenAI-compatible APIs
 */
export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai'

  validateRequest(_c: Context, requestBody: any): void {
    if (!requestBody.model) {
      throw new Error('Model is required in the request')
    }
  }

  parseRequest(c: Context, requestBody: any): StandardizedRequest {
    return {
      model: requestBody.model,
      stream: requestBody.stream ?? false,
      originalHeaders: c.req.header(),
      originalBody: requestBody,
    }
  }

  async prepareHeaders(
    backend: BackendConfig,
    stream: boolean,
    url: string,
    headers: Record<string, string>,
    requestBody: string
  ): Promise<Record<string, string>> {
    if (!backend.openaiConfig) {
      throw new Error('OpenAI configuration is missing for this backend')
    }

    const newHeaders = { ...headers }
    // Remove client headers that shouldn't be forwarded
    delete newHeaders['content-length']
    delete newHeaders['authorization']
    delete newHeaders['x-authorization']

    // Set backend's API key
    newHeaders['Authorization'] = `Bearer ${backend.openaiConfig.apiKey}`

    return newHeaders
  }

  prepareRequestBody(standardizedRequest: StandardizedRequest, backend: BackendConfig): any {
    // Use backend-specific model if configured, otherwise use original
    return {
      ...standardizedRequest.originalBody,
      model: backend.model || standardizedRequest.model,
    }
  }

  getTargetUrl(backend: BackendConfig, _standardizedRequest: StandardizedRequest): string {
    if (!backend.openaiConfig) {
      throw new Error('OpenAI configuration is missing for this backend')
    }
    return new URL('v1/chat/completions', backend.openaiConfig.url).toString()
  }
}
