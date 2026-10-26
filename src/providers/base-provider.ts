import type { BackendConfig } from '../types/backend.js'
import type { Context } from 'hono'

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
