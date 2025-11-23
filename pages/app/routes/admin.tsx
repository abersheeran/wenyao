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
import { useAdminApi } from "~/apis";
import { BackendsPanel } from "../components/admin/backends/backends-panel";
import { ApiKeysPanel } from "../components/admin/api-keys/api-keys-panel";
import { StatsPanel } from "../components/admin/stats/stats-panel";
import { MetricsPanel } from "../components/admin/stats/metrics-panel";

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

  return (
    <main className="container mx-auto p-4 space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Admin</h1>
        <div className="flex items-center gap-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v)}>
            <TabsList>
              <TabsTrigger value="backends">Backends</TabsTrigger>
              <TabsTrigger value="apikeys">API Keys</TabsTrigger>
              <TabsTrigger value="stats">Stats</TabsTrigger>
              <TabsTrigger value="metrics">Metrics</TabsTrigger>
            </TabsList>
          </Tabs>
          {hasApiKey && (
            <Button variant="outline" size="sm" onClick={handleClearApiKey}>
              更换密钥
            </Button>
          )}
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
      {tab === "stats" && <StatsPanel api={api} />}
      {tab === "metrics" && <MetricsPanel api={api} />}
    </main>
  );
}
