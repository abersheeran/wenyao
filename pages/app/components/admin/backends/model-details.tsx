import type { ReactNode } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import type { BackendConfig, Connection, LoadBalancingStrategy, ModelConfig, useAdminApi } from "~/apis";
import { getProviderBadgeClass, getProviderDisplayName } from "../../../config/provider-config";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";

export type ListedModel = Awaited<ReturnType<ReturnType<typeof useAdminApi>["listModels"]>>[number];

type ModelDetailsProps = {
  model: ListedModel;
  connections: Connection[];
  onEditModel: (model: ModelConfig) => void;
  onDeleteModel: (model: string) => void;
  onAddBackend: (model: string) => void;
  onEditBackend: (model: string, backend: BackendConfig) => void;
  onDeleteBackend: (model: string, backendId: string) => void;
  onUpdateEnabled: (model: string, backendId: string, value: boolean) => void;
  onUpdateRecordRequests: (model: string, backendId: string, value: boolean) => void;
  onUpdateRecordResponses: (model: string, backendId: string, value: boolean) => void;
  onReorderBackends: (model: string, from: number, to: number) => void;
  reordering: boolean;
};

function SortableBackendRow({ id, position, disabled, children }: {
  id: string;
  position: number;
  disabled: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });

  return (
    <TableRow
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "relative z-10 bg-blue-50 opacity-70 shadow-lg outline outline-blue-200" : undefined}
    >
      <TableCell>
        <div className="flex items-center gap-1">
          {/* attributes set aria-disabled; a native disabled would drop keyboard focus during a save. */}
          <Button
            ref={setActivatorNodeRef}
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0 touch-none cursor-grab active:cursor-grabbing aria-disabled:cursor-default aria-disabled:opacity-50"
            {...attributes}
            {...listeners}
            aria-label={`Reorder backend ${id}`}
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </Button>
          <span className="text-xs tabular-nums text-gray-500">{position}</span>
        </div>
      </TableCell>
      {children}
    </TableRow>
  );
}

function formatTimeout(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

const strategyLabels: Record<LoadBalancingStrategy, { text: string; color: string }> = {
  weighted: { text: "权重策略", color: "bg-blue-100 text-blue-800" },
  "lowest-ttft": { text: "最低 TTFT", color: "bg-green-100 text-green-800" },
  "min-error-rate": { text: "最小错误率", color: "bg-purple-100 text-purple-800" },
};

export function ModelDetails({
  model,
  connections,
  onEditModel,
  onDeleteModel,
  onAddBackend,
  onEditBackend,
  onDeleteBackend,
  onUpdateEnabled,
  onUpdateRecordRequests,
  onUpdateRecordResponses,
  onReorderBackends,
  reordering,
}: ModelDetailsProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const strategy = strategyLabels[model.loadBalancingStrategy] ?? {
    text: model.loadBalancingStrategy,
    color: "bg-gray-100 text-gray-800",
  };
  const backends: ListedModel["backends"][number][] = model.backends;

  return (
    <section className="min-w-0 max-w-full rounded-lg border bg-white shadow-sm" aria-label={`Model details for ${model.model}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-t-lg border-b bg-gray-50/80 p-4">
        <div className="min-w-0 space-y-3">
          <h3 className="break-all text-lg font-medium">{model.model}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${getProviderBadgeClass(model.provider)}`}>
              {getProviderDisplayName(model.provider)}
            </span>
            <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${strategy.color}`}>
              {strategy.text}
            </span>
            <span className="text-sm text-gray-600">亲和: {model.enableAffinity ? "已开启" : "未开启"}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => onEditModel(model)}>
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onDeleteModel(model.model)}>
            Delete
          </Button>
        </div>
      </div>

      <div className="min-w-0 space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-medium">Backends ({backends.length})</h4>
          <Button size="sm" onClick={() => onAddBackend(model.model)}>
            + Add Backend
          </Button>
        </div>
        {backends.length === 0 ? (
          <p className="py-4 text-sm text-gray-500">No backends configured for this model. Add a backend to start routing requests.</p>
        ) : (
          <>
            <div className="rounded-md border border-blue-100 bg-blue-50/60 p-3 text-xs text-gray-700">
              <p>
                <span className="font-medium">失败回退：</span>
                首个 backend 失败后，按下表顺序从它之后依次尝试其余已启用的 backend，到末尾后从头继续，每个最多尝试一次。
              </p>
              <details className="mt-1">
                <summary className="cursor-pointer text-blue-700">详细规则</summary>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  <li>
                    首个 backend 只从已启用且权重大于 0 的 backend 中选择：开启亲和时优先用会话绑定的 backend，否则按负载均衡策略选择；请求头 <code className="font-mono">X-Backend-ID</code> 可以直接指定。
                  </li>
                  <li>以下情况视为失败：上游返回非 2xx、网络错误、TTFT 超时、非流式响应不是合法 JSON、达到最大并发。</li>
                  <li>权重为 0 的已启用 backend 不会被首选，只在回退时使用；禁用的 backend 不参与。</li>
                  <li>流式响应开始返回后再中断，不会回退。全部失败时，返回最后一次尝试的错误。</li>
                </ul>
              </details>
            </div>
            <p className="text-xs text-gray-500">表格顺序就是回退顺序，可以拖动手柄调整；键盘聚焦手柄后按空格拿起，方向键移动，空格放下，Esc 取消。</p>
            <DndContext
              key={model.model}
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={({ active, over }) => {
                if (reordering || !over || active.id === over.id) return;
                const from = backends.findIndex(backend => backend.id === active.id);
                const to = backends.findIndex(backend => backend.id === over.id);
                if (from !== -1 && to !== -1) onReorderBackends(model.model, from, to);
              }}
            >
              <Table aria-label={`Backends for ${model.model}`}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">顺序</TableHead>
                    <TableHead className="w-16">Enabled</TableHead>
                    <TableHead>Backend</TableHead>
                    <TableHead>Weight</TableHead>
                    <TableHead>Limits</TableHead>
                    <TableHead>Recording</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <SortableContext items={backends.map(backend => backend.id)} strategy={verticalListSortingStrategy}>
                  <TableBody>
                    {backends.map((backend, index) => {
                      const connection = connections.find((item) => item.id === backend.connectionId);
                      const streaming = backend.streamingTTFTTimeout ?? 0;
                      const nonStreaming = backend.nonStreamingTTFTTimeout ?? 0;
                      return (
                        <SortableBackendRow key={backend.id} id={backend.id} position={index + 1} disabled={reordering || backends.length < 2}>
                          <TableCell>
                            <Switch
                              aria-label={`Enable backend ${backend.id}`}
                              checked={backend.enabled}
                              onCheckedChange={(checked) => onUpdateEnabled(model.model, backend.id, checked)}
                            />
                          </TableCell>
                          <TableCell className="whitespace-normal break-words">
                            <div className="font-mono text-sm">{backend.id}</div>
                            <div className="text-xs text-gray-500" title="Connection">
                              {connection?.name || backend.connectionId || <span className="text-amber-700">Connection not configured</span>}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">{backend.weight}</div>
                            {backend.enabled && backend.weight === 0 ? (
                              <div className="text-xs text-amber-700" title="权重为 0：不会被首选，只在回退时使用">仅回退</div>
                            ) : (
                              <div className="text-xs text-gray-500" title="流量占比">{(backend.trafficRatio * 100).toFixed(1)}%</div>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <div className="text-sm" title="最大并发请求数">
                              并发 {backend.maxConcurrentRequests ? backend.maxConcurrentRequests : "∞"}
                            </div>
                            <div className="text-xs text-gray-500" title="TTFT 超时">
                              TTFT {streaming || nonStreaming
                                ? [streaming && `流式 ${formatTimeout(streaming)}`, nonStreaming && `非流式 ${formatTimeout(nonStreaming)}`].filter(Boolean).join(" · ")
                                : "-"}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1.5 text-xs">
                              <label className="inline-flex items-center gap-2">
                                <Switch
                                  aria-label={`Record requests for ${backend.id}`}
                                  checked={backend.recordRequests ?? false}
                                  onCheckedChange={(checked) => onUpdateRecordRequests(model.model, backend.id, checked)}
                                />
                                请求
                              </label>
                              <label className={`inline-flex items-center gap-2 ${backend.recordRequests ? "" : "text-gray-400"}`}>
                                <Switch
                                  aria-label={`Record responses for ${backend.id}`}
                                  checked={backend.recordResponses ?? false}
                                  disabled={!backend.recordRequests}
                                  onCheckedChange={(checked) => onUpdateRecordResponses(model.model, backend.id, checked)}
                                />
                                响应
                              </label>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit backend ${backend.id}`}
                                title="Edit"
                                onClick={() => onEditBackend(model.model, backend)}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete backend ${backend.id}`}
                                title="Delete"
                                className="text-red-600 hover:text-red-700"
                                onClick={() => onDeleteBackend(model.model, backend.id)}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          </TableCell>
                        </SortableBackendRow>
                      );
                    })}
                  </TableBody>
                </SortableContext>
              </Table>
            </DndContext>
          </>
        )}
      </div>
    </section>
  );
}
