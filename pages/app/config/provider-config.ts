/**
 * Provider configuration mapping for frontend
 * When adding a new provider, simply add its configuration here
 */

import type { ProviderType, OpenAIConfig, BedrockConfig } from '~/apis'

/**
 * Provider UI metadata
 */
export interface ProviderUIConfig {
  /** Display name */
  displayName: string
  /** Badge CSS classes */
  badgeClass: string
  /** Create default config */
  createDefaultConfig: () => OpenAIConfig | BedrockConfig
  /** Get config display text */
  getConfigDisplay: (config: OpenAIConfig | BedrockConfig) => string
  /** Config field name */
  configField: 'openaiConfig' | 'bedrockConfig'
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
export const getProviderConfigDisplay = (provider: ProviderType, config: any) =>
  PROVIDER_UI_CONFIG[provider].getConfigDisplay(config)
