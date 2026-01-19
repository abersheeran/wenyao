import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import Input from "../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { useAdminApi, type LoadBalancingStrategy, type MinErrorRateOptions, type ProviderType } from "~/apis";

export function AddModelDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void; }) {
  const api = useAdminApi();
  const [form, setForm] = React.useState<{ model: string; provider: ProviderType; loadBalancingStrategy: LoadBalancingStrategy; enableAffinity?: boolean; minErrorRateOptions?: MinErrorRateOptions }>({
    model: "",
    provider: "openai",
    loadBalancingStrategy: "weighted",
    enableAffinity: false
  });
  const [minErrorRateOpts, setMinErrorRateOpts] = React.useState<MinErrorRateOptions>({
    minRequests: 20,
    circuitBreakerThreshold: 0.9,
    epsilon: 0.001,
    timeWindowMinutes: 15
  });

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    await api.addModel({
      ...form,
      minErrorRateOptions: form.loadBalancingStrategy === 'min-error-rate' ? minErrorRateOpts : undefined
    });
    setForm({ model: "", provider: "openai", loadBalancingStrategy: "weighted", enableAffinity: false });
    setMinErrorRateOpts({ minRequests: 20, circuitBreakerThreshold: 0.9, epsilon: 0.001, timeWindowMinutes: 15 });
    onOpenChange(false);
    onAdded();
  }, [api, form, minErrorRateOpts, onOpenChange, onAdded]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Model</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">Model Name</label>
            <Input
              required
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="e.g., gpt-4, claude-3-sonnet"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Provider Type</label>
            <Select
              value={form.provider}
              onValueChange={(v) => setForm({ ...form, provider: v as ProviderType })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="bedrock">AWS Bedrock</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500 mt-1">
              选择此模型使用的 API 提供商类型。所有 backend 必须使用相同的 provider。
            </p>
          </div>
          <div>
            <label className="block text-sm mb-1">Load Balancing Strategy</label>
            <Select
              value={form.loadBalancingStrategy}
              onValueChange={(v) => setForm({ ...form, loadBalancingStrategy: v as LoadBalancingStrategy })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weighted">权重策略 (Weighted)</SelectItem>
                <SelectItem value="lowest-ttft">最低 TTFT (Lowest TTFT)</SelectItem>
                <SelectItem value="min-error-rate">最小错误率 (Min Error Rate)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500 mt-1">
              {form.loadBalancingStrategy === 'weighted' && '根据配置的权重分配流量'}
              {form.loadBalancingStrategy === 'lowest-ttft' && '选择平均首token时间最低的后端'}
              {form.loadBalancingStrategy === 'min-error-rate' && '根据错误率动态调整流量分配'}
            </p>
          </div>

          {/* Enable Affinity Option */}
          <div className="border rounded-lg p-4 space-y-2 bg-gray-50">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.enableAffinity || false}
                onChange={(e) => setForm({ ...form, enableAffinity: e.target.checked })}
                className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm font-medium">启用后端亲和性 (Enable Backend Affinity)</span>
            </label>
            <p className="text-xs text-gray-500 ml-6">
              启用后，相同 X-Session-ID 的请求会被路由到同一个后端，用于复用 KV 缓存
            </p>
          </div>

          {/* Min Error Rate Options - Only show when strategy is min-error-rate */}
          {form.loadBalancingStrategy === 'min-error-rate' && (
            <div className="border rounded-lg p-4 space-y-3 bg-gray-50">
              <h4 className="text-sm font-medium text-gray-700">最小错误率策略配置</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm mb-1">最小请求数 (minRequests)</label>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={minErrorRateOpts.minRequests}
                    onChange={(e) => setMinErrorRateOpts({ ...minErrorRateOpts, minRequests: Number(e.target.value) })}
                  />
                  <p className="text-xs text-gray-500 mt-1">默认: 20 - 达到此请求数后才使用实际错误率</p>
                </div>
                <div>
                  <label className="block text-sm mb-1">熔断阈值 (circuitBreakerThreshold)</label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={minErrorRateOpts.circuitBreakerThreshold}
                    onChange={(e) => setMinErrorRateOpts({ ...minErrorRateOpts, circuitBreakerThreshold: Number(e.target.value) })}
                  />
                  <p className="text-xs text-gray-500 mt-1">默认: 0.9 (90%) - 错误率超过此值触发熔断</p>
                </div>
                <div>
                  <label className="block text-sm mb-1">Epsilon 值</label>
                  <Input
                    type="number"
                    min={0}
                    step={0.0001}
                    value={minErrorRateOpts.epsilon}
                    onChange={(e) => setMinErrorRateOpts({ ...minErrorRateOpts, epsilon: Number(e.target.value) })}
                  />
                  <p className="text-xs text-gray-500 mt-1">默认: 0.001 - 避免除零错误的小值</p>
                </div>
                <div>
                  <label className="block text-sm mb-1">时间窗口 (分钟)</label>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={minErrorRateOpts.timeWindowMinutes}
                    onChange={(e) => setMinErrorRateOpts({ ...minErrorRateOpts, timeWindowMinutes: Number(e.target.value) })}
                  />
                  <p className="text-xs text-gray-500 mt-1">默认: 15 - 计算错误率的时间窗口</p>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitState.loading}>
              {submitState.loading ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
