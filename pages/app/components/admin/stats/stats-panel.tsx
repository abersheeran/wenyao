import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Spinner } from "../../ui/spinner";
import { useAdminApi, type StatsDataPoint } from "~/apis";
import { HistoricalCharts } from "./historical-charts";

export function StatsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [historyData, setHistoryData] = React.useState<Record<string, StatsDataPoint[]>>({});
  const [timeRange, setTimeRange] = React.useState<string>("1h"); // 1h, 6h, 24h, 7d
  const [autoRefresh, setAutoRefresh] = React.useState<boolean>(false);

  const [historyState, loadHistory] = useAsyncFn(async () => {
    const now = new Date();
    let startTime: Date;

    switch (timeRange) {
      case "1h":
        startTime = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case "6h":
        startTime = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        break;
      case "24h":
        startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "7d":
        startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      default:
        startTime = new Date(now.getTime() - 60 * 60 * 1000);
    }

    try {
      const data = await api.getAllHistoricalStats(startTime, now);
      setHistoryData(data);
      return data;
    } catch (error: any) {
      // Handle metrics disabled (503) gracefully
      if (error.message?.includes('503') || error.message?.includes('disabled')) {
        setHistoryData({});
        throw new Error('指标收集已禁用。请在服务器配置中启用 ENABLE_METRICS=true');
      }
      throw error;
    }
  }, [api, timeRange]);

  React.useEffect(() => {
    loadHistory();

    // Auto refresh every 30 seconds if enabled
    if (autoRefresh) {
      const interval = setInterval(() => {
        loadHistory();
      }, 30000);

      return () => clearInterval(interval);
    }
  }, [timeRange, autoRefresh]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">历史趋势（多实例聚合）</h2>
          <p className="text-sm text-muted-foreground mt-1">
            数据按 1 分钟聚合，每个时间点显示该分钟内所有请求的统计指标
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={timeRange} onValueChange={(v) => setTimeRange(v)}>
            <SelectTrigger className="text-sm w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">过去 1 小时</SelectItem>
              <SelectItem value="6h">过去 6 小时</SelectItem>
              <SelectItem value="24h">过去 24 小时</SelectItem>
              <SelectItem value="7d">过去 7 天</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={loadHistory} disabled={historyState.loading}>
            {historyState.loading ? <Spinner /> : <></> }
            刷新
          </Button>
          <div className="flex items-center gap-2 ml-1">
            <Switch
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
            />
            <span className="text-xs text-muted-foreground">
              自动刷新
            </span>
          </div>
        </div>
      </div>
      {historyState.error && (
        <p className="text-sm text-red-600 mb-2">{historyState.error.message}</p>
      )}
      {Object.keys(historyData).length === 0 ? (
        historyState.loading ? (
          <p className="text-sm text-gray-500">加载中...</p>
        ) : (
          <p className="text-sm text-gray-500">暂无历史数据</p>
        )
      ) : (
        <div className="space-y-8">
          <HistoricalCharts historyData={historyData} />
        </div>
      )}
    </div>
  );
}
