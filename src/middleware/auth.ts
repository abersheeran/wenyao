import type { Context, Next } from 'hono'

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
