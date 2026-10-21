// 基础编辑视图（M5，路由 /edit，独立全屏模式）：工具栏 + 页面滚动区 + 属性面板。
//
// 状态分层：编辑对象/撤销重做栈在 core 的 editStore（按标签+装载代际隔离，
// 导出由 core 的 editExport 消费同一状态）；选中集合与当前页是纯 UI 瞬态留本页。
// 装载复用 core 的 openDocument：同路径标签已就绪时不重载（从查看器进入零开销）。
// 页面渲染一律经 core 的 renderQueue（PageEditor 消费，4.3 规则 1，不复制实现）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { ArrowLeft, ImagePlus, Redo2, Type, Undo2, X } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import {
  activeTabOf,
  makeEditObjectId,
  openDocument,
  pickPdfFile,
  useDocumentStore,
  useEditStore,
  type EditObject,
} from "../../core/document";
import { saveEditedCopy } from "../../core/document/editExport";
import { buildViewerUrl } from "../../shell/routes";
import { PageEditor } from "./PageEditor";
import { PropertiesPanel } from "./PropertiesPanel";
import "./edit.css";

/** toast 自动消失时长（ms）。 */
const TOAST_MS = 5000;
/** 插入图片的初始宽度占页宽比例。 */
const INSERT_IMAGE_WIDTH_RATIO = 0.4;
/** 插入文本补丁的初始遮盖尺寸（pt）。 */
const INSERT_TEXT_COVER = { width: 220, height: 28 };
/** 滚动区两侧留白（px，含滚动条）。 */
const SCROLLER_PADDING = 64;

/** 无对象页共用的稳定空数组（React.memo 挡住无对象页的重渲染）。 */
const EMPTY_OBJECTS: readonly EditObject[] = [];

export function EditPage() {
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

  // 装载：路径参数驱动；同路径标签已就绪则跳过（从查看器进入零重载）。
  useEffect(() => {
    if (!path) return;
    const current = activeTabOf(useDocumentStore.getState());
    if (current.status === "ready" && current.sourcePath === path) return;
    void openDocument(path);
  }, [path]);

  // 编辑会话：就绪后确保存在（文档重开 → 代际不符 → 自动重建，旧对象作废）。
  useEffect(() => {
    if (status !== "ready" || !activeTabId) return;
    useEditStore.getState().ensureSession(activeTabId, loadGeneration);
  }, [status, activeTabId, loadGeneration]);

  const session = useEditStore((s) => (activeTabId ? s.sessions[activeTabId] : undefined));
  const objects = session?.objects ?? EMPTY_OBJECTS;
  const canUndo = (session?.undoStack.length ?? 0) > 0;
  const canRedo = (session?.redoStack.length ?? 0) > 0;

  // ===== UI 瞬态：选中、当前页、缩放、提示 =====
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollerWidth, setScrollerWidth] = useState(0);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  // 撤销/重做/删除可能移除选中对象：对象表里已不存在时清选中。
  useEffect(() => {
    if (selectedId && !objects.some((o) => o.id === selectedId)) setSelectedId(null);
  }, [objects, selectedId]);

  // 缩放：滚动区宽度自适应每页（每页各自适应宽度，页间可不同档）。
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setScrollerWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
    // scroller 随 key（标签/代际）重挂：依赖补齐让观察器跟着重新绑定。
  }, [status, activeTabId, loadGeneration]);

  const selectedObject = useMemo(
    () => (selectedId ? objects.find((o) => o.id === selectedId) ?? null : null),
    [objects, selectedId],
  );

  // 按页分桶（对象数组顺序即叠放层级；无对象页共用稳定空数组）。
  const objectsByPage = useMemo(() => {
    const map = new Map<number, EditObject[]>();
    for (const object of objects) {
      const bucket = map.get(object.pageNumber);
      if (bucket) bucket.push(object);
      else map.set(object.pageNumber, [object]);
    }
    return map;
  }, [objects]);

  // ===== 撤销/重做（验收 M5-4，栈深 50 ≥ 20） =====
  const undo = useCallback(() => {
    if (activeTabId && useEditStore.getState().undo(activeTabId)) showToast("已撤销一步。");
  }, [activeTabId, showToast]);
  const redo = useCallback(() => {
    if (activeTabId && useEditStore.getState().redo(activeTabId)) showToast("已重做一步。");
  }, [activeTabId, showToast]);
  const deleteSelected = useCallback(() => {
    if (!activeTabId || !selectedId) return;
    useEditStore.getState().step(activeTabId, (existing) => existing.filter((o) => o.id !== selectedId));
    setSelectedId(null);
    showToast("已删除选中对象，可按 Ctrl+Z 撤销。");
  }, [activeTabId, selectedId, showToast]);

  // ===== 插入 =====
  const insertText = useCallback(() => {
    if (!activeTabId) return;
    const pageNumber = Math.min(Math.max(1, currentPage), Math.max(1, pageSizes.length));
    const size = pageSizes[pageNumber - 1];
    const width = Math.min(INSERT_TEXT_COVER.width, (size?.width ?? 595) * 0.9);
    const height = INSERT_TEXT_COVER.height;
    const x = ((size?.width ?? 595) - width) / 2;
    const y = ((size?.height ?? 842) - height) / 2;
    const object: EditObject = {
      kind: "text",
      id: makeEditObjectId(),
      pageNumber,
      cover: { x, y, width, height },
      text: "",
      fontSize: 14,
      fontFamily: "helvetica",
      bold: false,
      italic: false,
      color: "#000000",
    };
    useEditStore.getState().step(activeTabId, (existing) => [...existing, object]);
    setSelectedId(object.id);
    showToast("已插入文本框：在右侧输入内容。");
  }, [activeTabId, currentPage, pageSizes, showToast]);

  const insertImage = useCallback(async () => {
    if (!activeTabId) return;
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }],
      });
      if (typeof picked !== "string") return; // 用户取消
      const raw = await readFile(picked);
      const format = (/\.jpe?g$/i.test(picked) ? "jpg" : "png") as "png" | "jpg";
      // 读出原始宽高比（解码失败不阻断：退回 4:3）。
      let ratio = 4 / 3;
      try {
        const bitmap = await createImageBitmap(new Blob([raw], { type: `image/${format}` }));
        ratio = bitmap.width / bitmap.height;
        bitmap.close();
      } catch {
        /* 解码失败按 4:3 放置 */
      }
      const srcId = useEditStore.getState().putImage(activeTabId, raw, format);
      const pageNumber = Math.min(Math.max(1, currentPage), Math.max(1, pageSizes.length));
      const size = pageSizes[pageNumber - 1];
      const width = (size?.width ?? 595) * INSERT_IMAGE_WIDTH_RATIO;
      const height = width / ratio;
      const x = ((size?.width ?? 595) - width) / 2;
      const y = ((size?.height ?? 842) - height) / 2;
      const object: EditObject = { kind: "image", id: makeEditObjectId(), pageNumber, x, y, width, height, srcId };
      useEditStore.getState().step(activeTabId, (existing) => [...existing, object]);
      setSelectedId(object.id);
      showToast("已插入图片：拖动移动，角手柄等比缩放。");
    } catch (error) {
      showToast(`插入图片失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [activeTabId, currentPage, pageSizes, showToast]);

  // ===== 导出（只写用户指定的新文件，原文件不动，验收 M5-5） =====
  const runExport = useCallback(async () => {
    setExporting(true);
    try {
      const result = await saveEditedCopy();
      if (result.status === "saved") {
        showToast(
          result.bitmapTexts > 0
            ? `已保存编辑副本：${result.path}（其中 ${result.bitmapTexts} 处中文文本以高清位图写入，不可再选中复制）。`
            : `已保存编辑副本：${result.path}`,
        );
      } else if (result.status === "failed") {
        showToast(`导出失败：${result.message}`);
      }
      // cancelled：用户关闭对话框，不打扰。
    } finally {
      setExporting(false);
    }
  }, [showToast]);

  // ===== 键盘：Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / Delete / Esc =====
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (ctrl && key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if ((ctrl && key === "y") || (ctrl && key === "z" && event.shiftKey)) {
        event.preventDefault();
        redo();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, deleteSelected, selectedId]);

  const backToViewer = () => navigate(buildViewerUrl(path ?? tab.sourcePath ?? undefined));

  const handleOpenFromEmpty = useCallback(async () => {
    try {
      const picked = await pickPdfFile();
      if (picked) navigate(`?path=${encodeURIComponent(picked)}`, { replace: true });
    } catch (openError) {
      showToast(`打开文件出错：${openError instanceof Error ? openError.message : String(openError)}`);
    }
  }, [navigate, showToast]);

  const fitScaleOf = useCallback(
    (pageNumber: number): number => {
      const size = pageSizes[pageNumber - 1];
      if (!size || !(size.width > 0) || scrollerWidth <= 0) return 1;
      return Math.max(0.1, (scrollerWidth - SCROLLER_PADDING) / size.width);
    },
    [pageSizes, scrollerWidth],
  );

  // PageEditor 的可视页上报（插入对象落在「当前页」；回调引用固定以配合 memo）。
  const handleVisiblePage = useCallback((pageNumber: number) => {
    setCurrentPage((prev) => (prev === pageNumber ? prev : pageNumber));
  }, []);
  const handleObjectCreated = useCallback(() => {
    showToast("已进入文本编辑：在右侧属性面板修改内容与样式。");
  }, [showToast]);

  return (
    <div className="edit-page">
      <div className="edit-toolbar" role="toolbar" aria-label="编辑工具栏">
        <div className="toolbar-group">
          <IconButton icon={ArrowLeft} label="返回查看器" onClick={backToViewer} />
          {fileName && (
            <span className="edit-toolbar-file" title={fileName}>
              {fileName}
            </span>
          )}
        </div>
        <div className="toolbar-group">
          <IconButton icon={Undo2} label="撤销（Ctrl+Z）" disabled={!canUndo || exporting} onClick={undo} />
          <IconButton icon={Redo2} label="重做（Ctrl+Y）" disabled={!canRedo || exporting} onClick={redo} />
        </div>
        <div className="toolbar-group">
          <IconButton icon={Type} label="插入文本框" disabled={status !== "ready" || exporting} onClick={insertText} />
          <IconButton
            icon={ImagePlus}
            label="插入图片（png/jpg）"
            disabled={status !== "ready" || exporting}
            onClick={() => void insertImage()}
          />
        </div>
        <div className="toolbar-group">
          <button
            type="button"
            className="edit-text-button primary"
            disabled={exporting || objects.length === 0}
            onClick={() => void runExport()}
          >
            {exporting ? "正在生成副本…" : "另存编辑副本"}
          </button>
        </div>
        <div className="edit-toolbar-status">
          共 {objects.length} 处编辑{objects.length > 0 ? " · 副本保存前原文件不动" : ""}
        </div>
      </div>

      <div className="edit-body">
        {openRejection && (
          <div className="edit-rejection" role="alert">
            <span>{openRejection}</span>
            <button type="button" className="edit-text-button" onClick={dismissOpenRejection}>
              知道了
            </button>
          </div>
        )}
        {status !== "ready" ? (
          <div className="edit-state">
            {status === "idle" && (
              <div className="edit-state-card">
                <p>尚未打开文档——请从首页「内容编辑」或查看器工具栏进入。</p>
                <button type="button" className="edit-text-button primary" onClick={() => void handleOpenFromEmpty()}>
                  打开 PDF 文件
                </button>
              </div>
            )}
            {status === "loading" && <p>正在装载文档…</p>}
            {status === "error" && (
              <div className="edit-state-card" role="alert">
                <p>打开失败：{error ?? "未知错误"}</p>
                <p className="edit-state-path">{path ?? fileName ?? ""}</p>
                <button type="button" className="edit-text-button primary" onClick={() => void handleOpenFromEmpty()}>
                  重新选择文件
                </button>
              </div>
            )}
          </div>
        ) : (
          <div
            ref={scrollerRef}
            className="edit-scroller"
            key={`${activeTabId ?? "none"}:${loadGeneration}`}
          >
            {pageSizes.map((size, index) => {
              const pageNumber = index + 1;
              return (
                <PageEditor
                  key={pageNumber}
                  tabId={activeTabId!}
                  pageNumber={pageNumber}
                  pageSize={size}
                  scale={fitScaleOf(pageNumber)}
                  objects={objectsByPage.get(pageNumber) ?? EMPTY_OBJECTS}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onObjectCreated={handleObjectCreated}
                  onVisiblePage={handleVisiblePage}
                />
              );
            })}
          </div>
        )}

        <PropertiesPanel
          tabId={activeTabId ?? ""}
          object={selectedObject}
          onDeleted={() => setSelectedId(null)}
          onError={showToast}
        />
      </div>

      {toast && (
        <div className="edit-toast" role="status">
          <span className="edit-toast-text">{toast}</span>
          <button type="button" className="edit-toast-close" aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
