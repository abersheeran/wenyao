// Load balancing strategy types
export type LoadBalancingStrategy = 'weighted' | 'lowest-ttft' | 'min-error-rate'

// Individual backend configuration (within a model config)
export interface BackendConfig {
  id: string
  url: string
  apiKey: string
  weight: number
  enabled: boolean
  model?: string // Optional: Override the model name when forwarding to this backend
}

// Model configuration - primary structure with model as unique key
export interface ModelConfig {
  model: string // Primary key - the model name (e.g., "gpt-4", "claude-3-sonnet")
  backends: BackendConfig[] // Array of backend configurations for this model
  loadBalancingStrategy: LoadBalancingStrategy // Strategy for selecting backends
}

// Statistics for each backend
export interface BackendStats {
  backendId: string
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  successRate: number
  averageStreamingTTFT: number // in milliseconds - for streaming requests
  averageNonStreamingTTFT: number // in milliseconds - for non-streaming requests
  ttftSamples: number[]
}

// Historical stats data point (stored in database)
export interface StatsDataPoint {
  instanceId: string // Unique identifier for the server instance
  backendId: string
  timestamp: Date // Time of the data point
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  successRate: number
  averageStreamingTTFT: number // in milliseconds - for streaming requests
  averageNonStreamingTTFT: number // in milliseconds - for non-streaming requests
  requestsInPeriod: number // Number of requests in this time period
}

// Historical stats query result
export interface HistoricalStats {
  backendId: string
  dataPoints: StatsDataPoint[]
  startTime: Date
  endTime: Date
}

// OpenAI Chat Completion Request
export interface ChatCompletionRequest {
  model: string
  messages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: string
  }>
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  [key: string]: any
}

// OpenAI Chat Completion Response (non-streaming)
export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
