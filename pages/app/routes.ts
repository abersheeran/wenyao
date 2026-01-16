import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("routes/admin.tsx", [
    index("routes/admin/backends.tsx"),
    route("apikeys", "routes/admin/apikeys.tsx"),
    route("affinity", "routes/admin/affinity.tsx"),
    route("stats", "routes/admin/stats.tsx"),
    route("metrics", "routes/admin/metrics.tsx"),
  ]),
] satisfies RouteConfig;
