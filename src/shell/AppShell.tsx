import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { IconButton } from "../components/IconButton";
import { Sidebar } from "../features/sidebar/Sidebar";
import { ErrorBoundary } from "./ErrorBoundary";
import { installHotkeys } from "./hotkeys";
import { TopBar } from "./TopBar";
import { ROUTES } from "./routes";
import { useUiStore } from "./uiStore";
import "./theme.css";

/** 各路由的窗口标题后缀（中文文案）。 */
const PAGE_TITLES: Record<string, string> = {
  [ROUTES.home]: "首页",
  [ROUTES.viewer]: "查看器",
  [ROUTES.organize]: "页面组织",
};

/** 沉浸模式边缘唤出阈值（T7）：顶缘 8px 内唤出；鼠标越过唤出后的界面高度再收起。 */
const IMMERSIVE_REVEAL_PX = 8;
/** 收起阈值 ≈ 顶栏 48 + 标签条 34 + 工具栏 42 + 余量；与 ViewerPage 侧常量保持一致。 */
const IMMERSIVE_HIDE_PX = 140;

/**
 * 四区布局（shell 模块）：顶栏 / 侧栏（仅查看器）/ 主区 / 右侧面板占位（仅查看器）。
 * 页面组装只在 shell 路由层完成（技术方案 4.3 规则 2）。
 *
 * 沉浸模式（M2 T7）：uiStore.immersive 为真时隐藏顶栏、侧栏与右侧面板（查看器内
 * 的标签条/工具栏由 ViewerPage 以同款阈值各自联动，两侧独立判定、无共享状态）；
 * 鼠标移到窗口顶缘临时唤出全部界面，移入内容区（>IMMERSIVE_HIDE_PX）自动收起；
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

  // 沉浸边缘唤出：只在沉浸期间挂 mousemove 监听，退出即复位（不留瞬态残留）。
  const [edgeRevealed, setEdgeRevealed] = useState(false);
  useEffect(() => {
    if (!immersive) {
      setEdgeRevealed(false);
      return;
    }
    const onMove = (event: MouseEvent) => {
      if (event.clientY <= IMMERSIVE_REVEAL_PX) setEdgeRevealed(true);
      else if (event.clientY > IMMERSIVE_HIDE_PX) setEdgeRevealed(false);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [immersive]);
  const chromeVisible = !immersive || edgeRevealed;

  // 路由驱动的窗口标题
  useEffect(() => {
    document.title = `百工·纸 · ${PAGE_TITLES[location.pathname] ?? "百工·纸"}`;
  }, [location.pathname]);

  return (
    <div className="app-shell">
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
