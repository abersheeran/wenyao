import * as React from "react";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis, Line, LineChart } from "recharts";
import type { StatsDataPoint } from "~/apis";
import { Button } from "../../ui/button";

// Generate a distinct color palette for any number of backends
const generateColor = (index: number, total: number): string => {
  // Use HSL color space for evenly distributed colors
  const hue = (index * 360) / Math.max(total, 1);
  const saturation = 70; // Vibrant colors
  const lightness = 50; // Medium brightness
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
};

export function HistoricalCharts({ historyData }: { historyData: Record<string, StatsDataPoint[]> }) {
  const backendIds = Object.keys(historyData);
  const [selectedBackends, setSelectedBackends] = React.useState<Set<string>>(
    new Set(backendIds)
  );

  // Update selected backends when backendIds change
  React.useEffect(() => {
    setSelectedBackends((prev) => {
      const currentIds = new Set(backendIds);

      // First render - select all
      if (prev.size === 0 && backendIds.length > 0) {
        return currentIds;
      }

      // Keep existing selection, but remove backends that no longer exist
      // and add new backends if they appear
      const updated = new Set<string>();

      // Keep previously selected backends that still exist
      prev.forEach(id => {
        if (currentIds.has(id)) {
          updated.add(id);
        }
      });

      // Auto-select new backends
      backendIds.forEach(id => {
        if (!prev.has(id)) {
          updated.add(id);
        }
      });

      return updated;
    });
  }, [backendIds.join(',')]);

  // Generate distinct colors for each backend
  const backendColors = React.useMemo(() => {
    const colors: Record<string, string> = {};
    backendIds.forEach((id, index) => {
      colors[id] = generateColor(index, backendIds.length);
    });
    return colors;
  }, [backendIds]);

  const toggleBackend = (backendId: string) => {
    setSelectedBackends((prev) => {
      const next = new Set(prev);
      if (next.has(backendId)) {
        next.delete(backendId);
      } else {
        next.add(backendId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedBackends.size === backendIds.length) {
      setSelectedBackends(new Set());
    } else {
      setSelectedBackends(new Set(backendIds));
    }
  };

  // Filter backends based on selection
  const visibleBackendIds = backendIds.filter((id) => selectedBackends.has(id));

  // Prepare data for charts - merge all backends into single timeline
  const mergedData = React.useMemo(() => {
    const timeMap = new Map<string, any>();

    backendIds.forEach((backendId) => {
      const points = historyData[backendId] || [];
      points.forEach(point => {
        const time = new Date(point.timestamp).getTime();
        const timeKey = time.toString();

        if (!timeMap.has(timeKey)) {
          timeMap.set(timeKey, { time, timestamp: point.timestamp });
        }

        const entry = timeMap.get(timeKey);
        entry[`successRate_${backendId}`] = point.successRate * 100;
        entry[`streamingTtft_${backendId}`] = point.averageStreamingTTFT || 0;
        entry[`nonStreamingTtft_${backendId}`] = point.averageNonStreamingTTFT || 0;
        entry[`requests_${backendId}`] = point.totalRequests;
      });
    });

    return Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
  }, [historyData, backendIds]);

  const formatTime = (timestamp: string | Date) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const chartConfig = React.useMemo(() => {
    const config: Record<string, { label: string; color: string }> = {};
    backendIds.forEach((id) => {
      const color = backendColors[id];
      config[`successRate_${id}`] = {
        label: id,
        color: color,
      };
      // For streaming, use the base color with solid line
      config[`streamingTtft_${id}`] = {
        label: `${id} (流式)`,
        color: color,
      };
      // For non-streaming, use a lighter/dashed variant
      config[`nonStreamingTtft_${id}`] = {
        label: `${id} (非流式)`,
        color: color,
      };
      config[`requests_${id}`] = {
        label: id,
        color: color,
      };
    });
    return config;
  }, [backendIds, backendColors]);

  return (
    <>
      {/* Backend Filter */}
      <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium">Backend 筛选器</h4>
          <Button
            variant="outline"
            size="sm"
            onClick={toggleAll}
          >
            {selectedBackends.size === backendIds.length ? '取消全选' : '全选'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {backendIds.map((id) => (
            <button
              key={id}
              onClick={() => toggleBackend(id)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                selectedBackends.has(id)
                  ? 'bg-white border-2 shadow-sm'
                  : 'bg-gray-200 border-2 border-transparent opacity-50'
              }`}
              style={{
                borderColor: selectedBackends.has(id) ? backendColors[id] : 'transparent',
              }}
            >
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: backendColors[id] }}
              />
              <span>{id}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Success Rate Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">成功率趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 请求成功率变化 (%)</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <LineChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatTime}
            />
            <YAxis
              domain={[0, 100]}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}%`}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" />}
            />
            {visibleBackendIds.map((id) => (
              <Line
                key={id}
                dataKey={`successRate_${id}`}
                type="monotone"
                stroke={`var(--color-successRate_${id})`}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </div>

      {/* Streaming vs Non-Streaming TTFT Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">流式 vs 非流式 TTFT 对比</h3>
          <p className="text-sm text-muted-foreground">分别显示流式请求和非流式请求的首 Token 响应时间 (毫秒)</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <LineChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatTime}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}ms`}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" />}
            />
            {visibleBackendIds.map((id) => (
              <Line
                key={`streaming_${id}`}
                dataKey={`streamingTtft_${id}`}
                type="monotone"
                stroke={`var(--color-streamingTtft_${id})`}
                strokeWidth={2}
                dot={false}
              />
            ))}
            {visibleBackendIds.map((id) => (
              <Line
                key={`nonStreaming_${id}`}
                dataKey={`nonStreamingTtft_${id}`}
                type="monotone"
                stroke={`var(--color-nonStreamingTtft_${id})`}
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </div>

      {/* Total Requests Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">累计请求数趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 处理的总请求数量</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <AreaChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatTime}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" />}
            />
            {visibleBackendIds.map((id) => (
              <Area
                key={id}
                dataKey={`requests_${id}`}
                type="linear"
                fill={`var(--color-requests_${id})`}
                fillOpacity={0.25}
                stroke={`var(--color-requests_${id})`}
                strokeWidth={2}
                stackId="a"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </div>
    </>
  );
}
