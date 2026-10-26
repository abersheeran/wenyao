# 文鳐管理面板

React Router SPA（`ssr: false`），由同一个 Cloudflare Worker 的 Static Assets 托管。页面路由为 `/`、`/apikeys`、`/affinity`、`/stats`、`/metrics`。

在本目录安装依赖并启动前端开发服务器：

```bash
npm ci
npm run dev
```

开发服务器将 `/admin` 请求代理到 `http://localhost:8787`。请先按[项目 README](../README.md)准备 `.dev.vars`、应用本地 D1 migrations 并启动 Wrangler，或在根目录运行 `npm run dev:all`。

检查与构建：

```bash
npm run typecheck
npm run build
```

构建产物为 `build/client`；部署步骤见[项目 README](../README.md#部署)。
