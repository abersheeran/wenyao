import type { Context, Next } from 'hono'
import { mongoDBService } from '../services/mongodb.js'
import type { Variables } from '../types/context.js'

/**
 * Admin API 鉴权中间件
 * 从环境变量 ADMIN_APIKEYS 读取允许的 API 密钥列表(逗号分隔)
 * 验证请求头中的 Bearer Token 是否匹配
 */
export async function adminAuth(c: Context, next: Next) {
  // 读取环境变量中的 API Keys
  const apiKeysEnv = process.env.ADMIN_APIKEYS

  // 如果未配置 ADMIN_APIKEYS,则不启用鉴权(向后兼容)
  if (!apiKeysEnv || apiKeysEnv.trim() === '') {
    console.warn('[Auth] ADMIN_APIKEYS not configured, admin endpoints are unprotected!')
    await next()
    return
  }

  // 解析逗号分隔的密钥列表
  const validApiKeys = apiKeysEnv
    .split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0)

  if (validApiKeys.length === 0) {
    console.warn('[Auth] ADMIN_APIKEYS is empty, admin endpoints are unprotected!')
    await next()
    return
  }

  // 从请求头获取 Authorization
  const authHeader = c.req.header('Authorization')

  if (!authHeader) {
    return c.json({
      error: 'Unauthorized',
      message: 'Missing Authorization header'
    }, 401)
  }

  // 验证 Bearer Token 格式
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return c.json({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Expected: Bearer <token>'
    }, 401)
  }

  const token = parts[1]

  // 验证 token 是否在允许的密钥列表中
  if (!validApiKeys.includes(token)) {
    return c.json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    }, 401)
  }

  // 验证通过,继续处理请求
  await next()
}

/**
 * Proxy API 鉴权中间件
 * 从数据库中读取 API Key 并验证
 * 将验证后的 API Key 信息存储在 context 中供后续使用
 */
export async function proxyAuth(c: Context<{ Variables: Variables }>, next: Next) {
  // 检查 MongoDB 连接
  if (!mongoDBService.isConnected()) {
    return c.json({
      error: 'Service Unavailable',
      message: 'Database connection not available'
    }, 503)
  }

  // 从请求头获取 Authorization
  const authHeader = c.req.header('Authorization')

  if (!authHeader) {
    return c.json({
      error: 'Unauthorized',
      message: 'Missing Authorization header'
    }, 401)
  }

  // 验证 Bearer Token 格式
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return c.json({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Expected: Bearer <token>'
    }, 401)
  }

  const token = parts[1]

  try {
    // 从数据库查询 API Key
    const collection = mongoDBService.getApiKeysCollection()
    const apiKey = await collection.findOneAndUpdate(
      { key: token },
      { $set: { lastUsedAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!apiKey) {
      return c.json({
        error: 'Unauthorized',
        message: 'Invalid API key'
      }, 401)
    }

    // 将 API Key 信息存储在 context 中,供后续使用
    c.set('apiKey', apiKey)

    // 验证通过,继续处理请求
    await next()
  } catch (error) {
    console.error('[ProxyAuth] Error validating API key:', error)
    return c.json({
      error: 'Internal Server Error',
      message: 'Failed to validate API key'
    }, 500)
  }
}
