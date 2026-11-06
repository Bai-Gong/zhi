import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { IconButton } from "../components/IconButton";
import { Sidebar } from "../features/sidebar/Sidebar";
import { ErrorBoundary } from "./ErrorBoundary";
import { installDocumentDrop } from "./documentDrop";
import { installNativeMenu } from "./nativeMenu";
import { installHotkeys } from "./hotkeys";
import { TopBar } from "./TopBar";
import { ROUTES } from "./routes";
import { useImmersiveEdges } from "./useImmersiveEdges";
import { useUiStore } from "./uiStore";
import "./theme.css";

/** 各路由的窗口标题后缀（中文文案）。 */
const PAGE_TITLES: Record<string, string> = {
  [ROUTES.home]: "首页",
  [ROUTES.viewer]: "查看器",
  [ROUTES.organize]: "页面组织",
};

/** 路由 → 窗口标题（/tools/* 按前缀归「工具向导」）。 */
function pageTitleOf(pathname: string): string {
  if (pathname.startsWith(ROUTES.toolWizard)) return "工具向导";
  return PAGE_TITLES[pathname] ?? "百工·纸";
}

/**
 * 四区布局（shell 模块）：顶栏 / 侧栏（仅查看器）/ 主区 / 右侧面板占位（仅查看器）。
 * 页面组装只在 shell 路由层完成（技术方案 4.3 规则 2）。
 *
 * 沉浸模式（M2 T7）：uiStore.immersive 为真时隐藏顶栏、侧栏与右侧面板（查看器内
 * 的标签条/工具栏由 ViewerPage 使用相同边缘唤出逻辑）；
 * 鼠标在顶缘或左缘驻留时唤出界面，离开界面后延迟收起，输入焦点保持时不收起；
 * Esc / Ctrl+I 退出（见 shell/hotkeys.ts）。
 */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const isViewer = location.pathname.startsWith(ROUTES.viewer);

  const rightPanelVisible = useUiStore((s) => s.rightPanelVisible);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const immersive = useUiStore((s) => s.immersive);

  // 全局快捷键（T8）：navigate 注入保留 replace 语义；navigate 引用稳定，装一次即可。
  useEffect(() => installHotkeys(navigate), [navigate]);
  useEffect(() => installNativeMenu(navigate), [navigate]);
  useEffect(() => installDocumentDrop(navigate), [navigate]);

  const edgeRevealed = useImmersiveEdges(immersive && isViewer);
  const chromeVisible = !immersive || !isViewer || edgeRevealed;
  useEffect(() => {
    if (!isViewer && immersive) useUiStore.getState().setImmersive(false);
  }, [isViewer, immersive]);

  // 路由驱动的窗口标题
  useEffect(() => {
    document.title = `百工·纸 · ${pageTitleOf(location.pathname)}`;
  }, [location.pathname]);

  return (
    <div className="app-shell fang-glass-shell">
      {/* TopBar 沉浸决策（T7，自行判断）：一并隐藏。顶栏承载的是应用级导航与主题
          切换，与「阅读」无关，沉浸的目标就是纯阅读画布；边缘唤出时顶栏随阅读
          界面一起临时回归（唤出即完整界面，避免「唤出了一半」的割裂感），Esc
          退出后原样恢复。顶栏自身无状态，条件渲染即可，无需保活。 */}
      {chromeVisible && <TopBar />}
      <div className="shell-body">
        {isViewer && chromeVisible && <Sidebar />}
        <main className="shell-main" id="shell-main">
          <ErrorBoundary resetKey={location.pathname + location.search}>
            <Outlet />
          </ErrorBoundary>
        </main>
        {isViewer &&
          chromeVisible &&
          (rightPanelVisible ? (
            <aside className="shell-aside fang-glass-surface" aria-label="右侧面板">
              <div className="shell-aside-header">
                <span className="shell-aside-title">任务面板</span>
                <IconButton icon={PanelRightClose} label="收起右侧面板" onClick={toggleRightPanel} />
              </div>
              <div className="panel-placeholder">
                右侧面板（占位）：批注列表、对象属性等任务面板将在此挂载。
              </div>
            </aside>
          ) : (
            <aside className="shell-aside fang-glass-surface collapsed" aria-label="右侧面板（已收起）">
              <IconButton icon={PanelRightOpen} label="展开右侧面板" onClick={toggleRightPanel} />
            </aside>
          ))}
      </div>
    </div>
  );
}
