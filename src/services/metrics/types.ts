export interface TimeWindow {
  startTime: Date
  endTime: Date
}

export interface RequestCompleteData {
  backendId: string
  requestId: string
  status: 'success' | 'failure'
  duration: number
  ttft?: number
  streamType?: 'streaming' | 'non-streaming'
  model?: string
  errorType?: string
}

export interface HistoryQueryParams {
  backendId?: string
  startTime: Date
  endTime: Date
  limit?: number
}

export interface MetricsTotals {
  backend_id: string
  total: number
  success: number
  failure: number
  streaming_ttft_sum: number
  streaming_ttft_count: number
  non_streaming_ttft_sum: number
  non_streaming_ttft_count: number
}
