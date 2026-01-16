# Metrics System

## 概述

指标采集系统已重构为可选的数据库后端模块。指标数据实时写入 MongoDB，支持聚合查询和 Prometheus 格式导出。

## 配置

### 环境变量

```bash
# 启用/禁用指标收集（默认: true）
ENABLE_METRICS=true

# MongoDB 连接（指标启用时需要）
MONGODB_URL=mongodb://localhost:27017/wenyao
```

### 启用指标

```bash
# 使用默认配置启动（指标启用）
npm start

# 或显式启用
ENABLE_METRICS=true npm start
```

### 禁用指标

```bash
ENABLE_METRICS=false npm start
```

**注意**: 禁用指标时，不能使用以下负载均衡策略：
- `lowest-ttft`
- `min-error-rate`

系统会在启动时验证配置，如果检测到不兼容的策略会报错。

## 数据模型

### request_metrics 集合（Time Series Collection）

MongoDB Time Series Collection 专为时序数据优化，自动压缩存储并提升查询性能。

```typescript
{
  instanceId: string        // 实例 ID
  backendId: string        // 后端 ID（metaField）
  timestamp: Date          // 时间戳（timeField）
  requestId: string        // 请求唯一标识
  status: 'success' | 'failure'
  duration: number         // 总时长（毫秒）
  ttft?: number           // Time to First Token（毫秒）
  streamType?: 'streaming' | 'non-streaming'
  model?: string          // 模型名称
  errorType?: string      // 错误类型
}
```

**Time Series 配置**:
- `timeField`: `timestamp`
- `metaField`: `backendId`
- `granularity`: `seconds`

### 创建集合

集合会在首次启动时自动创建。手动创建方式：

```javascript
db.createCollection('request_metrics', {
  timeseries: {
    timeField: 'timestamp',
    metaField: 'backendId',
    granularity: 'seconds'
  }
})
```

### 索引

系统会自动创建以下索引：

- `{ backendId: 1, timestamp: -1 }` - 后端 + 时间查询
- `{ instanceId: 1, timestamp: -1 }` - 实例 + 时间查询
- `{ requestId: 1 }` - 请求去重

### TTL 索引（可选）

TTL 索引用于自动清理过期数据，**需要用户手动创建**：

```javascript
// 7 天后自动删除
db.request_metrics.createIndex(
  { timestamp: 1 },
  { expireAfterSeconds: 604800 }
)

// 30 天后自动删除
db.request_metrics.createIndex(
  { timestamp: 1 },
  { expireAfterSeconds: 2592000 }
)
```

如果不创建 TTL 索引，数据将永久保留，需要手动清理。

## API 端点

### 获取统计数据

```bash
# 获取所有后端的近期统计（最近 30 秒）
GET /admin/stats

# 获取特定后端的统计（最近 30 秒）
GET /admin/stats/:backendId

# 获取历史统计数据
GET /admin/stats/history/:backendId?startTime=<ISO>&endTime=<ISO>

# 获取所有后端的历史统计
GET /admin/stats/history?startTime=<ISO>&endTime=<ISO>&instanceId=<optional>
```

### 获取 Prometheus 指标

```bash
# 获取 Prometheus 文本格式指标（最近 5 分钟）
GET /admin/metrics
```

### 重置统计数据

```bash
# 重置特定后端的统计
DELETE /admin/stats/:backendId

# 重置所有后端的统计
DELETE /admin/stats
```

### 实例管理

```bash
# 获取所有活跃实例（最近 60 秒）
GET /admin/instances

# 获取特定实例的统计（最近 30 秒）
GET /admin/instances/:instanceId/stats
```

## 负载均衡策略

### 依赖指标的策略

以下策略需要指标系统启用：

- **lowest-ttft**: 选择 TTFT 最低的后端
- **min-error-rate**: 选择错误率最低的后端

### 不依赖指标的策略

以下策略可以在指标禁用时使用：

- **weighted**: 基于权重的随机选择
- **round-robin**: 轮询选择

## 架构

### 模块结构

```
src/services/metrics/
├── index.ts                 # 工厂函数和验证
├── interface.ts             # MetricsCollector 接口
├── types.ts                 # 类型定义
├── noop-collector.ts        # 空操作实现
├── db-collector.ts          # 数据库实现
├── storage.ts               # MongoDB 存储层
└── prometheus-exporter.ts   # Prometheus 导出器
```

### 实现方式

1. **DbMetricsCollector**: 数据库后端实现
   - 实时异步写入（fire-and-forget）
   - 支持聚合查询
   - 生成 Prometheus 格式

2. **NoopMetricsCollector**: 空操作实现
   - 指标禁用时使用
   - 所有方法都是 no-op
   - 零性能开销

### 写入策略

- **实时写入**: 每个请求完成后立即写入 MongoDB
- **异步非阻塞**: 使用 fire-and-forget 模式，不影响请求延迟
- **错误容忍**: 指标写入失败不影响代理功能

## 性能考虑

- **写入延迟**: <5ms 开销（异步写入）
- **查询性能**: Time Series Collection 优化的时序查询，使用复合索引
- **存储效率**: Time Series Collection 自动压缩数据，减少存储空间
- **内存占用**: 无内存累积，数据直接写入数据库
- **数据清理**: 可选 TTL 索引自动删除过期数据，或手动清理

## 故障排查

### 指标未记录

1. 检查 `ENABLE_METRICS` 环境变量
2. 确认 MongoDB 连接正常
3. 查看启动日志中的指标初始化信息

### 策略验证失败

```
Configuration error for model 'gpt-4': Strategy 'lowest-ttft' requires metrics to be enabled
```

**解决方案**:
- 启用指标: `ENABLE_METRICS=true`
- 或更改为不依赖指标的策略（如 `weighted`）

### Prometheus 端点返回 503

这表示指标系统已禁用。启用指标或使用 `/admin/stats` 端点。

## 示例

### 查询统计

```bash
# 获取最近统计
curl http://localhost:3000/admin/stats

# 获取历史数据（最近 1 小时）
START=$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ")
END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
curl "http://localhost:3000/admin/stats/history?startTime=$START&endTime=$END"
```

### Prometheus 集成

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'wenyao'
    scrape_interval: 30s
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/admin/metrics'
    authorization:
      credentials: 'your-admin-api-key'
```

### 数据管理

#### 手动清理历史数据

```javascript
// 删除 30 天前的数据
db.request_metrics.deleteMany({
  timestamp: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
})

// 删除特定后端的数据
db.request_metrics.deleteMany({
  backendId: 'backend-1'
})
```

#### 检查集合大小

```javascript
// 查看集合统计信息
db.request_metrics.stats()

// 查看数据量
db.request_metrics.countDocuments()
```

#### Time Series Collection 优势

1. **自动压缩**: MongoDB 自动对时序数据进行压缩，减少存储空间 70-90%
2. **查询优化**: 时间范围查询性能提升 2-10 倍
3. **内存效率**: 专为时序数据优化的内存使用
4. **聚合性能**: 时间分组聚合查询性能显著提升
