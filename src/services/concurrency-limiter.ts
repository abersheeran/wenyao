import type { BackendConfig } from '../types/backend.js'

export class ConcurrencyLimiter {
  constructor(private readonly namespace: Env['CONCURRENCY']) {}

  async tryAcquire(backend: BackendConfig, slotId: string): Promise<boolean> {
    if (!backend.maxConcurrentRequests || backend.maxConcurrentRequests <= 0) return true
    try {
      return await this.stub(backend.id).acquire(slotId, backend.maxConcurrentRequests)
    } catch (error) {
      console.error(`Failed to acquire concurrency slot for ${backend.id}:`, error)
      return true
    }
  }

  async release(backendId: string, slotId: string): Promise<void> {
    try {
      await this.stub(backendId).release(slotId)
    } catch (error) {
      console.error(`Failed to release concurrency slot for ${backendId}:`, error)
    }
  }

  async getCount(backendId: string): Promise<number> {
    return this.stub(backendId).count()
  }

  private stub(backendId: string) {
    // This service is request-scoped. Never retain a stub across requests.
    return this.namespace.get(this.namespace.idFromName(backendId))
  }
}
