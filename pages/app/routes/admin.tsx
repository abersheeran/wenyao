import * as React from "react";
import { Link, Outlet, useLocation } from "react-router";
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
import { Menu, LogOut } from "lucide-react";

export function meta() {
  return [
    { title: "Admin | LLM Proxy" },
  ];
}

export default function Admin() {
  const location = useLocation();
  const [showApiKeyDialog, setShowApiKeyDialog] = React.useState(false);
  const [apiKeyInput, setApiKeyInput] = React.useState("");
  const [hasApiKey, setHasApiKey] = React.useState(false);

  // 从路径获取当前 tab
  const getCurrentTab = () => {
    const path = location.pathname;
    if (path === "/" || path === "") return "backends";
    if (path.includes("/apikeys")) return "apikeys";
    if (path.includes("/affinity")) return "affinity";
    if (path.includes("/stats")) return "stats";
    if (path.includes("/metrics")) return "metrics";
    return "backends";
  };

  const tab = getCurrentTab();

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
    { value: "backends", label: "Backends", path: "/" },
    { value: "apikeys", label: "API Keys", path: "/apikeys" },
    { value: "affinity", label: "Affinity", path: "/affinity" },
    { value: "stats", label: "Stats", path: "/stats" },
    { value: "metrics", label: "Metrics", path: "/metrics" },
  ];

  return (
    <main className="container mx-auto p-4 space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Admin</h1>

        <div className="flex items-center gap-4">
          {/* 大屏幕：Tabs */}
          <div className="hidden sm:block">
            <Tabs value={tab}>
              <TabsList>
                {tabOptions.map((option) => (
                  <TabsTrigger key={option.value} value={option.value} asChild>
                    <Link to={option.path}>{option.label}</Link>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {hasApiKey && (
            <Button
              size="icon"
              variant="ghost"
              onClick={handleClearApiKey}
              title="退出登录"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          )}

          {/* 小屏幕：菜单图标 */}
          <div className="sm:hidden">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost">
                  <Menu className="h-5 w-5" />
                  {tabOptions.find((opt) => opt.value === tab)?.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {tabOptions.map((option) => (
                  <DropdownMenuItem key={option.value} asChild>
                    <Link
                      to={option.path}
                      className={tab === option.value ? "bg-accent" : ""}
                    >
                      {option.label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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

      <Outlet />
    </main>
  );
}
