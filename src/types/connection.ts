import type { BedrockConfig, JevConfig, OpenAIConfig } from './backend.js'

export type Connection =
  | { id: string; name: string; provider: 'openai'; openaiConfig: OpenAIConfig }
  | { id: string; name: string; provider: 'bedrock'; bedrockConfig: BedrockConfig }
  | { id: string; name: string; provider: 'jev'; jevConfig: JevConfig }
