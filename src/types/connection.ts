import type { BedrockConfig, OpenAIConfig } from './backend.js'

export type Connection =
  | { id: string; provider: 'openai'; openaiConfig: OpenAIConfig }
  | { id: string; provider: 'bedrock'; bedrockConfig: BedrockConfig }
