# 文鳐

文鳐（Wenyao）是一个 OpenAI / AWS Bedrock / Jev 的 API 代理和负载均衡器，只运行在 Cloudflare Workers 上。Hono 提供代理和管理 API，D1 保存配置、分钟指标、会话亲和及录制元数据，R2 保存录制的请求体和响应体，Durable Objects 的内置 SQLite 保存受限后端的并发名额。React Router SPA 与 API 由同一个 Worker 托管。

支持 `weighted`、`lowest-ttft` 和 `min-error-rate` 三种负载均衡策略、失败回退、TTFT 超时、会话亲和、全局后端并发限制、请求与响应录制和 Prometheus 指标。管理面板的路由为 `/`、`/connections`、`/apikeys`、`/affinity`、`/stats`、`/metrics`。

产品定义和存储结构见 [Workers 架构设计](docs/cloudflare-workers.md)。

## 运行要求

- Cloudflare Workers **Paid** 计划，以及 D1、R2、Durable Objects。
- 上游 LLM 服务必须能从公网访问。
- Node.js 22 或更高版本和 npm，仅用于安装、构建、测试和运行开发工具。
- Durable Objects 仅用于并发限制，不使用 KV、Analytics Engine 或 Queues。

## 部署

安装依赖并创建 Cloudflare 资源：

```bash
npm ci
npm --prefix pages ci
npx wrangler login
npx wrangler d1 create wenyao
npx wrangler r2 bucket create wenyao-recordings
```

将创建 D1 时返回的 `database_id` 填入 `wrangler.jsonc` 的 `DB` 绑定。`RECORDINGS` 默认绑定 `wenyao-recordings`，也可改为自己的桶名。

应用数据库迁移、设置管理密钥并发布：

```bash
npm run db:migrate:remote
npx wrangler secret put ADMIN_APIKEYS
npm run build
npx wrangler deploy
```

`ADMIN_APIKEYS` 是逗号分隔的管理 key。管理 API 使用 `Authorization: Bearer <key>`，未配置时返回 503，key 缺失或无效时返回 401。首次部署后先在管理面板创建连接，再创建模型和引用连接的后端，最后创建代理 API key；代理请求使用单独的代理 key。

`npm run deploy` 等价于构建前端后发布。CI 只执行本地检查和 `wrangler deploy --dry-run`，不会自动部署。D1、R2、静态资源 `ASSETS`、Durable Object `CONCURRENCY`（`BackendConcurrency` 类）和每 5 分钟执行一次的 Cron 已在 `wrangler.jsonc` 配置。DO 的 SQLite migration 随 Worker 部署应用，无需单独创建实例。

## 本地开发

```bash
npm ci
npm --prefix pages ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，设置 ADMIN_APIKEYS
npm run db:migrate:local
npm run build
npm run dev:all
```

Worker 默认运行在 `http://localhost:8787`，前端开发服务器在终端显示地址，并将 `/admin` 请求代理到 8787。只需运行已构建的 SPA 和 Worker 时，使用 `npm run dev`。本地 D1、R2 和 DO 由 Wrangler / Miniflare 提供，数据保存在 `.wrangler/`。本地 secret 使用 `.dev.vars`。

检查示例：

```bash
curl http://localhost:8787/health
curl -H 'Authorization: Bearer <管理key>' http://localhost:8787/admin/models
```

验证命令：

```bash
npm run typecheck
npm run lint:check
npm run format:check
npm test
npm --prefix pages run typecheck
npm --prefix pages run build
npx wrangler deploy --dry-run
```

测试通过 `@cloudflare/vitest-plugin` 在本地 Workers 运行时执行，自动应用 `migrations/`，D1 / R2 / DO 和上游 mock 均在本地，不需要外部数据库。修改 Wrangler 绑定后运行 `npm run types` 更新生成的运行时类型。

## 从 MongoDB 迁移配置

一次性导出脚本只读取旧库的 `models` 和 `apikeys`，不迁移指标、亲和映射或录制数据。旧库的连接字符串需要包含数据库名；`createdAt`、`lastUsedAt` 会保留为毫秒时间戳。

```bash
MONGODB_URL='mongodb://localhost:27017/wenyao' npm run migrate:mongodb -- wenyao.migration.sql
```

脚本按 provider 和连接配置合并生成共享 `connections`，模型中的 backend 改用 `connectionId` 引用，并生成可重复导入的 `INSERT OR REPLACE` SQL。字符串中的引号、换行、Unicode 和 NUL 都会被保留。较大记录通过辅助分片表重建，每条 SQL 小于 100 KB，导入结束后删除辅助表；D1 单行仍受 2 MB 上限约束。生成过程中失败不会留下新的部分 SQL 文件。导出文件含后端凭据和 API key，应按密钥文件保存。

先应用 schema，再导入 SQL。可先在本地检查：

```bash
npm run db:migrate:local
npx wrangler d1 execute wenyao --local --file=wenyao.migration.sql
```

确认导出内容后，将同一文件导入已创建的远程 D1：

```bash
npm run db:migrate:remote
npx wrangler d1 execute wenyao --remote --file=wenyao.migration.sql
```

`INSERT OR REPLACE` 会以旧库导出值覆盖同名模型、同 id 的 connection 或同 key 的配置。迁移完成后，运行服务只使用 Workers 的 D1、R2 和 DO；MongoDB 驱动仅作为一次性迁移工具的开发依赖。

## System One API（Jev）

路由为 `POST /v1/systemone`，接受官方格式的 JSON、gzip / zstd 压缩请求和 multipart 图片。先创建 Jev connection：使用 TypeSafe 时，URL 设为 `https://api.typesafe.ai`，API key 使用 TypeSafe key；使用 OpenRouter 时，URL 设为 `https://openrouter.ai/api/`，API key 使用 OpenRouter key。OpenRouter URL 末尾的 `/` 不能省略，与聊天接口的相对路径解析规则相同。

再创建 provider 为 `jev` 的模型，名称与客户端请求一致（如 `jev-latest`），后端引用该 Jev connection。同一个 OpenRouter key 同时用于聊天和 Jev 时，需要分别创建一个 OpenAI connection 和一个 Jev connection。

官方 SDK 的 `baseURL`（或环境变量 `TYPESAFE_BASE_URL`）设为文鳐的地址，`TYPESAFE_API_KEY` 设为代理 key。请求始终按非流式处理，即使请求体含 `stream: true`；不提供 `GET /v1/models`。录制的请求已还原为 JSON、图片内嵌为 base64，可直接指定目标路由和对应后端 id 重放（下例为 `jev-backend`）：

```bash
ADMIN_API_KEY='<管理key>' PROXY_API_KEY='<代理key>' \
  npm run replay -- http://localhost:8787/v1/systemone jev-backend 10 1
```

## 请求重放

重放工具通过管理 API 拉取录制数据，需要管理 key 和代理 key。默认管理 API 与目标地址同源；`ADMIN_URL` 可以指定独立的管理服务地址。

```bash
ADMIN_API_KEY='<管理key>' PROXY_API_KEY='<代理key>' \
  npm run replay -- http://localhost:8787/v1/chat/completions [backend_id] [limit] [concurrency]
```

参数默认值依次为目标地址 `http://localhost:8787/v1/chat/completions`、不筛选后端、10 条、并发 1。工具会分页读取录制数据，并等待流式响应消费完毕后再计算完成时间、释放重放并发名额。

## 限制与行为

- 模型、connection 和代理 API key 在每个 isolate 内缓存 10 秒；connection 修改（包括轮换凭据）对所有引用它的 backend 生效，其他 isolate 最多 10 秒后看到变更。管理 API 直接读写 D1，写入后立即使当前 isolate 的配置缓存失效。
- backend 写入使用 `connectionId`，不接受内嵌 `openaiConfig` / `bedrockConfig` / `jevConfig`。模型和后端的管理响应不包含凭据；凭据只通过 `/admin/connections` 返回。connection 可设置并修改显示名称，provider（`openai` / `bedrock` / `jev`）必须与模型一致，被引用时删除返回 409，并列出 `model/backendId`。
- 已部署实例应用 `0002_connections.sql` 时会自动合并已有内嵌连接并转换 backend；缺少有效内嵌配置的 backend 需要在管理面板中补选连接。
- `ADMIN_APIKEYS` 必须配置。代理 key 缺失或无效返回 401，无权访问模型返回 403。代理 key 的 `lastUsedAt` 在同一 isolate 内最多每 60 秒写入一次。
- 指标始终开启，按「模型 + backend ID」分别进行分钟汇总，保存 30 天；backend ID 只在模型内唯一。stats 页以 `model/backendId` 显示并独立筛选。查询包含与时间窗口相交的分钟桶，因此不足一分钟的窗口仍可能包含整分钟的计数；TTFT 按流式、非流式分别使用 `sum / count`。负载均衡只使用本模型的统计，缓存 15 秒。
- 历史查询支持 `intervalMinutes`（1–43200，默认 1），按 UTC 对齐并纳入与窗口相交的整桶；stats 页的 1h / 6h / 24h / 7d 分别使用 1 / 5 / 15 / 60 分钟粒度。
- `0004_model_backend_stats.sql` 将旧指标归入当前配置中唯一对应的模型（包括禁用 backend）；多模型重名或孤立 ID 的旧数据丢弃。
- 指标数据项新增 `model`。单 backend 指标查询、历史查询和删除路径分别为 `/admin/stats/:model/:backendId`、`/admin/stats/history/:model/:backendId`、`DELETE /admin/stats/:model/:backendId`，两个路径参数分别用 `encodeURIComponent`。全部历史返回 `{ history: { [model]: { [backendId]: StatsDataPoint[] } } }`；`DELETE /admin/stats` 仍清空全部。Prometheus 的请求、时长计数、TTFT 和成功率指标新增 `model` 标签，活跃请求指标不变。
- 只有配置了 `maxConcurrentRequests > 0` 的后端才使用并发限制，每个后端一个 DO。每次尝试通过 `acquire`、`release` 两次 RPC 抢占和释放名额；DO 使用内置 SQLite 持久化，休眠或重启不会丢失计数，超过 30 分钟的名额在 `acquire` / `count` 时清理。DO 调用异常时记录日志并放行。长于 30 分钟的请求不再占用有效并发名额。
- 未配置并发限制的后端不访问 DO，也不记录活跃请求；`/admin/active-requests` 和 Prometheus 的 `llm_proxy_active_requests` 只列出已启用且配置了限制的后端，计数来自对应 DO。
- 会话亲和在最后一次成功访问 1 小时后过期，管理端查询不增加访问次数；清除映射立即生效。不存在、禁用或权重为 0 的后端映射会被忽略并删除。
- 后端可独立配置 `recordResponses`，仅在 `recordRequests` 同时开启时生效。管理列表和单条读取新增 `response`：未录制时为 `null`；已录制时包含状态、原始响应头、响应体、编码、错误、截断标记和完成时间。文本类型使用 UTF-8，其余使用 base64。每条响应体最多保存 10 MiB，客户端仍接收完整响应；流中断保存已收到的部分，超时和网络错误只保存错误信息。失败并触发回退的尝试也会录制。
- 模型和后端配置写入使用比较并交换，冲突最多尝试 3 次，仍冲突返回 409；管理写入成功后失效当前 isolate 的配置缓存。
- 非流式 2xx 响应会校验 JSON，非法 JSON 按失败计数并尝试下一个后端；合法 JSON 原始字节透传。
- Cron 每 5 分钟清理过期的亲和映射和分钟指标。录制数据不会自动过期，删除录制时同时删除 D1 元数据及 R2 中的请求体、响应体。
- 不再提供 `/admin/instances` 或 `/admin/instances/:instanceId/stats`，历史指标不再包含 `instanceId` 参数或字段；`/health` 不再返回 `instanceId`、`metricsEnabled`。
- 管理业务错误统一为 JSON `{ "error": "..." }`：不存在为 404，已存在为 409，provider 不匹配为 400。指标接口变化见上述条目；其余保留接口的路径和响应形状不变，录制数据仍返回 `_id` 和 `body`。
- 运行配置只使用 Workers bindings 和 `ADMIN_APIKEYS`。原来的数据库连接、指标开关、实例 ID、端口等环境变量已删除。
