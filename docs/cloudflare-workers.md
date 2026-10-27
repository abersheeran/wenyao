# 文鳐 Cloudflare Workers 架构设计

本文档描述文鳐迁移到 Cloudflare Workers 后的运行时、存储和行为定义。迁移后只支持 Workers 部署，不再提供 Node.js / Docker / MongoDB / Redis 运行方式。

## 1. 为什么要改

原实现依赖长驻 Node 进程：

- MongoDB 驱动和 node-redis 依赖长连接与连接池。Workers 不能跨请求复用 socket，MongoDB Atlas Data API 也已停止服务。
- 配置同步依赖 MongoDB change stream，后台清理依赖 `setInterval`，Workers 没有常驻进程。
- 静态文件由 `@hono/node-server` 托管，实例身份由进程级 `instanceId` 表示。在 Workers 上，isolate 是临时的，数量也不固定。

## 2. 约束与取舍

- **Durable Objects 只用于并发限制，且只给配置了限制的 backend 使用。** 每个 backend 一个 DO，名额记录在 DO 内置的 SQLite 中。
  - 为什么不用全局 D1：D1 是整个服务共用的单线程库，指标、配置、亲和等所有查询都在同一个队列里排队，队列满了会返回 overloaded。按 backend 拆成 DO 后，名额操作只和同一 backend 的名额操作排队。DO 内置 SQLite 是进程内的同步调用，不经过 D1 的路由和共享队列。
  - 为什么不只放在内存里：没有待处理工作的 DO 空闲 10 秒就会休眠并清空内存，部署时也会重启。LLM 流式请求通常持续几十秒，这期间计数会归零，导致超额放行。要让 DO 常驻内存，就得按 wall-clock 计 duration 费用。
  - 其他状态不放进 DO，以控制 DO 的请求费。
- **存储只用 D1 + R2 + 一个 DO 类。** 不引入 KV、Analytics Engine、Queues，避免多套一致性模型和多份凭据。
- **需要 Workers Paid 计划。** Free 计划每请求 10ms CPU，处理大 JSON 请求体会超时；每天 10 万行写入也不够用。
- **后端 LLM 服务必须能从公网访问。** Workers 默认无法访问内网地址。

## 3. 组件映射

| 能力 | 原实现 | Workers 实现 |
|---|---|---|
| 入口 | `@hono/node-server` | `export default { fetch, scheduled }` |
| 前端托管 | `serveStatic` | Workers Static Assets：SPA fallback；只有 `/admin/*`、`/v1/*`、`/health` 进入 Worker |
| 模型 / 后端配置 | MongoDB + change stream + 内存 Map | D1 `models` 表 + isolate 内 TTL 缓存 |
| 上游连接（URL / 凭据） | 内嵌在每个 backend 中 | D1 `connections` 表，全局共享，backend 按 `connectionId` 引用（见 5.8） |
| 代理 API Key | MongoDB，每请求一次 `findOneAndUpdate` | D1 `api_keys` 表，与模型配置一起缓存；`last_used_at` 节流写入 |
| 并发限制 / 活跃请求 | MongoDB 或 Redis | Durable Object `BackendConcurrency`，每个受限 backend 一个实例，名额存在 DO 内置 SQLite |
| 指标 | MongoDB 时序集合 + 查询时聚合的 view | D1 `backend_stats_minute` 分钟汇总表，每请求一次 UPSERT |
| 会话亲和 | MongoDB + TTL 索引 + 进程内 LRU | D1 `affinity_mappings` 表，查询时按 1 小时过滤 |
| 请求 / 响应录制 | MongoDB 整条文档（仅请求） | D1 存元数据，R2 存请求体和响应体（D1 单行上限 2MB） |
| 后台清理 | `setInterval`、TTL 索引 | Cron Trigger |
| Bedrock SigV4 | `@aws-sdk/signature-v4` | `aws4fetch`（WebCrypto） |
| 请求结束后的写入 | fire-and-forget Promise | `ctx.waitUntil()` |

## 4. D1 数据模型

时间统一存为毫秒 epoch 整数。

```sql
CREATE TABLE models (
  model  TEXT PRIMARY KEY,
  config TEXT NOT NULL              -- 完整 ModelConfig JSON（含 backends 数组）
);

CREATE TABLE connections (
  id       TEXT PRIMARY KEY,        -- 用户指定，全局唯一，创建后不可修改
  provider TEXT NOT NULL,           -- openai | bedrock，创建后不可修改
  config   TEXT NOT NULL,           -- JSON：OpenAI 为 {url, apiKey}，Bedrock 为 {region, accessKeyId, secretAccessKey}
  name     TEXT NOT NULL DEFAULT '' -- 显示名，可修改，可重复；空字符串表示未命名
);

CREATE TABLE api_keys (
  key          TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  models       TEXT NOT NULL,       -- JSON string[]
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE backend_stats_minute (
  backend_id               TEXT    NOT NULL,
  minute                   INTEGER NOT NULL,  -- 截断到分钟的毫秒 epoch
  total                    INTEGER NOT NULL DEFAULT 0,
  success                  INTEGER NOT NULL DEFAULT 0,
  failure                  INTEGER NOT NULL DEFAULT 0,
  streaming_ttft_sum       REAL    NOT NULL DEFAULT 0,
  streaming_ttft_count     INTEGER NOT NULL DEFAULT 0,
  non_streaming_ttft_sum   REAL    NOT NULL DEFAULT 0,
  non_streaming_ttft_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (backend_id, minute)
);
CREATE INDEX idx_backend_stats_minute ON backend_stats_minute (minute);

CREATE TABLE affinity_mappings (
  model            TEXT    NOT NULL,
  session_id       TEXT    NOT NULL,
  backend_id       TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, session_id)
);
CREATE INDEX idx_affinity_backend ON affinity_mappings (backend_id);
CREATE INDEX idx_affinity_last_accessed ON affinity_mappings (last_accessed_at);

CREATE TABLE recorded_requests (
  id         TEXT PRIMARY KEY,      -- UUID；R2 对象键为 recorded-requests/{id}
  backend_id TEXT NOT NULL,
  model      TEXT NOT NULL,
  timestamp  INTEGER NOT NULL,
  url        TEXT NOT NULL,
  headers    TEXT NOT NULL          -- JSON Record<string, string>
);
CREATE INDEX idx_recorded_backend ON recorded_requests (backend_id, timestamp);
CREATE INDEX idx_recorded_model ON recorded_requests (model, timestamp);
CREATE INDEX idx_recorded_timestamp ON recorded_requests (timestamp);
```

`models.config` 保持原 `ModelConfig` 文档形状，只有一处不同：backend 用 `connectionId` 引用 `connections` 中的连接，不再内嵌 `openaiConfig` / `bedrockConfig`（见 5.8）。`connections` 表由 `migrations/0002_connections.sql` 创建，`name` 列由 `migrations/0003_connection_names.sql` 添加。

`recorded_requests` 还包含响应录制的列，直接写在 `migrations/0001_init.sql` 的建表语句中：

```sql
  response_status       INTEGER,                    -- 上游 HTTP 状态；超时或网络错误时为 NULL
  response_headers      TEXT,                       -- JSON，上游原始响应头
  response_error        TEXT,                       -- 见 5.5；正常完成时为 NULL
  response_truncated    INTEGER NOT NULL DEFAULT 0,
  response_completed_at INTEGER                     -- 非 NULL 表示已录制响应
```

活跃请求不存放在 D1，而是由每个 backend 的 DO 自己保存（见 5.2）。DO 内置 SQLite 只有一张表：

```sql
CREATE TABLE slots (
  slot_id    TEXT PRIMARY KEY,      -- 每次后端尝试生成的 UUID，不使用客户端 x-request-id
  started_at INTEGER NOT NULL
);
```

## 5. 关键流程

### 5.1 配置缓存

- 代理路径每个 isolate 缓存一份 `models`、`connections` 和 `api_keys`，TTL 10 秒。过期后用一次 `DB.batch()` 同时重新加载三张表。
- 刷新失败时，有旧缓存就继续用旧缓存，并记录错误；没有缓存就返回 503。
- 缓存里只放解析好的普通数据，不跨请求共享 Promise、stream 等 I/O 对象。
- 管理 API 一律直接读写 D1，写完后失效当前 isolate 的缓存。效果：管理面板立即看到修改；代理路径在其他 isolate 上最多 10 秒后生效。新建的 API Key 同样最多 10 秒后可用。
- 无效 token 只查缓存，不打到 D1。
- 管理 API 修改模型或后端配置时：
  1. 读出 `config` JSON，在代码里修改；
  2. 用比较并交换写回：`UPDATE models SET config = ?new WHERE model = ? AND config = ?old`；
  3. 若影响行数为 0，说明期间有别的请求改过这一行，重新读取并重试，最多 3 次；仍然冲突就返回 409。

  这样不需要在 SQL 里做 JSON 路径操作，也不会丢失并发修改。

### 5.2 代理请求

流程与原实现一致：鉴权 → 模型权限 → 选后端 → 依次尝试并 fallback → 处理响应。差异如下：

1. **抢占并发名额。** 只有配置了 `maxConcurrentRequests > 0` 的后端才走这一步。未配置限制的后端完全不访问 DO，也不记录活跃请求，因此没有额外成本。
   - 每次后端尝试生成新的 `slot_id`，然后通过 `env.CONCURRENCY.idFromName(backendId)` 拿到该 backend 的 DO，调用 RPC `acquire(slotId, limit)` 并等待返回结果。
   - DO 直接用内置 SQLite 的 `slots` 表（同步的 `ctx.storage.sql`）判断准入，不另外维护内存副本：
     1. 先 `DELETE` 超过 30 分钟的旧行；
     2. 再 `SELECT COUNT(*)`，数量小于 `limit` 就 `INSERT` 并返回 `true`，否则返回 `false`。
     
     这几步之间没有 `await`，DO 单线程执行，因此是原子的。DO 休眠、被驱逐或因部署重启后，状态都还在表里，不需要恢复逻辑。
   - `limit` 每次由调用方传入，所以修改 `maxConcurrentRequests` 后立即生效（受 5.1 节的配置缓存影响，最多延迟 10 秒）。
   - RPC 出错时放行（fail open）并记录日志，与原实现一致。
   - DO stub 在每个请求内创建，不跨请求缓存。
2. **请求结束时的写入。** 无论成功、失败、超时、客户端中断，都在 `ctx.waitUntil()` 里完成：
   - 若这次尝试抢到了名额，调用 DO 的 `release(slotId)`。释放一个不存在的 `slotId` 不做任何事。
   - 用一次 `DB.batch()` 写入指标 UPSERT；成功且需要亲和时，再加一条亲和 UPSERT。
3. **响应按字节透传。**
   - 流式响应：当前 OpenAI 和 Bedrock 都不改写 chunk，所以删除 `processChunk` / `useBinaryStream` / `processBody` 这些未被使用的钩子，也不再先 decode 成字符串再 encode 回去。
   - 非流式 2xx 响应：读完整个 body 后用 `JSON.parse` 校验。校验失败按失败处理（记失败指标，返回 500 `internal_error`，然后 fallback），与原实现一致；校验通过就原样返回原始字节，不重新序列化。
4. **TTFT 超时。** 超时后取消上游响应体，然后 fallback 到下一个后端。
5. **转发头过滤。** 转发给 OpenAI 兼容后端时，不带 `host`、`content-length`、`authorization`、`x-authorization`、`cf-*`、`x-forwarded-*`、`x-real-ip`、`cdn-loop` 等由客户端或 Cloudflare 添加的头。

### 5.3 指标

- 每次后端尝试结束时，写一次分钟汇总：
  ```sql
  INSERT INTO backend_stats_minute (backend_id, minute, total, success, failure,
    streaming_ttft_sum, streaming_ttft_count, non_streaming_ttft_sum, non_streaming_ttft_count)
  VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (backend_id, minute) DO UPDATE SET
    total = total + 1,
    success = success + excluded.success,
    failure = failure + excluded.failure,
    streaming_ttft_sum = streaming_ttft_sum + excluded.streaming_ttft_sum,
    streaming_ttft_count = streaming_ttft_count + excluded.streaming_ttft_count,
    non_streaming_ttft_sum = non_streaming_ttft_sum + excluded.non_streaming_ttft_sum,
    non_streaming_ttft_count = non_streaming_ttft_count + excluded.non_streaming_ttft_count
  ```
- 平均 TTFT 按流类型分别计算：`sum / count`。原实现用总请求数做权重，混合流式与非流式时结果是错的，这里一并修正。
- 查询时间窗口 `[start, end]` 时，包含所有与窗口有交集的分钟桶：`minute > start - 60000 AND minute <= end`。
- `lowest-ttft` 和 `min-error-rate` 用一条 `GROUP BY backend_id` 查询拿到所有候选后端的统计，结果在 isolate 内缓存 15 秒。选择算法本身不变。
- 指标始终开启，因为 D1 是必需绑定。因此删除 `ENABLE_METRICS`、`NoopMetricsCollector` 和"策略需要开启指标"的启动校验。

### 5.4 会话亲和

- 查询：`SELECT backend_id FROM affinity_mappings WHERE model = ? AND session_id = ? AND last_accessed_at > now - 1h`。
- 目标后端不存在、已禁用或权重为 0 时，忽略这条映射，在 `waitUntil` 里删除它，然后走正常负载均衡。
- 请求成功后 UPSERT 映射：设置 `backend_id` 和 `last_accessed_at`，`access_count + 1`。
- `access_count` 定义为经由该会话成功路由的请求次数。
- 不再使用进程内 LRU 缓存，管理端清除映射后立即生效。

### 5.5 请求与响应录制

**请求录制**
- 后端开启 `recordRequests` 时，在 `waitUntil` 中把请求体写入 R2 `recorded-requests/{id}`，元数据写入 D1。
- 管理 API 原有字段保持不变，包括 `_id` 和 `body`。列表接口按条读取 R2 补全 body。

**响应录制**
- 后端新增开关 `recordResponses`（默认 `false`），只有 `recordRequests` 同时开启时才生效。响应挂在同一条录制记录上。
  - schema 单独接受这个字段，以便局部更新；是否生效只在运行时判断。
  - UI 在所有出现 `recordRequests` 开关的地方并排加上 `recordResponses` 开关，`recordRequests` 关闭时禁用它。
- 录制范围：每一次已经生成请求记录的后端尝试都录制，包括失败后触发 fallback 的尝试。
- 记录内容：
  - 上游 HTTP 状态和原始响应头；
  - 响应体，写入 R2 `recorded-responses/{id}`；
  - `response_error`：`ttft_timeout`、`network_error`、`invalid_json`、`stream_interrupted`、`client_disconnected` 之一，正常完成时为 NULL；
  - `response_truncated`；
  - `response_completed_at`。
- 响应体按以下方式获取：
  - 非流式 2xx：已经读完整个 body，直接使用。
  - 非 2xx：开启响应录制时先读完 body，再用这些字节构造返回给客户端（或因 fallback 丢弃）的响应。
  - 流式：数据块经过时边透传边捕获，流结束、出错或被取消时写入。中断的流保留已收到的部分。
  - 超时和网络错误没有响应体，只记 `response_error`。
- 每条响应体最多保留 10 MiB，超出部分不再捕获，并标记 `response_truncated`。这样长时间的流不会撑爆 Worker 的 128MB 内存。客户端收到的响应不受这个上限影响。
- 写入放在 `waitUntil` 里，并且必须排在这条请求记录的 D1 插入完成之后，否则 `UPDATE` 会匹配不到行。

**管理 API**
- 每条记录新增 `response` 字段：未录制响应时为 `null`，否则为：
  ```
  { status: number | null, headers: Record<string, string> | null, body: string,
    bodyEncoding: 'utf8' | 'base64', error: string | null, truncated: boolean, completedAt: string }
  ```
- 文本类 content-type（`text/*`、`application/json`、`*+json`）的响应体按 UTF-8 返回，其余按 base64 返回。例如 Bedrock 的 `application/vnd.amazon.eventstream` 是二进制，直接当文本会损坏。
- 删除接口同时删除 D1 行，以及请求和响应两个 R2 对象。

录制数据不自动过期，与原实现一致。

### 5.6 定时清理（Cron，每 5 分钟）

- `affinity_mappings`：删除 `last_accessed_at` 早于 1 小时前的行。
- `backend_stats_minute`：删除 30 天前的分钟桶。

查询本身已经按时间过滤，所以清理只负责控制表的大小，不影响正确性。DO 中超过 30 分钟的名额，由 DO 在每次 `acquire` 时自行清理，不需要 cron。

### 5.7 鉴权

- **代理鉴权**：读配置缓存。`last_used_at` 在同一 isolate 内对同一个 key 最多每 60 秒写一次，写入放在 `waitUntil` 里。
- **管理鉴权**：仍然从 `ADMIN_APIKEYS`（Worker secret，逗号分隔）读取。**改为 fail closed**：未配置时管理 API 返回 503。Worker 默认暴露在公网，管理接口会返回后端密钥，不能默认开放。

### 5.8 共享连接

上游连接信息是全局实体 connection，存在 `connections` 表：OpenAI 是 `url` + `apiKey`，Bedrock 是 `region` + `accessKeyId` + `secretAccessKey`。backend 只用 `connectionId` 引用 connection，不再内嵌凭据。任意模型的任意 backend 都可以引用同一个 connection。修改一次 connection（例如轮换 key）对所有引用它的 backend 生效；代理路径受 5.1 节缓存影响，最多 10 秒后生效。

- **标识**：`id` 由用户指定，全局唯一，只能包含字母、数字、`.`、`_`、`-`。`id` 和 `provider` 创建后不可修改，只能修改名称和该 provider 对应的配置。
- **名称**：`name` 是显示名，用于在选择和列表中区分 connection。
  - 可选，可以随时修改，不要求唯一。
  - 首尾空白会被去掉；为空表示未命名，界面上显示 `id`。
  - 名称只用于管理界面，不参与引用，也不影响代理路径。
- **引用完整性**：
  - 写入不能引入无效引用：本次新增或修改的 backend，其 `connectionId` 必须指向已存在、且 `provider` 与模型相同的 connection，否则返回 400。
  - 未改动的 backend 不重新校验。因此，迁移遗留的、未设置 connection 的 backend 不会阻塞同一模型的其他修改，可以逐个修复或删除。
  - 被任何 backend 引用的 connection 不能删除，返回 409，错误信息列出引用方的 `model/backendId`。
  - 管理写入并发时这两条同样成立：backend 写入和 connection 删除各自在单条 SQL 里判断引用是否存在，不会提交悬空引用。
- **代理路径**：配置缓存同时加载 `connections`，构造缓存时把 connection 的配置解析到 backend 上，provider 实现不需要知道 connection。引用缺失或 provider 不匹配的 backend 只可能来自绕过管理 API 导入的数据，按缺少 provider 配置处理：这次尝试失败，然后 fallback。
- **凭据暴露范围**：模型和 backend 的管理响应只包含 `connectionId`，不再包含凭据。凭据只通过 `/admin/connections` 返回。
- **管理 API**：
  - `GET /admin/connections` 返回 `{ connections }`；`GET /admin/connections/:id` 返回 `{ connection }`，不存在时返回 404。
  - `POST /admin/connections` 的请求体为 `{ id, name?, provider, openaiConfig | bedrockConfig }`，返回 201 `{ connection }`，id 已存在时返回 409。
  - `PUT /admin/connections/:id` 的请求体为 `{ name?, openaiConfig? | bedrockConfig? }`，至少包含一个字段，返回 `{ connection }`。
    - 只修改请求中出现的字段：可以只改名称，也可以只改配置。配置字段出现时整体替换。
    - 配置字段与 provider 不符时返回 400，不存在时返回 404。
  - `DELETE /admin/connections/:id`：不存在时返回 404，被引用时返回 409。
  - connection 的响应形状为 `{ id, name, provider, openaiConfig | bedrockConfig }`，`name` 总是存在，未命名时为空字符串。
- **管理面板**：
  - 新增 `/connections` 页，可以增删改 connection（包括名称），并显示每个 connection 被哪些 `model/backendId` 引用。
  - 添加和编辑 backend 时，从与模型 provider 相同的 connection 中选择，不再填写 URL 和凭据。选项显示名称，同时显示 `id` 和 URL / region，便于区分同名或未命名的 connection。
  - backend 列表显示所用 connection 的名称，未命名时显示 `id`，未设置时显示为未配置。
- **迁移已有数据**（`migrations/0002_connections.sql`）：
  - 从所有 backend 的内嵌配置中提取 connection。provider 和各配置字段值都相同的合并为一个 connection，不受 JSON 键顺序影响。
  - id 为 `{provider}-{n}`，例如 `openai-1`、`openai-2`、`bedrock-1`。n 在每个 provider 内从 1 开始，按首次出现的顺序编号：先按模型名升序，再按 backend 在数组中的位置。
  - 每个 backend 写入对应的 `connectionId` 并删除内嵌配置，backend 顺序和其他字段保持不变。没有有效内嵌配置的 backend 只删除内嵌配置，不设置 `connectionId`，需要在管理面板中补选。
  - `scripts/migrate-from-mongodb.ts` 按同样的合并和编号规则生成 connection，以及引用它们的模型。
  - 迁移生成的 connection 都未命名，可以在管理面板中补充名称。

### 5.9 管理面板：模型与后端页

模型和 backend 多了以后，要能快速找到某个模型，并在它和其他模型之间切换。`/` 页采用左右两栏布局：左栏是模型列表，右栏是选中模型的详情。

- **左栏：模型列表**
  - 按模型名排序，顶部有搜索框。搜索不区分大小写，匹配模型名、backend ID，以及 backend 所用 connection 的名称或 id。
  - 每项显示模型名、provider，以及「已启用 / 全部」的 backend 数量。已启用指 `enabled` 且 `weight > 0`，与负载均衡的判定一致。
  - 以下情况在该项上显示警告标记，悬停说明原因：
    - 没有可用的 backend；
    - 有 backend 未设置 connection，或引用的 connection 不存在。
  - 桌面宽度下，左栏固定在视口内并独立滚动，不随详情滚动。
  - 键盘操作：在非输入位置按 `/` 聚焦搜索框；在搜索框中用上下方向键移动高亮，按 Enter 选中高亮项（默认第一项）。
- **右栏：模型详情**
  - 显示模型名、provider、负载均衡策略、是否开启亲和，提供编辑和删除模型的操作。
  - backend 表格包含原有的全部信息和操作，可以添加 backend。为了在常见桌面宽度下不用横向滚动就能看到所有操作，列合并为：启用开关 | backend（ID 与所用 connection）| 权重（权重与流量占比）| 限制（最大并发、TTFT 超时）| 录制（请求、响应开关）| 操作（编辑、删除）。
- **选中状态**
  - 保存在 URL 查询参数 `?model=` 中，刷新或分享链接后保持；切换模型会产生浏览历史，可以用后退回到上一个模型。
  - 未指定或模型不存在时，桌面宽度下显示列表中的第一个模型。
  - 新增模型后选中它；删除当前模型后清除选中。
  - 在 backend 上切换开关或编辑、删除后，选中状态和搜索词保持不变。
- **窄屏**：未选中模型时只显示列表；选中后只显示详情，顶部有返回列表的链接。

## 6. 接口变化

保留的接口及其路径、请求格式、响应形状不变：

- 代理：`/v1/chat/completions`、Bedrock 的 `/v1/model/:modelId/invoke` 和 `/v1/model/:modelId/invoke-with-response-stream`。
- 管理：models / backends / apikeys / affinity / recorded-requests 的 CRUD；`/admin/stats` 及其子路由（含 `DELETE` 重置）、`/admin/stats/history*`、`/admin/metrics`（Prometheus 指标名不变）、`/admin/active-requests`。

删除：

- `/admin/instances`、`/admin/instances/:instanceId/stats`，以及 `/admin/stats/history` 的 `instanceId` 参数。历史数据点不再带 `instanceId`。
- `/health` 中的 `instanceId` 和 `metricsEnabled` 字段。
- 环境变量 `MONGODB_URL`、`REDIS_URL`、`ACTIVE_REQUEST_STORE_TYPE`、`ENABLE_METRICS`、`INSTANCE_ID`、`PORT`。

行为变化：

- 配置和 API Key 的变更在代理路径上最多 10 秒后生效，原来是实时生效。
- `ADMIN_APIKEYS` 未配置时，管理 API 拒绝所有请求。
- 管理接口的业务错误返回 JSON `{ error }` 和对应状态码：不存在返回 404，已存在返回 409，provider 不匹配返回 400。原来这些情况都是 500 纯文本。
- `GET /admin/affinity/:model/:sessionId` 变为纯读取，不再修改访问计数。
- `/admin/active-requests` 和 Prometheus 的 `llm_proxy_active_requests` 只包含配置了并发限制的后端，计数来自各 backend DO 的 `count()` RPC。未配置限制的后端不再统计活跃请求。
- 后端配置新增 `recordResponses`。`/admin/recorded-requests` 的每条记录新增 `response` 字段（见 5.5），原有字段不变。
- 新增 `/admin/connections` 的 CRUD（见 5.8）。**不兼容变更**：创建和更新 backend（包括通过模型的 `backends` 数组写入）时，用 `connectionId` 代替 `openaiConfig` / `bedrockConfig`。缺少 `connectionId` 的创建请求返回 400。模型和 backend 的响应不再包含凭据。

## 7. 部署

- **绑定**：`DB`（D1）、`RECORDINGS`（R2）、`ASSETS`（静态资源，目录为 `pages/build/client`）、`CONCURRENCY`（Durable Object，类名 `BackendConcurrency`，在 wrangler migrations 中声明为 `new_sqlite_classes`）。
- **Secret**：`ADMIN_APIKEYS`。
- **D1 schema**：放在 `migrations/`，通过 `wrangler d1 migrations apply` 应用。已部署的实例应用 `0002_connections.sql` 时，会把已有 backend 的内嵌配置就地转换为共享连接（见 5.8）。
- **从旧部署迁移**：`scripts/migrate-from-mongodb.ts` 从 MongoDB 读取 `models` 和 `apikeys`，把 backend 内嵌的连接合并为 `connections`，生成可幂等执行的 SQL 文件（`INSERT OR REPLACE`），原有的 `createdAt` 和 `lastUsedAt` 都保留。生成后用 `wrangler d1 execute <db> --remote --file=...` 导入。指标、亲和映射、录制数据都是临时数据，不迁移。
- **请求重放**：`scripts/replay.ts` 改为通过 `/admin/recorded-requests` 拉取录制数据，不再直连数据库。

## 8. 容量与成本

- **D1 写入量**：每个代理请求在请求结束时只有一次 batch，写 1 行指标 UPSERT；带亲和的请求再加 1 行。
  - Paid 计划每月含 5000 万行写入，约等于 5000 万次请求。超出部分每百万行 1 美元。
  - 读取量很小：配置每 10 秒刷新一次，负载均衡统计每 15 秒查一次。
- **DO 成本**：只有配置了并发限制的后端才产生。
  - 每个请求 2 次 DO 请求（`acquire`、`release`）。每月含 100 万次，超出部分每百万次 0.15 美元。
  - 每个请求还会写 2 行 DO SQLite。这部分与 D1 分开计费，同样每月含 5000 万行，超出部分每百万行 1 美元。
  - DO 只在处理调用时计 duration，空闲时可以休眠，不计费。
- **吞吐**：
  - 并发限制按 backend 分散到各自的 DO，单个 DO 每秒可处理约上千次调用。
  - D1 每个代理请求只有约 1 次往返，所以 D1 的上限大约是每秒上千个 LLM 请求。
- **延迟**：抢占名额要往返一次该 backend 的 DO，DO 位于首次调用它的地区附近；亲和查询要往返一次 D1 主库。离得远的地区会多几十到上百毫秒，相对 LLM 的首字延迟可以忽略。

## 9. 并发限制器的失败模式

- **DO 休眠、被驱逐或因部署重启**：名额存在内置 SQLite 中，不会丢失。
- **Worker 在释放前崩溃**：名额 30 分钟后过期。原实现是 10 分钟；调长是为了容纳生成时间很长的推理请求，代价是崩溃时泄漏的名额会被占用更久。
- **请求超过 30 分钟**：名额被当作过期清理，此后不再计入并发数。
- **DO 调用失败**：放行请求（fail open），并记录日志。

## 10. 常量

| 名称 | 值 |
|---|---|
| 配置缓存 TTL | 10 秒 |
| 负载均衡统计缓存 TTL | 15 秒 |
| 并发名额过期（DO 内） | 30 分钟 |
| 单条录制响应体上限 | 10 MiB |
| 模型配置写入冲突重试 | 3 次 |
| 亲和映射过期 | 1 小时（按最后访问时间） |
| 指标保留 | 30 天 |
| `last_used_at` 写入节流 | 60 秒 |
| Cron | `*/5 * * * *` |
