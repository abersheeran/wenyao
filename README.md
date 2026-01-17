# 文鳐

文鳐（Wen Yao）是一款高性能、功能丰富的 OpenAI API 代理和负载均衡器，专为企业级大语言模型（LLM）应用设计。它提供先进的流量管理、可观测性和可靠性特性。

## 🚀 核心特性

- **多策略负载均衡**:
  - `weighted`: 根据后端权重分配流量。
  - `lowest-ttft`: 将请求路由到首字响应时间（TTFT）最低的后端。
  - `min-error-rate`: 自动优先选择稳定性更高的后端。
- **会话粘滞 (Session Affinity)**: 支持将特定的用户会话映射到同一个后端，以确保一致的性能体验。
- **并发控制**: 使用 MongoDB 或 Redis 实现分布式并发限制。
- **可观测性**: 实时指标采集，使用 MongoDB Time Series 存储。
- **管理面板**: 基于 React 的现代化仪表盘，用于管理模型、后端和 API 密钥。
- **安全设计**: 所有管理接口内置 API Key 鉴权。
- **灵活部署**: 支持本地运行和 Docker 容器化部署。

## 🏗 项目架构

项目主要分为两个部分：

1.  **后端 (根目录)**: 基于 [Hono](https://hono.dev/) 和 Node.js。负责请求转发、负载均衡以及管理接口。
2.  **前端 (`/pages`)**: 一个 [React Router](https://reactrouter.com/) 应用程序，提供可视化管理界面。

## 🛠 快速上手

### 环境要求

- Node.js (v18+)
- MongoDB (可选，用于存储指标和持久化配置)
- Redis (可选，用于高性能分布式并发限制)

### 安装

```bash
npm install
cd pages && npm install
```

### 配置

复制 `.env.example`（如果有）或在根目录创建 `.env` 文件：

```env
MONGODB_URL=mongodb://localhost:27017/wenyao
ADMIN_APIKEYS=your-secret-key
ENABLE_METRICS=true
ACTIVE_REQUEST_STORE_TYPE=mongodb # 或 redis
REDIS_URL=redis://localhost:6379
```

### 运行项目

#### 开发模式

同时启动后端和前端：

```bash
npm run dev:all
```

#### 生产模式

```bash
# 构建前端
cd pages && npm run build
# 构建并启动后端（会同时托管构建出的前端文件）
npm run build
npm start
```
