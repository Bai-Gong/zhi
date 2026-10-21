// 编辑视图的单页容器（M5，模块 8）：pdf.js 画布渲染（一律经 core 的 renderQueue，
// 技术方案 4.3 规则 1，与查看器/侧栏同一串行队列）+ 编辑对象覆盖层。
//
// - 可视才渲染：IntersectionObserver 只让进入视口（±1 页余量）的页入队，
//   大文档编辑不因整册入队卡死队列；画布几何与查看器 PageCanvas 同源
//   （capScaleForRaster 封顶、scale=1 基准 transform 取回后同步换算）。
// - 双击进入编辑（验收 M5-1）：双击点 → 用户空间 → core 的 getPageTextItems
//   （复用 M2 文本索引缓存，不重复解析）→ hitTextItem 命中 → 创建文本对象。
// - 点击空白取消选中；对象本身的指针交互归 EditObjectView。
import { memo, useEffect, useRef, useState } from "react";
import {
  capScaleForRaster,
  cssPointToUser,
  getPage,
  getPageTextItems,
  hitTextItem,
  makeEditObjectId,
  renderQueue,
  RENDER_PRIORITY,
  useDocumentStore,
  type EditObject,
  type EditTransform,
  type PageSize,
  type RenderHandle,
} from "../../core/document";
import { useEditStore } from "../../core/document";
import { EditObjectView } from "./EditObjectView";

interface PageEditorProps {
  tabId: string;
  pageNumber: number;
  pageSize: PageSize;
  /** 编辑视图统一缩放（适应宽度档，由 EditPage 计算；此处只做光栅封顶）。 */
  scale: number;
  /** 本页的编辑对象（父组件已按页码过滤）。 */
  objects: readonly EditObject[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 新对象创建后让 EditPage 弹出提示等。 */
  onObjectCreated: (kind: EditObject["kind"]) => void;
  /** 本页进入视口时上报（EditPage 记「当前页」，插入对象落在该页）。 */
  onVisiblePage: (pageNumber: number) => void;
}

export const PageEditor = memo(function PageEditor({
  tabId,
  pageNumber,
  pageSize,
  scale,
  objects,
  selectedId,
  onSelect,
  onObjectCreated,
  onVisiblePage,
}: PageEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [transform, setTransform] = useState<EditTransform | null>(null);
  const loadGeneration = useDocumentStore((s) => s.tabs.find((t) => t.id === tabId)?.loadGeneration ?? 0);

  const cssScale = capScaleForRaster(pageSize.width, pageSize.height, scale);
  const cssWidth = Math.floor(pageSize.width * cssScale);
  const cssHeight = Math.floor(pageSize.height * cssScale);

  // 可视性：进入视口（约 ±1 页余量）才渲染画布，并上报「当前页」。
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setVisible(entry.isIntersecting);
          if (entry.isIntersecting) onVisiblePage(pageNumber);
        }
      },
      { rootMargin: "120% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // onVisiblePage 由父组件 useCallback 固定引用，不随依赖抖动。
  }, [pageNumber, onVisiblePage]);

  // scale=1 基准 viewport 变换（对象层换算的根基，与 PageCanvas 同款手法）。
  useEffect(() => {
    let stale = false;
    setTransform(null);
    getPage(pageNumber)
      .then((page) => {
        if (stale) return;
        const raw = page.getViewport({ scale: 1 }).transform;
        setTransform([raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]]);
      })
      .catch(() => {
        /* 无文档会话等：覆盖层暂不渲染 */
      });
    return () => {
      stale = true;
    };
  }, [pageNumber, loadGeneration]);

  // 画布渲染：可视页入队（visible 档），离屏页不占队列。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!visible) return;
    const handle: RenderHandle = renderQueue.renderPage({
      pageNumber,
      canvas,
      scale,
      priority: RENDER_PRIORITY.visible,
    });
    void handle.done.then((outcome) => {
      if (outcome.status === "failed") console.warn(`第 ${pageNumber} 页渲染失败：`, outcome.error);
    });
    return () => handle.cancel();
  }, [pageNumber, scale, visible, loadGeneration]);

  // 双击：命中页内文本 → 创建文本对象（遮盖 + 原文为初值），选中并联动属性面板。
  const handleDoubleClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    const overlay = overlayRef.current;
    if (!overlay || !transform) return;
    const box = overlay.getBoundingClientRect();
    const css = cssPointToUser(event.clientX - box.left, event.clientY - box.top, transform, cssScale);
    if (!css) return;
    // 双击落在已有对象上时（EditObjectView 已 stopPropagation）不会到这里。
    const items = await getPageTextItems(tabId, pageNumber);
    const hit = items ? hitTextItem(items, css[0], css[1]) : null;
    if (!hit) return;
    const object: EditObject = {
      kind: "text",
      id: makeEditObjectId(),
      pageNumber,
      cover: hit.cover,
      text: hit.text,
      fontSize: hit.fontSize,
      fontFamily: "helvetica",
      bold: false,
      italic: false,
      color: "#000000",
    };
    useEditStore.getState().step(tabId, (existing) => [...existing, object]);
    onSelect(object.id);
    onObjectCreated("text");
  };

  return (
    <div
      ref={pageRef}
      className="edit-page-item"
      data-page={pageNumber}
      style={{ width: cssWidth, height: cssHeight }}
    >
      <canvas ref={canvasRef} className="edit-page-canvas" aria-label={`第 ${pageNumber} 页`} />
      <div
        ref={overlayRef}
        className="edit-overlay"
        onDoubleClick={(event) => void handleDoubleClick(event)}
        onPointerDown={(event) => {
          // 点击空白（非对象、非手柄）取消选中；对象的事件已 stopPropagation。
          if (event.target === overlayRef.current) onSelect(null);
        }}
      >
        {transform &&
          objects.map((object) => (
            <EditObjectView
              key={object.id}
              tabId={tabId}
              object={object}
              transform={transform}
              cssScale={cssScale}
              selected={object.id === selectedId}
              onSelect={onSelect}
              overlayRef={overlayRef}
            />
          ))}
      </div>
      <span className="edit-page-number">{pageNumber}</span>
    </div>
  );
});
