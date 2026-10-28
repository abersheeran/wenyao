/**
 * Provider configuration mapping for frontend
 * When adding a new provider, simply add its configuration here
 */

import type { Connection, ProviderType, OpenAIConfig, BedrockConfig, JevConfig } from '~/apis'

/**
 * Provider UI metadata
 */
export interface ProviderUIConfig {
  /** Display name */
  displayName: string
  /** Badge CSS classes */
  badgeClass: string
  /** Create default config */
  createDefaultConfig: () => OpenAIConfig | BedrockConfig | JevConfig
  /** Get config display text */
  getConfigDisplay: (config: OpenAIConfig | BedrockConfig | JevConfig) => string
  /** Config field name */
  configField: 'openaiConfig' | 'bedrockConfig' | 'jevConfig'
}

/**
 * Provider configuration map
 * Add new providers here
 */
export const PROVIDER_UI_CONFIG: Record<ProviderType, ProviderUIConfig> = {
  openai: {
    displayName: 'OpenAI',
    badgeClass: 'bg-emerald-100 text-emerald-800',
    createDefaultConfig: () => ({ url: '', apiKey: '' }),
    getConfigDisplay: (config) => (config as OpenAIConfig).url,
    configField: 'openaiConfig',
  },
  bedrock: {
    displayName: 'AWS Bedrock',
    badgeClass: 'bg-orange-100 text-orange-800',
    createDefaultConfig: () => ({
      region: 'us-east-1',
      accessKeyId: '',
      secretAccessKey: '',
    }),
    getConfigDisplay: (config) => (config as BedrockConfig).region,
    configField: 'bedrockConfig',
  },
  jev: {
    displayName: 'Jev',
    badgeClass: 'bg-violet-100 text-violet-800',
    createDefaultConfig: () => ({ url: 'https://api.typesafe.ai', apiKey: '' }),
    getConfigDisplay: (config) => (config as JevConfig).url,
    configField: 'jevConfig',
  },
}

/** Get provider UI config */
export const getProviderConfig = (provider: ProviderType) => PROVIDER_UI_CONFIG[provider]

/** Get provider display name */
export const getProviderDisplayName = (provider: ProviderType) =>
  PROVIDER_UI_CONFIG[provider].displayName

/** Get provider badge class */
export const getProviderBadgeClass = (provider: ProviderType) =>
  PROVIDER_UI_CONFIG[provider].badgeClass

/** Create default provider config */
export const createDefaultProviderConfig = (provider: ProviderType) =>
  PROVIDER_UI_CONFIG[provider].createDefaultConfig()

/** Get config display text */
export const getProviderConfigDisplay = (provider: ProviderType, config: OpenAIConfig | BedrockConfig | JevConfig) =>
  PROVIDER_UI_CONFIG[provider].getConfigDisplay(config)

/** Get a connection's URL or region */
export const getConnectionConfigDisplay = (connection: Connection) => {
  switch (connection.provider) {
    case 'openai':
      return getProviderConfigDisplay(connection.provider, connection.openaiConfig)
    case 'bedrock':
      return getProviderConfigDisplay(connection.provider, connection.bedrockConfig)
    case 'jev':
      return getProviderConfigDisplay(connection.provider, connection.jevConfig)
  }
}
