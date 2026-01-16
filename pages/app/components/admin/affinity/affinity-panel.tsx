import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../../ui/table";
import Input from "../../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { useAdminApi, type AffinityMapping, type ModelConfig } from "~/apis";
import { Trash2, RefreshCcw } from "lucide-react";

export function AffinityPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [mappings, setMappings] = React.useState<AffinityMapping[]>([]);
  const [total, setTotal] = React.useState(0);
  const [models, setModels] = React.useState<ModelConfig[]>([]);
  const [filterModel, setFilterModel] = React.useState<string>("");
  const [filterBackendId, setFilterBackendId] = React.useState<string>("");
  const [page, setPage] = React.useState(0);
  const limit = 50;

  const [listState, load] = useAsyncFn(async () => {
    try {
      const filter: any = {};
      if (filterModel) filter.model = filterModel;
      if (filterBackendId) filter.backendId = filterBackendId;

      const data = await api.listAffinityMappings({
        ...filter,
        limit,
        offset: page * limit
      });
      setMappings(data.mappings);
      setTotal(data.total);
      return data;
    } catch (error: any) {
      if (error?.message?.includes('Unauthorized') || error?.message?.includes('401')) {
        localStorage.removeItem('adminApiKey');
        window.location.reload();
      }
      throw error;
    }
  }, [api, filterModel, filterBackendId, page]);

  const [modelsState, loadModels] = useAsyncFn(async () => {
    try {
      const data = await api.listModels();
      setModels(data);
      return data;
    } catch (error) {
      console.error('Failed to load models:', error);
      return [];
    }
  }, [api]);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    loadModels();
  }, [loadModels]);

  const [deleteState, deleteMapping] = useAsyncFn(
    async (model: string, sessionId: string) => {
      if (!confirm(`确定要删除 ${model}:${sessionId} 的亲和性映射吗？`)) return;
      await api.deleteAffinityMapping(model, sessionId);
      await load();
    },
    [api, load]
  );

  const [clearState, clearMappings] = useAsyncFn(
    async () => {
      const filter: any = {};
      if (filterModel) filter.model = filterModel;
      if (filterBackendId) filter.backendId = filterBackendId;

      if (Object.keys(filter).length === 0) {
        alert('请至少选择一个过滤条件再清除映射');
        return;
      }

      const filterDesc = Object.entries(filter)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');

      if (!confirm(`确定要清除符合条件的所有亲和性映射吗？\n过滤条件: ${filterDesc}`)) return;

      await api.clearAffinityMappings(filter);
      await load();
    },
    [api, load, filterModel, filterBackendId]
  );

  const totalPages = Math.ceil(total / limit);

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>亲和性映射管理 (Affinity Mappings)</span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={load}
                disabled={listState.loading}
              >
                <RefreshCcw className="w-4 h-4 mr-1" />
                刷新
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={clearMappings}
                disabled={clearState.loading || (!filterModel && !filterBackendId)}
              >
                <Trash2 className="w-4 h-4 mr-1" />
                批量清除
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm mb-1">按 Model 过滤</label>
              <Select value={filterModel} onValueChange={(v) => {
                setFilterModel(v === "all" ? "" : v);
                setPage(0);
              }}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="全部模型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部模型</SelectItem>
                  {models.map(m => (
                    <SelectItem key={m.model} value={m.model}>
                      {m.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-sm mb-1">按 Backend ID 过滤</label>
              <Input
                placeholder="输入 backend ID"
                value={filterBackendId}
                onChange={(e) => {
                  setFilterBackendId(e.target.value);
                  setPage(0);
                }}
              />
            </div>
            <div className="flex items-end">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setFilterModel("");
                  setFilterBackendId("");
                  setPage(0);
                }}
              >
                清除过滤
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="mb-4 text-sm text-gray-600">
            共 {total} 条映射记录
            {(filterModel || filterBackendId) && (
              <span className="ml-2 text-blue-600">
                (已过滤)
              </span>
            )}
          </div>

          {listState.loading && <p className="text-sm text-gray-500">加载中...</p>}
          {listState.error && <p className="text-sm text-red-600">错误: {listState.error.message}</p>}

          {!listState.loading && mappings.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-8">
              {filterModel || filterBackendId ? '没有符合条件的映射记录' : '暂无亲和性映射记录'}
            </p>
          )}

          {!listState.loading && mappings.length > 0 && (
            <>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead>Session ID</TableHead>
                      <TableHead>Backend ID</TableHead>
                      <TableHead>访问次数</TableHead>
                      <TableHead>创建时间</TableHead>
                      <TableHead>最后访问</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mappings.map((mapping) => (
                      <TableRow key={`${mapping.model}:${mapping.sessionId}`}>
                        <TableCell className="font-mono text-sm">{mapping.model}</TableCell>
                        <TableCell className="font-mono text-xs">{mapping.sessionId}</TableCell>
                        <TableCell className="font-mono text-sm">{mapping.backendId}</TableCell>
                        <TableCell>{mapping.accessCount}</TableCell>
                        <TableCell className="text-xs">{formatDate(mapping.createdAt)}</TableCell>
                        <TableCell className="text-xs">{formatDate(mapping.lastAccessedAt)}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteMapping(mapping.model, mapping.sessionId)}
                            disabled={deleteState.loading}
                          >
                            <Trash2 className="w-4 h-4 text-red-600" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between">
                  <div className="text-sm text-gray-600">
                    第 {page + 1} / {totalPages} 页
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={page === 0 || listState.loading}
                    >
                      上一页
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1 || listState.loading}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Help Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">使用说明</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 space-y-2">
          <p>• <strong>亲和性映射</strong>：记录了哪个 session ID 被路由到哪个 backend</p>
          <p>• <strong>自动清理</strong>：超过 1 小时未访问的映射会被自动删除</p>
          <p>• <strong>启用方式</strong>：在模型配置中启用 "后端亲和性" 选项</p>
          <p>• <strong>客户端使用</strong>：在请求头中添加 <code className="px-1 py-0.5 bg-gray-100 rounded">X-Session-ID</code> 即可</p>
          <p>• <strong>优先级</strong>：X-Backend-ID (强制) &gt; 亲和性 &gt; 负载均衡</p>
        </CardContent>
      </Card>
    </div>
  );
}
