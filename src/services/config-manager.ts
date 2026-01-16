import type { ModelConfig, BackendConfig } from '../types/backend.js'
import { mongoDBService } from './mongodb.js'
import { affinityManager } from './affinity-manager.js'

export class ConfigManager {
  private modelConfigs: Map<string, ModelConfig> = new Map()
  private usesMongoDB: boolean = false

  // Initialize from MongoDB
  async initializeFromMongoDB(): Promise<void> {
    if (!mongoDBService.isConnected()) {
      console.log('MongoDB not connected, using in-memory storage')
      return
    }

    try {
      const collection = mongoDBService.getModelsCollection()
      const models = await collection.find().toArray()

      this.modelConfigs.clear()
      for (const model of models) {
        this.modelConfigs.set(model.model, model)
      }

      this.usesMongoDB = true
      console.log(`Loaded ${models.length} model configurations from MongoDB`)

      // Start watching for changes
      await this.startWatchingChanges()
    } catch (error) {
      console.error('Failed to initialize from MongoDB:', error)
      this.usesMongoDB = false
    }
  }

  // Watch for MongoDB changes
  private async startWatchingChanges(): Promise<void> {
    await mongoDBService.watchModels((modelConfig, operationType) => {
      switch (operationType) {
        case 'insert':
        case 'update':
        case 'replace':
          console.log(`MongoDB change detected: ${operationType} model ${modelConfig.model}`)
          this.modelConfigs.set(modelConfig.model, modelConfig)
          break
        case 'delete':
          console.log(`MongoDB change detected: delete model ${modelConfig.model}`)
          this.modelConfigs.delete(modelConfig.model)
          break
      }
    })
  }

  // Get all model configurations
  getAllModels(): ModelConfig[] {
    return Array.from(this.modelConfigs.values())
  }

  // Get model configuration by model name
  getModelConfig(model: string): ModelConfig | undefined {
    return this.modelConfigs.get(model)
  }

  // Get enabled backends for a specific model
  getEnabledBackends(model: string): BackendConfig[] {
    const modelConfig = this.modelConfigs.get(model)
    if (!modelConfig) {
      return []
    }
    return modelConfig.backends.filter(backend => backend.enabled)
  }

  // Get all enabled backends including those with weight=0 (for fallback)
  getAllEnabledBackends(model: string): BackendConfig[] {
    return this.getEnabledBackends(model)
  }

  // Get backends for load balancer selection (excluding weight=0)
  getBackendsForSelection(model: string): BackendConfig[] {
    return this.getEnabledBackends(model).filter(backend => backend.weight > 0)
  }

  // Get specific backend by model and backend ID
  getBackend(model: string, backendId: string): BackendConfig | undefined {
    const modelConfig = this.modelConfigs.get(model)
    if (!modelConfig) {
      return undefined
    }
    return modelConfig.backends.find(backend => backend.id === backendId)
  }

  // Add a new model configuration
  async addModelConfig(config: ModelConfig): Promise<ModelConfig> {
    if (this.modelConfigs.has(config.model)) {
      throw new Error(`Model configuration for ${config.model} already exists`)
    }

    if (this.usesMongoDB) {
      const collection = mongoDBService.getModelsCollection()
      await collection.insertOne(config)
      // Update in-memory immediately to avoid UI race with change stream
      this.modelConfigs.set(config.model, config)
    } else {
      this.modelConfigs.set(config.model, config)
    }

    return config
  }

  // Update an existing model configuration
  async updateModelConfig(model: string, updates: Partial<Omit<ModelConfig, 'model'>>): Promise<ModelConfig> {
    const modelConfig = this.modelConfigs.get(model)
    if (!modelConfig) {
      throw new Error(`Model configuration for ${model} not found`)
    }

    const updated = { ...modelConfig, ...updates }

    if (this.usesMongoDB) {
      const collection = mongoDBService.getModelsCollection()
      await collection.updateOne({ model }, { $set: updates })
      // Update in-memory immediately to avoid UI race with change stream
      this.modelConfigs.set(model, updated)
    } else {
      this.modelConfigs.set(model, updated)
    }

    return updated
  }

  // Delete a model configuration
  async deleteModelConfig(model: string): Promise<boolean> {
    if (!this.modelConfigs.has(model)) {
      return false
    }

    if (this.usesMongoDB) {
      const collection = mongoDBService.getModelsCollection()
      const result = await collection.deleteOne({ model })
      if (result.deletedCount && result.deletedCount > 0) {
        // Update in-memory immediately to avoid UI race with change stream
        this.modelConfigs.delete(model)

        // Clean up affinity mappings for deleted model
        await affinityManager.cleanupModelMappings(model)

        return true
      }
      return false
    } else {
      const deleted = this.modelConfigs.delete(model)
      if (deleted) {
        // Clean up affinity mappings for deleted model
        await affinityManager.cleanupModelMappings(model)
      }
      return deleted
    }
  }

  // Add a backend to an existing model configuration
  async addBackendToModel(model: string, backend: BackendConfig): Promise<ModelConfig> {
    const modelConfig = this.modelConfigs.get(model)
    if (!modelConfig) {
      throw new Error(`Model configuration for ${model} not found`)
    }

    // Check if backend ID already exists
    if (modelConfig.backends.some(b => b.id === backend.id)) {
      throw new Error(`Backend with id ${backend.id} already exists in model ${model}`)
    }

    const updatedBackends = [...modelConfig.backends, backend]

    if (this.usesMongoDB) {
      const collection = mongoDBService.getModelsCollection()
      await collection.updateOne({ model }, { $set: { backends: updatedBackends } })
      // Update in-memory immediately
      const updated = { ...modelConfig, backends: updatedBackends }
      this.modelConfigs.set(model, updated)
      return updated
    } else {
      const updated = { ...modelConfig, backends: updatedBackends }
      this.modelConfigs.set(model, updated)
      return updated
    }
  }

  // Update a specific backend within a model configuration
  async updateBackendInModel(model: string, backendId: string, updates: Partial<Omit<BackendConfig, 'id'>>): Promise<ModelConfig> {
    const modelConfig = this.modelConfigs.get(model)
    if (!modelConfig) {
      throw new Error(`Model configuration for ${model} not found`)
    }

    const backendIndex = modelConfig.backends.findIndex(b => b.id === backendId)
    if (backendIndex === -1) {
      throw new Error(`Backend with id ${backendId} not found in model ${model}`)
    }

    const updatedBackends = [...modelConfig.backends]
    updatedBackends[backendIndex] = { ...updatedBackends[backendIndex], ...updates }

    if (this.usesMongoDB) {
      const collection = mongoDBService.getModelsCollection()
      await collection.updateOne({ model }, { $set: { backends: updatedBackends } })
      // Update in-memory immediately
      const updated = { ...modelConfig, backends: updatedBackends }
      this.modelConfigs.set(model, updated)
      return updated
    } else {
      const updated = { ...modelConfig, backends: updatedBackends }
      this.modelConfigs.set(model, updated)
      return updated
    }
  }

  // Delete a backend from a model configuration
  async deleteBackendFromModel(model: string, backendId: string): Promise<ModelConfig> {
    const modelConfig = this.modelConfigs.get(model)
    if (!modelConfig) {
      throw new Error(`Model configuration for ${model} not found`)
    }

    const updatedBackends = modelConfig.backends.filter(b => b.id !== backendId)

    if (updatedBackends.length === modelConfig.backends.length) {
      throw new Error(`Backend with id ${backendId} not found in model ${model}`)
    }

    // Clean up affinity mappings for deleted backend
    await affinityManager.cleanupBackendMappings(backendId)

    // Allow empty backends array - user can add backends later

    if (this.usesMongoDB) {
      const collection = mongoDBService.getModelsCollection()
      await collection.updateOne({ model }, { $set: { backends: updatedBackends } })
      // Update in-memory immediately
      const updated = { ...modelConfig, backends: updatedBackends }
      this.modelConfigs.set(model, updated)
      return updated
    } else {
      const updated = { ...modelConfig, backends: updatedBackends }
      this.modelConfigs.set(model, updated)
      return updated
    }
  }

  // Check if model exists
  hasModel(model: string): boolean {
    return this.modelConfigs.has(model)
  }

  // Get total weight of enabled backends for a model
  getTotalWeight(model: string): number {
    return this.getEnabledBackends(model).reduce((sum, backend) => sum + backend.weight, 0)
  }
}

// Singleton instance
export const configManager = new ConfigManager()
