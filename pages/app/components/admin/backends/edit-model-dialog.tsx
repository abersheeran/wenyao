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
import { useAdminApi, type ModelConfig, type LoadBalancingStrategy, type MinErrorRateOptions } from "~/apis";

export function EditModelDialog({ open, onOpenChange, model, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  model: ModelConfig | null;
  onSaved: () => void;
}) {
  const api = useAdminApi();
  const [strategy, setStrategy] = React.useState<LoadBalancingStrategy>("weighted");
  const [enableAffinity, setEnableAffinity] = React.useState<boolean>(false);
  const [minErrorRateOpts, setMinErrorRateOpts] = React.useState<MinErrorRateOptions>({
    minRequests: 20,
    circuitBreakerThreshold: 0.9,
    epsilon: 0.001,
    timeWindowMinutes: 15
  });

  React.useEffect(() => {
    if (model) {
      setStrategy(model.loadBalancingStrategy);
      setEnableAffinity(model.enableAffinity || false);
      // Load existing options or use defaults
      setMinErrorRateOpts({
        minRequests: model.minErrorRateOptions?.minRequests ?? 20,
        circuitBreakerThreshold: model.minErrorRateOptions?.circuitBreakerThreshold ?? 0.9,
        epsilon: model.minErrorRateOptions?.epsilon ?? 0.001,
        timeWindowMinutes: model.minErrorRateOptions?.timeWindowMinutes ?? 15
      });
    }
  }, [model]);

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model) return;
    await api.updateModel(model.model, {
      loadBalancingStrategy: strategy,
      enableAffinity: enableAffinity,
      minErrorRateOptions: strategy === 'min-error-rate' ? minErrorRateOpts : undefined
    });
    onSaved();
  }, [api, model, strategy, enableAffinity, minErrorRateOpts, onSaved]);

  if (!model) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Model: {model.model}</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">Model Name</label>
            <Input value={model.model} disabled readOnly />
            <p className="text-xs text-gray-500 mt-1">Model name cannot be changed</p>
          </div>
          <div>
            <label className="block text-sm mb-1">Load Balancing Strategy</label>
            <Select value={strategy} onValueChange={(v) => setStrategy(v as LoadBalancingStrategy)}>
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
              {strategy === 'weighted' && '根据配置的权重分配流量'}
              {strategy === 'lowest-ttft' && '选择平均首token时间最低的后端'}
              {strategy === 'min-error-rate' && '根据错误率动态调整流量分配'}
            </p>
          </div>

          {/* Enable Affinity Option */}
          <div className="border rounded-lg p-4 space-y-2 bg-gray-50">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={enableAffinity}
                onChange={(e) => setEnableAffinity(e.target.checked)}
                className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-sm font-medium">启用后端亲和性 (Enable Backend Affinity)</span>
            </label>
            <p className="text-xs text-gray-500 ml-6">
              启用后，相同 X-Session-ID 的请求会被路由到同一个后端，用于复用 KV 缓存
            </p>
          </div>

          {/* Min Error Rate Options - Only show when strategy is min-error-rate */}
          {strategy === 'min-error-rate' && (
            <div className="border rounded-lg p-4 space-y-3 bg-gray-50">
              <h4 className="text-sm font-medium text-gray-700">最小错误率策略配置</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm mb-1">最小请求数</label>
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
                  <label className="block text-sm mb-1">熔断阈值</label>
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
              {submitState.loading ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
