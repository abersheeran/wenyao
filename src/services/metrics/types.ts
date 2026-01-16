// Metrics data point stored per request in MongoDB
export interface MetricsDataPoint {
  instanceId: string
  backendId: string
  timestamp: Date

  // Per-request metrics
  requestId: string
  status: 'success' | 'failure'
  duration: number // Total request duration (ms)
  ttft?: number // Time to first token (ms)
  streamType?: 'streaming' | 'non-streaming'

  // Optional metadata
  model?: string
  errorType?: string
}

// Time window specification for queries
export interface TimeWindow {
  startTime: Date
  endTime: Date
}

// Request completion data (passed to metrics collector)
export interface RequestCompleteData {
  backendId: string
  requestId: string
  status: 'success' | 'failure'
  duration: number // milliseconds
  ttft?: number // milliseconds
  streamType?: 'streaming' | 'non-streaming'
  model?: string
  errorType?: string
}

// Historical stats query parameters
export interface HistoryQueryParams {
  backendId?: string
  instanceId?: string
  startTime: Date
  endTime: Date
  limit?: number
}
