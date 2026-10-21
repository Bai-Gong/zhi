// 单页渲染：画布 + 文本层 + 高亮覆盖层与选区联动（技术方案 5.2 / M2-计划 D5）。
// 一切 pdf.js 绘制经 core 的 renderQueue / renderTextLayer 派发（4.3 规则 1，
// 本模块零 pdfjs-dist import，与缩略图共用同一条串行队列）：
// - 画布物理分辨率（viewport × devicePixelRatio）与 8192 单边光栅封顶由队列统一计算，
//   排版占位框由 ViewerPage 用同源 capScaleForRaster 定尺寸，保证占位与画面一致；
// - 文本层用 painted.geometry.cssScale 构建，与画布同一 viewport 语义（5.2 第 8 条）；
// - 高亮覆盖层与选区换算用**同一个 cssScale**（本组件按同源 capScaleForRaster 从
//   store 页尺寸同步算出，与队列落笔一致）+ core.getPage 取回的 scale=1 基准 viewport
//   变换：缩放、y 翻转、页面旋转一次换算到位，杜绝三层错位（风险 6 同源原则）；
// - 卸载/缩放变化时取消排队任务与文本层；页代理的 cleanup 只在页卸载/换页/
//   会话失效时执行（风险表第 4 条；渲染进行中 cleanup 由 pdf.js 内部挂起，安全）。
//   缩放变化**不**回收页资源——pdf.js 页内算子表/字体跨档位保持热缓存，重绘
//   不必重新解析，缩短缩放后的重渲染窗口（M2 闪屏修复的一环）；
// - 文档切换的竞态由队列的 store 代际令牌防护（5.2 第 6 条），本组件无需自理。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getPage,
  renderQueue,
  renderTextLayer,
  RENDER_PRIORITY,
  capScaleForRaster,
  useDocumentStore,
  activeTabOf,
  type RenderHandle,
  type TextLayerHandle,
} from "../../core/document";
import {
  HighlightOverlay,
  HighlightSaveButton,
  cssPxRectToUserSpace,
  userRectToLayerRect,
  type LayerRect,
  type ViewportTransform,
} from "./highlightLayer";
import { SelectionBar } from "./selectionBar";

interface PageCanvasProps {
  /** 1 起的页码。 */
  pageNumber: number;
  /** CSS 缩放（store.scale）。 */
  scale: number;
  /** 调度优先级输入：距当前页的距离，越小越先渲染（取挂载时刻的值）。 */
  distance: number;
}

/** 选区行块合并：同一视觉行内左右相邻/重叠的碎片联合成一个矩形（pdf.js 每行可能
 * 产出多个 span 碎块），并换算为页内坐标（相对文本层左上角）。排序后只需与前一
 * 矩形比较；返回值首元素即操作条的锚定矩形（最上一行最左块）。 */
function mergeLineFragments(rects: DOMRect[], layerBox: DOMRect): LayerRect[] {
  const local = rects
    .map((r) => ({ left: r.left - layerBox.left, top: r.top - layerBox.top, width: r.width, height: r.height }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: LayerRect[] = [];
  for (const rect of local) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      Math.abs(prev.top - rect.top) <= 2 && // 同一行：上下沿几乎共线
      Math.abs(prev.top + prev.height - rect.top - rect.height) <= 2 &&
      rect.left - (prev.left + prev.width) <= 3 // 左右相邻或交叠（间隙 ≤3px）
    ) {
      const right = Math.max(prev.left + prev.width, rect.left + rect.width);
      prev.width = right - prev.left;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

export function PageCanvas({ pageNumber, scale, distance }: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  // ===== 高亮/选区所需的会话字段（窄选择器：引用稳定，不随翻页等无关更新重渲染） =====
  const tabHighlights = useDocumentStore((s) => activeTabOf(s).highlights);
  const pageSize = useDocumentStore((s) => activeTabOf(s).pageSizes[pageNumber - 1]);
  const isCurrentPage = useDocumentStore((s) => activeTabOf(s).currentPage === pageNumber);
  const loadGeneration = useDocumentStore((s) => activeTabOf(s).loadGeneration);

  const pageHighlights = useMemo(
    () => tabHighlights.filter((h) => h.pageNumber === pageNumber),
    [tabHighlights, pageNumber],
  );

  // 与画布/占位框同源的封顶缩放：renderQueue 对同一 (页尺寸, scale) 算的正是这个值。
  const cssScale = pageSize ? capScaleForRaster(pageSize.width, pageSize.height, scale) : scale;
  const pageWidth = pageSize ? Math.floor(pageSize.width * cssScale) : undefined;

  // scale=1 基准 viewport 变换：取回后任意缩放同步换算（见 highlightLayer 的换算注释）。
  // 标签重开（loadGeneration 变化）后页对象可能失效，一并重取。
  const [transform, setTransform] = useState<ViewportTransform | null>(null);
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
        /* 无文档会话等：覆盖层暂不渲染（transform 保持 null） */
      });
    return () => {
      stale = true;
    };
  }, [pageNumber, loadGeneration]);

  // ===== 选区/选中高亮的本页状态（两态互斥；随页卸载自然丢弃） =====
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  /** 待建高亮的选区（页内 px 行块；锚点取首个行块）。 */
  const [pending, setPending] = useState<{ anchor: LayerRect; rects: LayerRect[] } | null>(null);
  const [selectedHighlightId, setSelectedHighlightId] = useState<string | null>(null);

  // 文本选区 → 浮动操作条：document 级 pointerup（拖选终点可能落在别的页），
  // 归属判定 = 选区锚点在本页文本层；跨页拖选只由锚点页处理，行块裁到本页范围。
  useEffect(() => {
    const onPointerUp = () => {
      const textLayerDiv = textLayerRef.current;
      const selection = window.getSelection();
      if (!textLayerDiv || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const { anchorNode } = selection;
      if (!anchorNode || !textLayerDiv.contains(anchorNode)) return;
      const range = selection.getRangeAt(0);
      const layerBox = textLayerDiv.getBoundingClientRect();
      const fragments = Array.from(range.getClientRects()).filter(
        (r) =>
          r.width >= 1 &&
          r.height >= 1 &&
          r.bottom > layerBox.top &&
          r.top < layerBox.bottom &&
          r.right > layerBox.left &&
          r.left < layerBox.right,
      );
      if (fragments.length === 0) return;
      const rects = mergeLineFragments(fragments, layerBox);
      setSelectedHighlightId(null);
      setPending({ anchor: rects[0], rects });
    };
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  }, []);

  // 捕获阶段：点击落在本页高亮矩形/操作条之外（含其他页、空白处）即收起两态。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (overlayRef.current?.contains(target) || barRef.current?.contains(target)) return;
      setSelectedHighlightId(null);
      setPending(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // Esc：收起两态并清空原生选区。
  useEffect(() => {
    if (!pending && !selectedHighlightId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      window.getSelection()?.removeAllRanges();
      setPending(null);
      setSelectedHighlightId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending, selectedHighlightId]);

  /** 新建：选区行块 → 用户空间矩形组（D5 中间层）入 store，成功后清选区收条。 */
  const createHighlight = (color: string) => {
    if (!pending || !transform) return;
    const rects = pending.rects
      .map((r) => cssPxRectToUserSpace(r, transform, cssScale))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rects.length === 0) return;
    const created = useDocumentStore.getState().addHighlight({ pageNumber, rects, color });
    if (created) {
      window.getSelection()?.removeAllRanges();
      setPending(null);
    }
  };

  const selectedHighlight = useMemo(
    () => (selectedHighlightId ? (pageHighlights.find((h) => h.id === selectedHighlightId) ?? null) : null),
    [selectedHighlightId, pageHighlights],
  );
  /** 编辑态操作条锚点：所选高亮首个矩形的页内投影。 */
  const editAnchor = useMemo(() => {
    if (!selectedHighlight || !transform || selectedHighlight.rects.length === 0) return null;
    return userRectToLayerRect(selectedHighlight.rects[0], transform, cssScale);
  }, [selectedHighlight, transform, cssScale]);

  // 渲染生命周期：挂载或缩放变化时（重新）渲染；卸载/变化前取消旧任务。
  // distance 只影响入队优先级：翻页滚动中不重排/取消已入队任务，避免滚动风暴下反复重启。
  // ===== 缩放提交帧：同步交还画布固定尺寸（useLayoutEffect，先于浏览器绘制） =====
  // 页项占位框的内联宽高随 scale 在同一个 commit 里更新，而画布还带着队列上一代
  // 写入的固定 px 内联尺寸；若等被动效应（useEffect）再清，React 19 不保证与
  // commit 同帧，浏览器可能在间隙合成一帧「占位已变、画布仍旧尺寸」——放大
  // 露白边、缩小溢出到相邻页。layout effect 内清掉内联尺寸，画布立刻回落
  // CSS 100% 拉伸铺满新占位框，旧位图作为中间态可见（无空白、无错位帧）。
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.width = "";
    canvas.style.height = "";
  }, [pageNumber, scale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return;

    // 当前页 = 可视级；其余按距离递增的预取级（均优先于侧栏缩略图）。
    const priority =
      distance === 0 ? RENDER_PRIORITY.visible : RENDER_PRIORITY.prefetch + distance;
    const handle: RenderHandle = renderQueue.renderPage({ pageNumber, canvas, scale, priority });
    let textLayer: TextLayerHandle | null = null;

    void handle.done.then((outcome) => {
      if (outcome.status === "painted") {
        // 文本层与画布同 viewport：cssScale 必须用队列封顶后的实际值，勿自行重算。
        textLayer = renderTextLayer({
          pageNumber,
          container: textLayerDiv,
          cssScale: outcome.geometry.cssScale,
        });
        void textLayer.done.catch((error: unknown) => {
          console.warn(`第 ${pageNumber} 页文本层构建失败：`, error);
        });
      } else if (outcome.status === "failed") {
        console.warn(`第 ${pageNumber} 页渲染失败：`, outcome.error);
      }
    });

    // 只取消任务，不回收页资源：scale 变化触发的清理若顺手 page.cleanup()，
    // 会丢掉 pdf.js 页内算子表/字体缓存，每次缩放档位变化都整页重新解析，
    // 确定性拉长重绘窗口（M2 闪屏根因之一）。回收职责在下方独立效应。
    return () => {
      handle.cancel();
      textLayer?.cancel();
    };
  }, [pageNumber, scale]);

  // ===== 页资源回收（风险表第 4 条）：只在页卸载/换页/标签重开会话失效时执行 =====
  // 依赖刻意不含 scale。ownedDoc 用**本效应建立时**本标签的文档引用：本组件只随
  // 激活标签挂载（滚动舞台 key=activeTabId），而 core 的 getPage 在卸载清理瞬间
  // 读的是「激活标签」——切标签时激活位已移交新标签，会把 cleanup 打到新标签的
  // 同页页代理上（本标签渲染过的页反而没人清，只能等关标签兜底销毁）。
  useEffect(() => {
    const ownedDoc = activeTabOf(useDocumentStore.getState()).document;
    if (!ownedDoc) return;
    return () => {
      void ownedDoc
        .getPage(pageNumber)
        .then((page) => {
          page.cleanup();
        })
        .catch(() => {
          /* 文档已销毁：忽略 */
        });
    };
  }, [pageNumber, loadGeneration]);

  return (
    <>
      <canvas ref={canvasRef} className="viewer-page-canvas" aria-hidden />
      <div ref={textLayerRef} className="viewer-text-layer" />
      <HighlightOverlay
        layerRef={overlayRef}
        highlights={pageHighlights}
        transform={transform}
        cssScale={cssScale}
        selectedId={selectedHighlightId}
        onHighlightClick={(id) => {
          setPending(null);
          setSelectedHighlightId(id);
        }}
      />
      {pending && transform && (
        <SelectionBar
          ref={barRef}
          mode="create"
          anchor={pending.anchor}
          pageWidth={pageWidth}
          onPickColor={createHighlight}
          onDismiss={() => {
            window.getSelection()?.removeAllRanges();
            setPending(null);
          }}
        />
      )}
      {selectedHighlight && editAnchor && (
        <SelectionBar
          ref={barRef}
          mode="edit"
          anchor={editAnchor}
          pageWidth={pageWidth}
          currentColor={selectedHighlight.color}
          onPickColor={(color) => useDocumentStore.getState().setHighlightColor(selectedHighlight.id, color)}
          onDelete={() => {
            useDocumentStore.getState().removeHighlight(selectedHighlight.id);
            setSelectedHighlightId(null);
          }}
          onDismiss={() => setSelectedHighlightId(null)}
        />
      )}
      {/* 「另存副本」浮动条固定在窗口右下角，只由「当前页」的画布挂载 → 全局恰一份。
          （当前页必在虚拟化挂载集合内；滚动跨页时在页间换实例，固定定位视觉不跳。） */}
      {isCurrentPage && <HighlightSaveButton />}
    </>
  );
}
