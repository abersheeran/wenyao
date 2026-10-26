import { Hono } from 'hono'

import admin from './routes/admin.js'
import proxy from './routes/proxy.js'

import type { Bindings, HonoEnv } from './types/context.js'

export { BackendConcurrency } from './durable-objects/backend-concurrency.js'

export const app = new Hono<HonoEnv>()

app.onError((error, c) => {
  console.error('Request failed', error)
  return c.json({ error: 'Internal Server Error' }, 500)
})
app.get('/health', (c) =>
  c.json({ service: 'OpenAI API Proxy', status: 'running', version: '1.0.0' })
)
app.route('/admin', admin)
app.route('/v1', proxy)
app.all('/admin/*', (c) => c.json({ error: 'Not Found' }, 404))
app.all('/v1/*', (c) => c.json({ error: 'Not Found' }, 404))
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export async function scheduled(
  _event: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  const now = Date.now()
  const cleanup = env.DB.batch([
    env.DB.prepare('DELETE FROM affinity_mappings WHERE last_accessed_at < ?').bind(
      now - 60 * 60_000
    ),
    env.DB.prepare('DELETE FROM backend_stats_minute WHERE minute < ?').bind(
      now - 30 * 24 * 60 * 60_000
    ),
  ]).then(() => undefined)
  ctx.waitUntil(cleanup)
  await cleanup
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Bindings>
