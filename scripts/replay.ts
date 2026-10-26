#!/usr/bin/env tsx

import type { RecordedRequest } from '../src/types/backend.js'

/** Usage: tsx scripts/replay.ts [target_url] [backend_id] [limit] [concurrency] */
async function main(): Promise<void> {
  const targetUrl = new URL(process.argv[2] || 'http://localhost:8787/v1/chat/completions')
  const backendId = process.argv[3]
  const limit = Number(process.argv[4] || '10')
  const concurrency = Number(process.argv[5] || '1')
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('limit and concurrency must be positive integers')
  }
  const adminKey = process.env.ADMIN_API_KEY
  const proxyKey = process.env.PROXY_API_KEY
  if (!adminKey || !proxyKey) throw new Error('ADMIN_API_KEY and PROXY_API_KEY are required')
  const adminUrl = new URL('/admin/recorded-requests', process.env.ADMIN_URL || targetUrl.origin)
  if (backendId) adminUrl.searchParams.set('backendId', backendId)
  const requests: RecordedRequest[] = []
  // The management endpoint has a per-page limit, so preserve arbitrary CLI limits.
  while (requests.length < limit) {
    adminUrl.searchParams.set('limit', String(Math.min(100, limit - requests.length)))
    adminUrl.searchParams.set('offset', String(requests.length))
    const response = await fetch(adminUrl, { headers: { Authorization: `Bearer ${adminKey}` } })
    if (!response.ok) throw new Error(`Failed to fetch recordings: HTTP ${response.status}`)
    const page = (await response.json()) as { requests: RecordedRequest[]; total: number }
    requests.push(...page.requests)
    if (page.requests.length === 0 || requests.length >= page.total) break
  }
  if (requests.length === 0) {
    console.log('No recorded requests found')
    return
  }
  let index = 0
  let successCount = 0
  let failureCount = 0
  async function worker(): Promise<void> {
    while (index < requests.length) {
      const current = index++
      const recording = requests[current]
      const start = Date.now()
      try {
        const payload = JSON.parse(recording.body) as Record<string, unknown>
        if (recording.model) payload.model = recording.model
        const headers = new Headers(recording.headers)
        // Rebuild transport headers and authentication for the new destination.
        for (const name of [...headers.keys()]) {
          if (
            /^(host|content-length|authorization|x-authorization|connection|transfer-encoding|accept-encoding|x-real-ip|cdn-loop)$|^(cf-|x-forwarded-)/i.test(
              name
            )
          )
            headers.delete(name)
        }
        headers.set('Authorization', `Bearer ${proxyKey}`)
        headers.set('Content-Type', 'application/json')
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        })
        if (response.ok) {
          // Drain SSE/binary responses so duration and concurrency cover completion.
          if (response.body) {
            const reader = response.body.getReader()
            while (!(await reader.read()).done) {
              /* drain */
            }
          }
          successCount++
          console.log(
            `[${current + 1}/${requests.length}] ${recording.model}: ${response.status} (${Date.now() - start} ms)`
          )
        } else {
          const error = await response.text()
          failureCount++
          console.log(
            `[${current + 1}/${requests.length}] ${recording.model}: ${response.status} ${error.slice(0, 200)}`
          )
        }
      } catch (error) {
        failureCount++
        console.log(
          `[${current + 1}/${requests.length}] Failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()))
  console.log(
    `Replayed ${requests.length} requests: ${successCount} succeeded, ${failureCount} failed`
  )
  if (failureCount > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
