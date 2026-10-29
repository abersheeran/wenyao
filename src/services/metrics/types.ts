export interface TimeWindow {
  startTime: Date
  endTime: Date
}

export interface RequestCompleteData {
  model: string
  backendId: string
  requestId: string
  status: 'success' | 'failure'
  duration: number
  ttft?: number
  streamType?: 'streaming' | 'non-streaming'
  errorType?: string
}

export interface HistoryQueryParams {
  backend?: BackendIdentity
  startTime: Date
  endTime: Date
  limit?: number
  intervalMinutes?: number
}

export interface BackendIdentity {
  model: string
  backendId: string
}

export interface MetricsTotals {
  model: string
  backend_id: string
  total: number
  success: number
  failure: number
  streaming_ttft_sum: number
  streaming_ttft_count: number
  non_streaming_ttft_sum: number
  non_streaming_ttft_count: number
}
