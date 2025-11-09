// API Key configuration stored in database
export interface ApiKey {
  key: string // The API key itself (unique)
  description: string // Description of the API key
  models: string[] // List of models this key can access
  createdAt: Date // Creation timestamp
  lastUsedAt?: Date // Last time this key was used (optional)
}
