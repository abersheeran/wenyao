# 管理面板鉴权说明

## 功能概述

为所有管理面板和管理接口增加了 API Key 鉴权功能,保护后台管理接口不被未授权访问。

## 配置方法

### 1. 设置 API Key

在 `.env` 文件中配置管理 API 密钥:

```bash
# 单个密钥
ADMIN_APIKEYS=your-secret-key-here

# 多个密钥(逗号分隔)
ADMIN_APIKEYS=key1,key2,key3
```

### 2. 重启服务

修改 `.env` 后需要重启服务使配置生效:

```bash
npm run dev
```

## 使用方法

### 前端管理面板

1. 访问管理面板 `http://localhost:51818`
2. 首次访问会弹出密钥输入对话框
3. 输入在 `.env` 中配置的任意一个密钥
4. 密钥会保存在浏览器的 localStorage 中
5. 点击右上角"更换密钥"按钮可以更换密钥

### API 调用

所有管理 API 请求需要在请求头中携带 Bearer Token:

```bash
curl -H "Authorization: Bearer your-secret-key-here" \
     http://localhost:51818/admin/models
```

## 受保护的接口

以下所有接口都需要鉴权:

- `/admin/models` - 模型配置管理
- `/admin/models/:model/backends` - 后端管理
- `/admin/stats` - 统计数据
- `/admin/stats/history` - 历史统计
- `/admin/metrics` - Prometheus 指标
- `/admin/instances` - 实例管理

## 鉴权失败处理

- HTTP 401: 密钥无效或缺失
- 前端会自动检测 401 错误并提示重新输入密钥
- 后端会返回清晰的错误信息

## 向后兼容

如果未配置 `ADMIN_APIKEYS` 环境变量,鉴权中间件会自动禁用,所有接口保持开放(不推荐用于生产环境)。

## 安全建议

1. 使用强密钥(建议 20 位以上随机字符)
2. 生产环境务必配置 `ADMIN_APIKEYS`
3. 定期轮换密钥
4. 不要将密钥提交到代码仓库
5. 确保 `.env` 文件在 `.gitignore` 中

## 测试

运行测试验证鉴权功能:

```bash
npm test
```

测试会自动设置测试环境的 API Key 并验证:
- ✅ 无鉴权头返回 401
- ✅ 无效密钥返回 401
- ✅ 错误的 Authorization 格式返回 401
- ✅ 有效密钥允许访问

## 实现细节

- **后端中间件**: `src/middleware/auth.ts`
- **应用位置**: `src/index.ts` (所有 `/admin/*` 路由)
- **前端 API 客户端**: `pages/app/apis.ts`
- **前端 UI**: `pages/app/routes/admin.tsx`
- **测试**: `src/test/admin-and-proxy.test.ts`
