// 页面组织视图（M3，路由 /organize，独立全屏模式）：
// 缩略图网格 + 拖拽重排 + 多选旋转 + 删除（确认/撤销）+ 提取 + 另存副本。
//
// 状态分层：页序/旋转/撤销栈在 core 的 organizeStore（按标签+装载代际隔离，
// 导出由 core 的 pageOrganizeExport 消费同一状态）；选择集合是纯 UI 瞬态留在本页。
// 装载复用 core 的 openDocument：同路径标签已就绪时不重载（从查看器进组织零开销）。
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  RotateCcw,
  RotateCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { activeTabOf, openDocument, pickPdfFile, useDocumentStore, useOrganizeStore } from "../../core/document";
import { extractPagesToNewPdf, saveOrganizedCopy } from "../../core/document/pageOrganizeExport";
import { buildViewerUrl } from "../../shell/routes";
import { OrganizeGrid } from "./OrganizeGrid";
import "./organize.css";

/** toast 自动消失时长（ms）。 */
const TOAST_MS = 4000;

/** 弹层（确认/导出中）样式：内联与 ViewerToolbar 的快捷键弹层同风格（主题变量）。 */
const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgb(0 0 0 / 0.4)",
};

const DIALOG_STYLE: CSSProperties = {
  minWidth: 320,
  maxWidth: 440,
  padding: 16,
  borderRadius: "var(--radius-md)",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  boxShadow: "0 8px 24px rgb(0 0 0 / 0.25)",
};

export function OrganizePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const path = params.get("path");

  const tab = useDocumentStore(activeTabOf);
  const activeTabId = useDocumentStore((s) => s.activeTabId);
  const openRejection = useDocumentStore((s) => s.openRejection);
  const dismissOpenRejection = useDocumentStore((s) => s.dismissOpenRejection);
  const status = tab.status;
  const error = tab.error;
  const fileName = tab.fileName;
  const pageSizes = tab.pageSizes;
  const loadGeneration = tab.loadGeneration;

  // 组织会话：就绪后确保存在（文档重开 → 代际不符 → 自动重建）。
  useEffect(() => {
    if (status !== "ready" || !activeTabId) return;
    useOrganizeStore.getState().ensureSession(activeTabId, loadGeneration, tab.numPages);
  }, [status, activeTabId, loadGeneration, tab.numPages]);

  // 组织快照（页序/旋转/撤销）——订阅本标签的会话。
  const session = useOrganizeStore((s) => (activeTabId ? s.sessions[activeTabId] : undefined));
  const order = session?.order ?? [];
  const rotationDelta = session?.rotationDelta ?? {};
  const canUndo = (session?.undoStack.length ?? 0) > 0;

  // 装载：路径参数驱动；同路径标签已就绪则跳过（从查看器进入零重载）。
  useEffect(() => {
    if (!path) return;
    const current = activeTabOf(useDocumentStore.getState());
    if (current.status === "ready" && current.sourcePath === path) return;
    void openDocument(path);
  }, [path]);

  // ===== 选择（纯 UI 瞬态） =====
  const [selection, setSelection] = useState<ReadonlySet<number>>(() => new Set());
  // 删除后把已不存在的源索引从选择里滤掉。
  useEffect(() => {
    setSelection((prev) => {
      const next = new Set([...prev].filter((src) => order.includes(src)));
      return next.size === prev.size ? prev : next;
    });
  }, [order]);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [exporting, setExporting] = useState<null | "copy" | "extract">(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  // ===== 组织操作（写 core 的 organizeStore） =====
  const undo = useCallback(() => {
    if (!activeTabId) return;
    if (useOrganizeStore.getState().undo(activeTabId)) showToast("已撤销上一步操作。");
  }, [activeTabId, showToast]);

  const rotate = useCallback(
    (delta: 90 | 180 | 270) => {
      if (!activeTabId) return;
      if (selection.size === 0) {
        showToast("请先选择要旋转的页面（点击、Ctrl+点击或框选）。");
        return;
      }
      useOrganizeStore.getState().rotatePages(activeTabId, [...selection], delta);
    },
    [activeTabId, selection, showToast],
  );

  const confirmRemove = useCallback(() => {
    if (!activeTabId || selection.size === 0) return;
    useOrganizeStore.getState().removePages(activeTabId, [...selection]);
    showToast(`已删除 ${selection.size} 页，本次会话内可按 Ctrl+Z 撤销。`);
    setConfirmDelete(false);
    setSelection(new Set());
  }, [activeTabId, selection, showToast]);

  // ===== 导出（只写用户指定的新文件，原文件不动） =====
  const runExport = useCallback(
    async (kind: "copy" | "extract") => {
      setExporting(kind);
      try {
        const result = kind === "copy" ? await saveOrganizedCopy() : await extractPagesToNewPdf([...selection]);
        if (result.status === "saved") showToast(kind === "copy" ? `已保存整理副本：${result.path}` : `已保存提取文件：${result.path}`);
        else if (result.status === "failed") showToast(`导出失败：${result.message}`);
        // cancelled：用户关闭对话框，不打扰。
      } finally {
        setExporting(null);
      }
    },
    [selection, showToast],
  );

  // ===== 键盘：Ctrl+Z 撤销 / Ctrl+A 全选 / Esc 清选 / Delete 删除 =====
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "a") {
        if (order.length === 0) return;
        event.preventDefault();
        setSelection(new Set(order));
        return;
      }
      if (event.key === "Escape") {
        if (confirmDelete) setConfirmDelete(false);
        else setSelection(new Set());
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selection.size > 0) {
        event.preventDefault();
        setConfirmDelete(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, order, selection, confirmDelete]);

  const backToViewer = () => navigate(buildViewerUrl(path ?? tab.sourcePath ?? undefined));

  const handleOpenFromEmpty = useCallback(async () => {
    try {
      const picked = await pickPdfFile();
      if (picked) navigate(`?path=${encodeURIComponent(picked)}`, { replace: true });
    } catch (openError) {
      showToast(`打开文件出错：${openError instanceof Error ? openError.message : String(openError)}`);
    }
  }, [navigate, showToast]);

  const hasSelection = selection.size > 0;

  return (
    <div className="organize-page">
      <div className="organize-toolbar" role="toolbar" aria-label="页面组织工具栏">
        <div className="toolbar-group">
          <IconButton icon={ArrowLeft} label="返回查看器" onClick={backToViewer} />
          {fileName && (
            <span className="org-toolbar-file" title={fileName}>
              {fileName}
            </span>
          )}
        </div>
        <div className="toolbar-group">
          <IconButton icon={Undo2} label="撤销（Ctrl+Z）" disabled={!canUndo || exporting !== null} onClick={undo} />
        </div>
        <div className="toolbar-group">
          <IconButton
            icon={RotateCcw}
            label="向左旋转 90°（所选页）"
            disabled={!hasSelection || exporting !== null}
            onClick={() => rotate(270)}
          />
          <IconButton
            icon={RotateCw}
            label="向右旋转 90°（所选页）"
            disabled={!hasSelection || exporting !== null}
            onClick={() => rotate(90)}
          />
          <button
            type="button"
            className="org-text-button"
            disabled={!hasSelection || exporting !== null}
            onClick={() => rotate(180)}
          >
            旋转 180°
          </button>
          <IconButton
            icon={Trash2}
            label="删除所选页（Delete）"
            className="danger"
            disabled={!hasSelection || exporting !== null}
            onClick={() => setConfirmDelete(true)}
          />
        </div>
        <div className="toolbar-group">
          <button
            type="button"
            className="org-text-button"
            disabled={exporting !== null || order.length === 0}
            onClick={() => void runExport("extract")}
          >
            {exporting === "extract" ? "正在提取…" : hasSelection ? `提取所选 ${selection.size} 页` : "提取全部为新 PDF"}
          </button>
          <button
            type="button"
            className="org-text-button primary"
            disabled={exporting !== null || order.length === 0}
            onClick={() => void runExport("copy")}
          >
            {exporting === "copy" ? "正在保存…" : "另存整理副本"}
          </button>
        </div>
        <div className="org-toolbar-status">
          已选 {selection.size} 页 · 共 {order.length} 页{pageSizes.length !== order.length ? `（原 ${pageSizes.length} 页）` : ""}
        </div>
      </div>

      <div className="organize-body">
        {openRejection && (
          <div className="org-rejection" role="alert">
            <span>{openRejection}</span>
            <button type="button" className="org-text-button" onClick={dismissOpenRejection}>
              知道了
            </button>
          </div>
        )}
        {status !== "ready" ? (
          <div className="org-state">
            {status === "idle" && (
              <div className="org-state-card">
                <p>尚未打开文档——请从首页「页面组织」或查看器工具栏进入。</p>
                <button type="button" className="org-text-button primary" onClick={() => void handleOpenFromEmpty()}>
                  打开 PDF 文件
                </button>
              </div>
            )}
            {status === "loading" && <p>正在装载文档…</p>}
            {status === "error" && (
              <div className="org-state-card" role="alert">
                <p>打开失败：{error ?? "未知错误"}</p>
                <p className="org-state-path">{path ?? fileName ?? ""}</p>
                <button type="button" className="org-text-button primary" onClick={() => void handleOpenFromEmpty()}>
                  重新选择文件
                </button>
              </div>
            )}
          </div>
        ) : (
          <OrganizeGrid
            // key 绑定「标签 + 装载代际」：换标签或文档重开时整网格重挂——缩略图
            // 位图按新文档重建，杜绝跨文档旧画面残留（与查看器滚动舞台同款手法）。
            key={`${activeTabId ?? "none"}:${loadGeneration}`}
            order={order}
            rotationDelta={rotationDelta}
            pageSizes={pageSizes}
            selection={selection}
            totalSourcePages={pageSizes.length}
            onSelectionChange={setSelection}
            onMove={(block, anchor, place) => {
              if (activeTabId) useOrganizeStore.getState().movePages(activeTabId, block, anchor, place);
            }}
          />
        )}
      </div>

      {toast && (
        <div className="org-toast" role="status">
          <span className="org-toast-text">{toast}</span>
          <button type="button" className="org-toast-close" aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      )}

      {confirmDelete && (
        <div
          className="org-confirm-overlay"
          style={OVERLAY_STYLE}
          onClick={() => setConfirmDelete(false)}
        >
          <section
            role="alertdialog"
            aria-label="确认删除页面"
            style={DIALOG_STYLE}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="org-confirm-title">删除所选 {selection.size} 页？</p>
            <p className="org-confirm-hint">删除仅影响导出的副本，原文件不会被修改；本次会话内可按 Ctrl+Z 撤销。</p>
            <div className="org-confirm-actions">
              <button type="button" className="org-text-button" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
              <button type="button" className="org-text-button danger" onClick={confirmRemove}>
                删除
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
