/**
 * AWS Bedrock provider implementation
 * Handles AWS Bedrock Claude API format with AWS Signature V4
 */

import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@aws-sdk/protocol-http'
import { SignatureV4 } from '@aws-sdk/signature-v4'

import { BaseProvider } from './base-provider.js'

import type { StandardizedRequest } from './base-provider.js'
import type { BackendConfig } from '../types/backend.js'
import type { Context } from 'hono'

/**
 * Bedrock provider for handling AWS Bedrock Claude API
 */
export class BedrockProvider extends BaseProvider {
  readonly name = 'bedrock'

  validateRequest(_c: Context, requestBody: any): void {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      throw new Error('Messages array is required in the request')
    }
    if (requestBody.messages.length === 0) {
      throw new Error('Messages array cannot be empty')
    }
  }

  parseRequest(c: Context, requestBody: any): StandardizedRequest {
    // Extract model from URL path parameter
    // Bedrock format: /model/{model-id}/invoke or /model/{model-id}/invoke-with-response-stream
    const model = c.req.param('modelId')

    if (!model) {
      throw new Error('Model ID not found in URL path')
    }

    // Determine if streaming based on URL endpoint
    const url = new URL(c.req.url)
    const isStreaming = url.pathname.includes('/invoke-with-response-stream')

    return {
      model,
      stream: isStreaming,
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
    if (!backend.bedrockConfig) {
      throw new Error('Bedrock configuration is missing for this backend')
    }

    const urlObj = new URL(url)

    // Create AWS credentials
    const credentials = {
      accessKeyId: backend.bedrockConfig.accessKeyId,
      secretAccessKey: backend.bedrockConfig.secretAccessKey,
    }

    // Create HTTP request for signing
    const httpRequest = new HttpRequest({
      method: 'POST',
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'application/vnd.amazon.eventstream' : 'application/json',
        host: urlObj.hostname,
      },
      body: requestBody,
    })

    // Create signer
    const signer = new SignatureV4({
      credentials,
      region: backend.bedrockConfig.region,
      service: 'bedrock',
      sha256: Sha256,
    })

    // Sign the request
    const signedRequest = await signer.sign(httpRequest)

    // Return signed headers
    return signedRequest.headers as Record<string, string>
  }

  prepareRequestBody(standardizedRequest: StandardizedRequest, backend: BackendConfig): any {
    const body = { ...standardizedRequest.originalBody }

    // Ensure anthropic_version is set
    if (!body.anthropic_version) {
      body.anthropic_version = 'bedrock-2023-05-31'
    }

    return body
  }

  getTargetUrl(backend: BackendConfig, standardizedRequest: StandardizedRequest): string {
    if (!backend.bedrockConfig) {
      throw new Error('Bedrock configuration is missing for this backend')
    }

    // Construct Bedrock Runtime URL
    const baseUrl = `https://bedrock-runtime.${backend.bedrockConfig.region}.amazonaws.com`

    // Use backend-specific model if configured, otherwise use the model from request
    const model = backend.model || standardizedRequest.model

    // Bedrock URLs need model in path and endpoint based on streaming
    // Format: https://bedrock-runtime.{region}.amazonaws.com/model/{model-id}/invoke
    // or /model/{model-id}/invoke-with-response-stream
    const endpoint = standardizedRequest.stream ? 'invoke-with-response-stream' : 'invoke'

    const url = new URL(`/model/${model}/${endpoint}`, baseUrl)
    return url.toString()
  }

  /**
   * Bedrock uses binary event-stream format for streaming responses
   */
  protected useBinaryStream(): boolean {
    return true
  }

  protected processChunk(chunk: string | Uint8Array): string | Uint8Array {
    // For Bedrock, return chunk as-is (binary event-stream)
    return chunk
  }
}
