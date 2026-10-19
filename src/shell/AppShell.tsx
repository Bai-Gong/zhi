import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { IconButton } from "../components/IconButton";
import { Sidebar } from "../features/sidebar/Sidebar";
import { ErrorBoundary } from "./ErrorBoundary";
import { TopBar } from "./TopBar";
import { ROUTES } from "./routes";
import { useUiStore } from "./uiStore";
import "./theme.css";

/** 各路由的窗口标题后缀（中文文案）。 */
const PAGE_TITLES: Record<string, string> = {
  [ROUTES.home]: "首页",
  [ROUTES.viewer]: "查看器",
};

/**
 * 四区布局（shell 模块）：顶栏 / 侧栏（仅查看器）/ 主区 / 右侧面板占位（仅查看器）。
 * 页面组装只在 shell 路由层完成（技术方案 4.3 规则 2）。
 */
export function AppShell() {
  const location = useLocation();
  const isViewer = location.pathname.startsWith(ROUTES.viewer);

  const rightPanelVisible = useUiStore((s) => s.rightPanelVisible);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  // 路由驱动的窗口标题
  useEffect(() => {
    document.title = `百工·纸 · ${PAGE_TITLES[location.pathname] ?? "百工·纸"}`;
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <TopBar />
      <div className="shell-body">
        {isViewer && <Sidebar />}
        <main className="shell-main" id="shell-main">
          <ErrorBoundary resetKey={location.pathname + location.search}>
            <Outlet />
          </ErrorBoundary>
        </main>
        {isViewer &&
          (rightPanelVisible ? (
            <aside className="shell-aside" aria-label="右侧面板">
              <div className="shell-aside-header">
                <span className="shell-aside-title">任务面板</span>
                <IconButton icon={PanelRightClose} label="收起右侧面板" onClick={toggleRightPanel} />
              </div>
              <div className="panel-placeholder">
                右侧面板（占位）：批注列表、对象属性等任务面板将在此挂载。
              </div>
            </aside>
          ) : (
            <aside className="shell-aside collapsed" aria-label="右侧面板（已收起）">
              <IconButton icon={PanelRightOpen} label="展开右侧面板" onClick={toggleRightPanel} />
            </aside>
          ))}
      </div>
    </div>
  );
}
