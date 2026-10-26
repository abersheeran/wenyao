import { ConfigManager } from '../services/config-manager.js'

import type { HonoEnv } from '../types/context.js'
import type { Context, Next } from 'hono'

function token(header?: string): string | undefined {
  return header?.match(/^Bearer ([^\s]+)$/)?.[1]
}

function authMessage(header?: string): string {
  if (!header) return 'Missing Authorization header'
  if (!token(header)) return 'Invalid Authorization header format. Expected: Bearer <token>'
  return 'Invalid API key'
}

export async function adminAuth(c: Context<HonoEnv>, next: Next) {
  const keys = (c.env.ADMIN_APIKEYS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
  if (!keys.length) return c.json({ error: 'Admin API keys are not configured' }, 503)
  const header = c.req.header('Authorization')
  const key = token(header)
  if (!key || !keys.includes(key))
    return c.json({ error: 'Unauthorized', message: authMessage(header) }, 401)
  await next()
}

const lastWrites = new Map<string, number>()
export async function proxyAuth(c: Context<HonoEnv>, next: Next) {
  const header = c.req.header('X-Authorization') ?? c.req.header('Authorization')
  const key = token(header)
  if (!key) return c.json({ error: 'Unauthorized', message: authMessage(header) }, 401)
  let snapshot
  try {
    snapshot = await new ConfigManager(c.env.DB).getSnapshot()
  } catch (error) {
    console.error('Configuration unavailable', error)
    return c.json({ error: 'Service Unavailable' }, 503)
  }
  const apiKey = snapshot.apiKeys.find((item) => item.key === key)
  if (!apiKey) return c.json({ error: 'Unauthorized', message: 'Invalid API key' }, 401)
  c.set('apiKey', apiKey)
  c.set('models', snapshot.models)
  const now = Date.now()
  if (now - (lastWrites.get(key) ?? 0) >= 60_000) {
    lastWrites.set(key, now)
    if (lastWrites.size > 10_000) {
      for (const [key, timestamp] of lastWrites)
        if (timestamp <= now - 60_000) lastWrites.delete(key)
    }
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE key = ?')
        .bind(now, key)
        .run()
        .catch((error) => {
          if (lastWrites.get(key) === now) lastWrites.delete(key)
          console.error('API key usage update failed', error)
        })
    )
  }
  await next()
}
