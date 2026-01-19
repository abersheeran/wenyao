// Load balancing strategy types
export type LoadBalancingStrategy = 'weighted' | 'lowest-ttft' | 'min-error-rate'

// Provider types
export type ProviderType = 'openai' | 'bedrock'

// AWS Bedrock specific configuration
export interface BedrockConfig {
  region: string
  accessKeyId: string
  secretAccessKey: string
}

// OpenAI specific configuration
export interface OpenAIConfig {
  url: string
  apiKey: string
}

// Individual backend configuration (within a model config)
export interface BackendConfig {
  id: string
  provider: ProviderType
  weight: number
  enabled: boolean
  model?: string // Optional: Override the model name when forwarding to this backend
  streamingTTFTTimeout?: number // Optional: TTFT timeout in milliseconds for streaming requests
  nonStreamingTTFTTimeout?: number // Optional: TTFT timeout in milliseconds for non-streaming requests
  recordRequests?: boolean // Optional: Record all requests (URL, headers, body) to MongoDB
  maxConcurrentRequests?: number // Optional: Maximum concurrent requests (undefined/0 = no limit, >0 = specific limit)

  // Provider-specific configurations (one of these must be present based on provider type)
  openaiConfig?: OpenAIConfig
  bedrockConfig?: BedrockConfig
}

// Load balancing strategy options for min-error-rate
export interface MinErrorRateOptions {
  // Minimum number of requests before using actual error rate (default: 20)
  minRequests?: number
  // Error rate threshold for circuit breaking (default: 0.9, i.e., 90%)
  circuitBreakerThreshold?: number
  // Epsilon value to avoid division by zero (default: 0.001)
  epsilon?: number
  // Time window in minutes for calculating error rates (default: 15)
  timeWindowMinutes?: number
}

// Affinity mapping - maps session IDs to backends for KV cache reuse
export interface AffinityMapping {
  model: string // Model name (part of compound key)
  sessionId: string // Session ID from X-Session-ID header (part of compound key)
  backendId: string // Target backend ID
  createdAt: Date // When mapping was created
  lastAccessedAt: Date // Last time this mapping was used (for TTL cleanup)
  accessCount: number // Number of times accessed (monitoring metric)
}

// Model configuration - primary structure with model as unique key
export interface ModelConfig {
  model: string // Primary key - the model name (e.g., "gpt-4", "claude-3-sonnet")
  provider: ProviderType // Provider type for this model - all backends must use this provider
  backends: BackendConfig[] // Array of backend configurations for this model
  loadBalancingStrategy: LoadBalancingStrategy // Strategy for selecting backends
  minErrorRateOptions?: MinErrorRateOptions // Options for min-error-rate strategy
  enableAffinity?: boolean // Enable session-based backend affinity for KV cache reuse
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

// Recorded request data
export interface RecordedRequest {
  backendId: string
  model: string
  timestamp: Date
  url: string // Full request URL
  headers: Record<string, string> // Complete headers as-is
  body: string // Request body as string (JSON stringified)
}
