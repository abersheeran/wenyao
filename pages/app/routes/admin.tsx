import * as React from "react";
import { Button } from "../components/ui/button";
import Input from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useAdminApi } from "~/apis";
import { BackendsPanel } from "../components/admin/backends/backends-panel";
import { ApiKeysPanel } from "../components/admin/api-keys/api-keys-panel";
import { StatsPanel } from "../components/admin/stats/stats-panel";
import { MetricsPanel } from "../components/admin/stats/metrics-panel";
import { AffinityPanel } from "../components/admin/affinity/affinity-panel";

export function meta() {
  return [
    { title: "Admin | LLM Proxy" },
  ];
}

export default function Admin() {
  const api = useAdminApi();
  const [tab, setTab] = React.useState<string>("backends");
  const [showApiKeyDialog, setShowApiKeyDialog] = React.useState(false);
  const [apiKeyInput, setApiKeyInput] = React.useState("");
  const [hasApiKey, setHasApiKey] = React.useState(false);

  // 检查是否已有 API Key
  React.useEffect(() => {
    const storedKey = localStorage.getItem('adminApiKey');
    setHasApiKey(!!storedKey);
    if (!storedKey) {
      setShowApiKeyDialog(true);
    }
  }, []);

  const handleSaveApiKey = () => {
    if (apiKeyInput.trim()) {
      localStorage.setItem('adminApiKey', apiKeyInput.trim());
      setHasApiKey(true);
      setShowApiKeyDialog(false);
      setApiKeyInput("");
      // 刷新页面以使用新的 API Key
      window.location.reload();
    }
  };

  const handleClearApiKey = () => {
    localStorage.removeItem('adminApiKey');
    setHasApiKey(false);
    setShowApiKeyDialog(true);
  };

  const tabOptions = [
    { value: "backends", label: "Backends" },
    { value: "apikeys", label: "API Keys" },
    { value: "affinity", label: "Affinity" },
    { value: "stats", label: "Stats" },
    { value: "metrics", label: "Metrics" },
  ];

  return (
    <main className="container mx-auto p-4 space-y-4">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold">Admin</h1>
          {hasApiKey && (
            <Button variant="outline" size="sm" onClick={handleClearApiKey}>
              退出登录
            </Button>
          )}
        </div>

        {/* 小屏幕：下拉选择 */}
        <div className="sm:hidden">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full justify-between">
                {tabOptions.find((option) => option.value === tab)?.label}
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
              {tabOptions.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => setTab(option.value)}
                  className={tab === option.value ? "bg-accent" : ""}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* 大屏幕：Tabs */}
        <div className="hidden sm:flex items-center gap-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v)}>
            <TabsList>
              <TabsTrigger value="backends">Backends</TabsTrigger>
              <TabsTrigger value="apikeys">API Keys</TabsTrigger>
              <TabsTrigger value="affinity">Affinity</TabsTrigger>
              <TabsTrigger value="stats">Stats</TabsTrigger>
              <TabsTrigger value="metrics">Metrics</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      {/* API Key 输入对话框 */}
      <Dialog open={showApiKeyDialog} onOpenChange={setShowApiKeyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>请输入管理 API 密钥</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              需要提供 API 密钥才能访问管理接口
            </p>
            <Input
              type="password"
              placeholder="请输入 API Key"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSaveApiKey();
                }
              }}
            />
            <Button onClick={handleSaveApiKey} className="w-full">
              确认
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {tab === "backends" && <BackendsPanel api={api} />}
      {tab === "apikeys" && <ApiKeysPanel api={api} />}
      {tab === "affinity" && <AffinityPanel api={api} />}
      {tab === "stats" && <StatsPanel api={api} />}
      {tab === "metrics" && <MetricsPanel api={api} />}
    </main>
  );
}
