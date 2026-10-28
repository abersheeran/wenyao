import { ProviderRequestError } from './base-provider.js'
import { decodeZstd } from './jev-zstd.js'

const MAX_BODY_BYTES = 32 * 1024 * 1024

function tooLarge(): never {
  throw new ProviderRequestError('Request body exceeds 32 MiB', 413, 'body_too_large')
}

function join(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readLimited(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return join(chunks, length)
      length += value.byteLength
      if (length > MAX_BODY_BYTES) tooLarge()
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

function jsonObject(text: string): Record<string, unknown> {
  const body: unknown = JSON.parse(text)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ProviderRequestError('JSON object is required')
  return body as Record<string, unknown>
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
  return btoa(chunks.join(''))
}

async function multipart(bytes: Uint8Array, contentType: string): Promise<Record<string, unknown>> {
  const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData()
  const requests = form.getAll('request')
  if (requests.length !== 1)
    throw new ProviderRequestError('Exactly one JSON request part is required')
  const request = requests[0]
  const body = jsonObject(typeof request === 'string' ? request : await request.text())
  const used = new Set(['request'])
  const assets = body.assets
  if (assets && typeof assets === 'object') {
    for (const asset of Object.values(assets)) {
      if (!asset || typeof asset !== 'object' || typeof asset.part !== 'string') continue
      const name: string = asset.part
      const parts = form.getAll(name)
      if (used.has(name) || parts.length !== 1 || typeof parts[0] === 'string')
        throw new ProviderRequestError('Each image part must be referenced exactly once')
      used.add(name)
      const image = new Uint8Array(await parts[0].arrayBuffer())
      const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      const jpeg = [0xff, 0xd8, 0xff]
      const format = png.every((byte, i) => image[i] === byte)
        ? 'png'
        : jpeg.every((byte, i) => image[i] === byte)
          ? 'jpeg'
          : undefined
      if (!format) throw new ProviderRequestError('Only PNG and JPEG images are supported')
      asset.format = format
      asset.data_base64 = base64(image)
      delete asset.part
    }
  }
  for (const name of form.keys())
    if (!used.has(name))
      throw new ProviderRequestError('Each image part must be referenced exactly once')
  return body
}

export async function decodeJevBody(request: Request): Promise<Record<string, unknown>> {
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase() ?? 'identity'
  if (!['identity', 'gzip', 'x-gzip', 'zstd'].includes(encoding))
    throw new ProviderRequestError('Unsupported Content-Encoding', 415, 'unsupported_encoding')
  try {
    let bytes = await readLimited(request.body)
    if (encoding === 'gzip' || encoding === 'x-gzip')
      bytes = await readLimited(
        new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'))
      )
    else if (encoding === 'zstd') bytes = decodeZstd(bytes, MAX_BODY_BYTES)
    const contentType = request.headers.get('content-type') ?? ''
    return contentType.split(';')[0].trim().toLowerCase() === 'multipart/form-data'
      ? await multipart(bytes, contentType)
      : jsonObject(new TextDecoder().decode(bytes))
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error
    throw new ProviderRequestError('Invalid request body')
  }
}
