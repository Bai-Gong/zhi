// 查看器顶部上下文工具栏（模块 3）：打开文件、侧栏开关、文件名、翻页与页码跳转、缩放与适应宽度、
// 搜索面板开关、画布反色与沉浸模式开关（M2 T7）、快捷键说明弹层（M2 T8）。
// 页码变化统一走 store.currentPage，由 ViewerPage 的滚动联动消费（按钮/页码输入/侧栏同一通道）；
// 「适应宽度」需要滚动容器与页面尺寸，真实计算经 scrollBridge 由 ViewerPage 注册执行。
// 打开/关闭与 Ctrl+O / Ctrl+W 同一实现（shell/hotkeys 的 openPickedPdf / closeTabAndSyncRoute），
// 按钮与快捷键两条入口永不漂移。
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  Contrast,
  FileX,
  FolderOpen,
  Keyboard,
  LayoutGrid,
  Maximize2,
  MoveHorizontal,
  PanelLeft,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { useDocumentStore, activeTabOf } from "../../core/document/store";
import { HOTKEY_LIST, closeTabAndSyncRoute, openPickedPdf } from "../../shell/hotkeys";
import { buildOrganizeUrl } from "../../shell/routes";
import { useUiStore } from "../../shell/uiStore";
import { clampScale, ZOOM_STEP } from "./pageGeometry";
import { requestFitWidth } from "./scrollBridge";

/** 快捷键说明弹层的遮罩与面板样式。内联而非新建 CSS 文件：本任务授权清单只含
 *  新增 tabStrip.css，且弹层只有一个实例；颜色一律走主题变量（深色自动成立）。 */
const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgb(0 0 0 / 0.4)",
};

const SHEET_STYLE: CSSProperties = {
  minWidth: 320,
  maxWidth: 440,
  maxHeight: "80vh",
  overflow: "auto",
  padding: 16,
  borderRadius: "var(--radius-md)",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  boxShadow: "0 8px 24px rgb(0 0 0 / 0.25)",
};

const HOTKEY_LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 6,
};

export function ViewerToolbar() {
  const navigate = useNavigate();
  // 工具栏只呈现激活标签的会话字段（多标签 store，M2-计划 D1）。
  const tab = useDocumentStore(activeTabOf);
  const numPages = tab.numPages;
  const currentPage = tab.currentPage;
  const scale = tab.scale;
  const fileName = tab.fileName;
  const sourcePath = tab.sourcePath;
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const setScale = useDocumentStore((s) => s.setScale);

  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  // 全文搜索入口（M2 T4）：只负责开合面板，关键词/开关/结果都在面板内；
  // Ctrl+F 由 shell/hotkeys 统一接入（打开面板 + 聚焦输入框）。
  const searchPanelOpen = useUiStore((s) => s.searchPanelOpen);
  const toggleSearchPanel = useUiStore((s) => s.toggleSearchPanel);
  // 画布反色（M2-计划 D8 / T7）：深色阅读的可选滤镜，默认关（性能取舍见
  // theme.css 的 .canvas-invert 注释）；开关本身不受文档状态限制——它是偏好。
  const canvasInvert = useUiStore((s) => s.canvasInvert);
  const toggleCanvasInvert = useUiStore((s) => s.toggleCanvasInvert);
  // 沉浸模式（T7）：进入后本工具栏隐藏（鼠标移到窗口顶缘唤出），Esc / Ctrl+I 退出。
  const immersive = useUiStore((s) => s.immersive);
  const toggleImmersive = useUiStore((s) => s.toggleImmersive);

  // 快捷键说明弹层（T8）：入口在本工具栏，清单来自 shell/hotkeys 的单一事实来源。
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [helpOpen]);

  const hasDocument = numPages > 0;

  /** 查看器内「打开」（技术方案 5.1）：与 Ctrl+O / 标签条「+」共用同一实现。 */
  const handleOpen = useCallback(() => void openPickedPdf(navigate), [navigate]);

  /** 进入组织模式（M3）：对当前激活标签的文档开组织视图（同路径已就绪，组织页不重载）。 */
  const handleOrganize = useCallback(() => {
    if (sourcePath) navigate(buildOrganizeUrl(sourcePath));
  }, [navigate, sourcePath]);

  /**
   * 关闭当前（激活）标签：取消其渲染、销毁其 pdf.js 文档后从 store 摘除；
   * 还有其他标签时移交激活位并继续展示，最后一个标签关闭则回到查看器空态。
   * 同时清掉路由上的 ?path（replace），此后从首页重开同一文件仍能触发装载。
   */
  const handleClose = useCallback(() => {
    const id = useDocumentStore.getState().activeTabId;
    if (id) closeTabAndSyncRoute(id, navigate);
  }, [navigate]);

  const [pageInput, setPageInput] = useState(String(currentPage));
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  const goToPage = (raw: string) => {
    const page = Number.parseInt(raw, 10);
    if (Number.isFinite(page)) {
      setCurrentPage(Math.min(Math.max(1, page), Math.max(1, numPages)));
    } else {
      setPageInput(String(currentPage));
    }
  };

  const zoomBy = (factor: number) => setScale(clampScale(scale * factor));

  return (
    <div className="viewer-toolbar" role="toolbar" aria-label="查看器工具栏">
      <div className="toolbar-group">
        <IconButton icon={FolderOpen} label="打开 PDF 文件（Ctrl+O）" onClick={handleOpen} />
        <IconButton icon={FileX} label="关闭文档（Ctrl+W）" disabled={!hasDocument} onClick={handleClose} />
        <IconButton
          icon={LayoutGrid}
          label="组织页面（旋转/删除/重排/提取）"
          disabled={!hasDocument}
          onClick={handleOrganize}
        />
        <IconButton icon={PanelLeft} label="折叠/展开侧栏" onClick={toggleSidebar} />
        {fileName && (
          <span className="viewer-toolbar-file" title={fileName}>
            {fileName}
          </span>
        )}
      </div>
      <div className="toolbar-group">
        <IconButton
          icon={ChevronUp}
          label="上一页"
          disabled={!hasDocument || currentPage <= 1}
          onClick={() => setCurrentPage(currentPage - 1)}
        />
        <span className="page-indicator">
          第{" "}
          <input
            className="page-input"
            type="text"
            inputMode="numeric"
            aria-label="页码"
            value={pageInput}
            disabled={!hasDocument}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={() => goToPage(pageInput)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goToPage(pageInput);
            }}
          />{" "}
          / {Math.max(1, numPages)} 页
        </span>
        <IconButton
          icon={ChevronDown}
          label="下一页"
          disabled={!hasDocument || currentPage >= numPages}
          onClick={() => setCurrentPage(currentPage + 1)}
        />
      </div>
      <div className="toolbar-group">
        <IconButton icon={ZoomOut} label="缩小（Ctrl+-）" disabled={!hasDocument} onClick={() => zoomBy(1 / ZOOM_STEP)} />
        <span className="zoom-value" aria-label="缩放比例">
          {Math.round(scale * 100)}%
        </span>
        <IconButton icon={ZoomIn} label="放大（Ctrl+=）" disabled={!hasDocument} onClick={() => zoomBy(ZOOM_STEP)} />
        <IconButton icon={MoveHorizontal} label="适应宽度" disabled={!hasDocument} onClick={() => requestFitWidth()} />
        <IconButton
          icon={Search}
          label={searchPanelOpen ? "收起搜索面板（Ctrl+F）" : "全文搜索（Ctrl+F）"}
          disabled={!hasDocument}
          aria-pressed={searchPanelOpen}
          onClick={toggleSearchPanel}
        />
        <IconButton
          icon={Contrast}
          label={canvasInvert ? "关闭画布反色" : "开启画布反色（深色阅读，默认关）"}
          aria-pressed={canvasInvert}
          onClick={toggleCanvasInvert}
        />
        <IconButton
          icon={Maximize2}
          label={immersive ? "退出沉浸模式（Esc）" : "进入沉浸模式（Ctrl+I）"}
          aria-pressed={immersive}
          onClick={toggleImmersive}
        />
        <IconButton icon={Keyboard} label="快捷键说明" aria-pressed={helpOpen} onClick={() => setHelpOpen((v) => !v)} />
      </div>
      {helpOpen && (
        <div className="hotkey-overlay" style={OVERLAY_STYLE} onClick={() => setHelpOpen(false)}>
          <section
            role="dialog"
            aria-label="快捷键说明"
            style={SHEET_STYLE}
            onClick={(event) => event.stopPropagation()}
          >
            <header
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}
            >
              <strong>快捷键说明</strong>
              <IconButton icon={X} label="关闭快捷键说明" onClick={() => setHelpOpen(false)} />
            </header>
            <ul style={HOTKEY_LIST_STYLE}>
              {HOTKEY_LIST.map((entry) => (
                <li key={entry.combo} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                  <span style={{ color: "var(--text-secondary)" }}>{entry.label}</span>
                  <kbd
                    style={{
                      flex: "none",
                      padding: "1px 6px",
                      fontSize: 12,
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--bg-subtle)",
                      color: "var(--text-primary)",
                    }}
                  >
                    {entry.combo}
                  </kbd>
                </li>
              ))}
            </ul>
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              焦点在输入框时快捷键不触发；Ctrl 亦可用 ⌘；Ctrl+W 在浏览器预览里是浏览器保留键，
              仅在应用窗口内生效。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
