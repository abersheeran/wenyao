import { decompress } from 'zstdify/decompress'

import { ProviderRequestError } from './base-provider.js'

const MAX_WINDOW_BYTES = 8 * 1024 * 1024

export function decodeZstd(bytes: Uint8Array, maxSize: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  const requireBytes = (length: number): void => {
    if (offset + length > bytes.byteLength) throw new Error('Truncated zstd frame')
  }
  while (offset < bytes.byteLength) {
    requireBytes(4)
    const magic = view.getUint32(offset, true)
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      requireBytes(8)
      const length = view.getUint32(offset + 4, true)
      requireBytes(8 + length)
      offset += 8 + length
      continue
    }
    if (magic !== 0xfd2fb528) throw new Error('Invalid zstd frame')
    requireBytes(5)
    const descriptor = bytes[offset + 4]
    const singleSegment = (descriptor & 0x20) !== 0
    const sizeFlag = descriptor >> 6
    const sizeBytes = sizeFlag ? 1 << sizeFlag : singleSegment ? 1 : 0
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]
    const sizeOffset = offset + 5 + Number(!singleSegment) + dictionaryBytes
    requireBytes(sizeOffset - offset + sizeBytes)
    if (!singleSegment) {
      const window = bytes[offset + 5]
      const windowSize = 2 ** (10 + (window >> 3)) * (1 + (window & 7) / 8)
      if (windowSize > MAX_WINDOW_BYTES)
        throw new ProviderRequestError('Zstd window exceeds 8 MiB', 400, 'zstd_window_too_large')
    }
    offset = sizeOffset + sizeBytes
    let last = false
    while (!last) {
      requireBytes(3)
      const block = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
      const type = (block >> 1) & 3
      if (type === 3) throw new Error('Invalid zstd block')
      last = (block & 1) !== 0
      const length = type === 1 ? 1 : block >> 3
      requireBytes(3 + length)
      offset += 3 + length
    }
    if (descriptor & 4) {
      requireBytes(4)
      offset += 4
    }
  }
  try {
    // The decoder checks the limit after each block and across concatenated frames.
    return decompress(bytes, { maxSize, validateChecksum: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Decompressed size exceeds maxSize')
      throw new ProviderRequestError('Request body exceeds 32 MiB', 413, 'body_too_large')
    throw error
  }
}
