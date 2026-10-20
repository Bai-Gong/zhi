import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import clsx from "clsx";
import { IconButton } from "../components/IconButton";
import { Sidebar } from "../features/sidebar/Sidebar";
import { ErrorBoundary } from "./ErrorBoundary";
import { TopBar } from "./TopBar";
import { ROUTES } from "./routes";
import { useUiStore } from "./uiStore";
import { useImmersiveEdges } from "./useImmersiveEdges";
import "./theme.css";

/** 各路由的窗口标题后缀（中文文案）。 */
const PAGE_TITLES: Record<string, string> = {
  [ROUTES.home]: "首页",
  [ROUTES.viewer]: "查看器",
};

/**
 * 四区布局（shell 模块）：顶栏 / 侧栏（仅查看器）/ 主区 / 右侧面板占位（仅查看器）。
 * 页面组装只在 shell 路由层完成（技术方案 4.3 规则 2）。
 * 沉浸模式（M2 阅读模式）：顶栏/侧栏/右侧面板转覆盖层隐藏，鼠标移到边缘唤出
 * （useImmersiveEdges 状态机）；关闭文档仍在 /viewer，沉浸保持——视图模式非文档会话属性。
 */
export function AppShell() {
  const location = useLocation();
  const isViewer = location.pathname.startsWith(ROUTES.viewer);

  const rightPanelVisible = useUiStore((s) => s.rightPanelVisible);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const immersiveMode = useUiStore((s) => s.immersiveMode);
  const immersiveReveal = useUiStore((s) => s.immersiveReveal);

  // 边缘唤出状态机：仅沉浸且查看器路由激活。
  useImmersiveEdges(isViewer && immersiveMode);

  // 路由离开查看器即退出沉浸（进首页等导航）。
  useEffect(() => {
    if (!isViewer) useUiStore.getState().exitImmersive();
  }, [isViewer]);

  // 路由驱动的窗口标题
  useEffect(() => {
    document.title = `百工·纸 · ${PAGE_TITLES[location.pathname] ?? "百工·纸"}`;
  }, [location.pathname]);

  return (
    <div
      className={clsx("app-shell", {
        immersive: immersiveMode,
        "revealed-top": immersiveMode && immersiveReveal.top,
        "revealed-left": immersiveMode && immersiveReveal.left,
      })}
    >
      <TopBar />
      <div className="shell-body">
        {isViewer && <Sidebar />}
        <main className="shell-main" id="shell-main">
          <ErrorBoundary resetKey={location.pathname + location.search}>
            <Outlet />
          </ErrorBoundary>
        </main>
        {/* 沉浸下右侧面板不渲染（占位面板，无唤出需求） */}
        {isViewer &&
          !immersiveMode &&
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
