import { mongoDBService } from './mongodb.js'
import type { RecordedRequest, BackendConfig } from '../types/backend.js'

export class RequestRecorder {
  /**
   * Record a request to MongoDB if backend has recording enabled
   * Non-blocking: errors are logged but don't affect request flow
   */
  async recordRequest(
    backend: BackendConfig,
    model: string,
    url: string,
    headers: Record<string, string>,
    body: any
  ): Promise<void> {
    // Skip if recording not enabled for this backend
    if (!backend.recordRequests) {
      return
    }

    // Skip if MongoDB not connected
    if (!mongoDBService.isConnected()) {
      console.warn(`[RequestRecorder] Cannot record request: MongoDB not connected`)
      return
    }

    try {
      const recordedRequest: RecordedRequest = {
        backendId: backend.id,
        model,
        timestamp: new Date(),
        url,
        headers: { ...headers }, // Clone headers
        body: typeof body === 'string' ? body : JSON.stringify(body)
      }

      // Insert asynchronously - don't await to avoid blocking
      mongoDBService
        .getRecordedRequestsCollection()
        .insertOne(recordedRequest)
        .catch(error => {
          console.error(`[RequestRecorder] Failed to record request for backend ${backend.id}:`, error)
        })

      console.log(`[RequestRecorder] Recorded request for backend ${backend.id}`)
    } catch (error) {
      console.error(`[RequestRecorder] Error preparing recorded request:`, error)
    }
  }
}

export const requestRecorder = new RequestRecorder()
