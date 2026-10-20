// 查看器顶部上下文工具栏（模块 3）：打开文件、侧栏开关、文件名、翻页与页码跳转、缩放与适应宽度、
// 阅读模式（沉浸）与深色阅读（反转画布底色）。
// 页码变化统一走 store.currentPage，由 ViewerPage 的滚动联动消费（按钮/页码输入/侧栏同一通道）；
// 「适应宽度」需要滚动容器与页面尺寸，真实计算经 scrollBridge 由 ViewerPage 注册执行；
// 快捷键（含 Ctrl+F 打开搜索）统一由 shortcuts.ts 的 window 分发器处理，工具栏只保留按钮入口。
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  Contrast,
  ChevronDown,
  ChevronUp,
  FileX,
  FolderOpen,
  MoveHorizontal,
  PanelLeft,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { closeDocument, openDocument, pickPdfFile } from "../../core/document/openDocument";
import { useDocumentStore } from "../../core/document/store";
import { buildViewerUrl } from "../../shell/routes";
import { escapeFromEditable, useUiStore } from "../../shell/uiStore";
import { clampScale, ZOOM_STEP } from "./pageGeometry";
import { openSearchPanel } from "./shortcuts";
import { clearAutoFit, requestFitWidth } from "./scrollBridge";

export function ViewerToolbar() {
  const navigate = useNavigate();
  const numPages = useDocumentStore((s) => s.numPages);
  const currentPage = useDocumentStore((s) => s.currentPage);
  const scale = useDocumentStore((s) => s.scale);
  const fileName = useDocumentStore((s) => s.fileName);
  const sourcePath = useDocumentStore((s) => s.sourcePath);
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const setScale = useDocumentStore((s) => s.setScale);

  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const immersiveMode = useUiStore((s) => s.immersiveMode);
  const toggleImmersive = useUiStore((s) => s.toggleImmersive);
  const invertCanvas = useUiStore((s) => s.invertCanvas);
  const toggleInvertCanvas = useUiStore((s) => s.toggleInvertCanvas);

  const hasDocument = numPages > 0;

  /** 查看器内「打开」（技术方案 5.1）：对话框选文件后改写路由查询参数触发重开。 */
  const handleOpen = useCallback(async () => {
    let path: string | null;
    try {
      path = await pickPdfFile(); // 用户取消返回 null；对话框异常在这里吸收（装载错误走 store 错误态）
    } catch (error) {
      console.warn("打开文件对话框调用失败：", error);
      return;
    }
    if (!path) return;
    if (path === sourcePath) {
      void openDocument(path); // 同一路径不改变查询参数，直接重开刷新会话
    } else {
      navigate(buildViewerUrl(path));
    }
  }, [navigate, sourcePath]);

  /**
   * 关闭当前文档：释放 pdf.js 会话与渲染资源，回到查看器空态。
   * 同时清掉路由上的 ?path，此后从首页重开同一文件仍能触发装载。
   */
  const handleClose = useCallback(() => {
    void closeDocument();
    navigate(buildViewerUrl(), { replace: true });
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

  /** 手动缩放：先退出「适应宽度」自动重适配（scrollBridge 的 autoFit 来源标志）。 */
  const zoomBy = (factor: number) => {
    clearAutoFit();
    setScale(clampScale(scale * factor));
  };

  return (
    <div className="viewer-toolbar" role="toolbar" aria-label="查看器工具栏">
      <div className="toolbar-group">
        <IconButton icon={FolderOpen} label="打开 PDF 文件（Ctrl+O）" onClick={() => void handleOpen()} />
        <IconButton icon={FileX} label="关闭文档（Ctrl+W）" disabled={!hasDocument} onClick={handleClose} />
        <IconButton icon={PanelLeft} label="折叠/展开侧栏" onClick={toggleSidebar} />
        <IconButton icon={Search} label="搜索全文（Ctrl+F）" disabled={!hasDocument} onClick={openSearchPanel} />
        <IconButton
          icon={BookOpen}
          label={immersiveMode ? "退出阅读模式（F11）" : "进入阅读模式（F11）"}
          aria-pressed={immersiveMode}
          onClick={toggleImmersive}
        />
        <IconButton
          icon={Contrast}
          label={
            invertCanvas ? "深色阅读：恢复文档底色（Ctrl+Alt+I）" : "深色阅读：反转文档底色（Ctrl+Alt+I）"
          }
          aria-pressed={invertCanvas}
          onClick={toggleInvertCanvas}
        />
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
              // 无可清内容时的 Escape 兜底：交还焦点；沉浸下退出沉浸（逃生通道）。
              if (e.key === "Escape") escapeFromEditable(e.currentTarget);
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
      </div>
    </div>
  );
}
