import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { renderQueue, type RenderHandle } from "../../core/document/renderQueue";
import type { PageSize } from "../../core/document/store";

/**
 * 组织视图页面网格（M3 验收 1/2 的交互层）：
 * - 缩略图渲染一律经 core 的 renderQueue.renderThumbnail（技术方案 4.3 规则 1
 *   「与侧栏同一渲染来源」，本模块不实现渲染）；旋转预览用其 rotation 覆盖参数；
 * - 网格项 key = 源页索引：拖拽重排只是 DOM 移位，canvas 位图随元素走、不重绘，
 *   大文档重排零渲染开销；
 * - HTML5 拖拽重排：拖单页或整个选中块（拖动块保持相对顺序），按指针在目标卡
 *   左/右半侧决定插前/插后；
 * - 多选：单击 / Ctrl+单击（增减）/ Shift+单击（范围）/ 空白处拖动框选（Ctrl 并集）。
 */

/** 缩略图目标宽度（px）；网格列宽（minmax(200px,1fr)）与之对齐，见 organize.css。 */
const THUMB_WIDTH = 176;
/** pageSizes 缺失时的默认宽高比（A4 纵向近似，高/宽）。 */
const DEFAULT_ASPECT = Math.SQRT2;

/**
 * 源页在「原 /Rotate + 组织增量」合成角下的显示宽高比（高/宽）。
 * 必须按**绝对角**判断翻转（effective % 180）：size 的宽高已按原旋转归一，
 * 若改用增量判断，/Rotate=90 的页再叠加 90° 时会翻错方向（合计 180° 不翻转）。
 */
export function displayAspectOf(size: PageSize | undefined, delta: number): number {
  const normalizedDelta = ((delta % 360) + 360) % 360;
  if (!size || !(size.width > 0) || !(size.height > 0)) {
    return normalizedDelta % 180 !== 0 ? 1 / DEFAULT_ASPECT : DEFAULT_ASPECT;
  }
  const orig = (((size.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  // 反推媒体（未旋转）宽高：size 的宽高是按 orig 归一的显示宽高。
  const mediaW = orig % 180 === 90 ? size.height : size.width;
  const mediaH = orig % 180 === 90 ? size.width : size.height;
  const effective = (orig + normalizedDelta) % 360;
  const swap = effective % 180 === 90;
  const w = swap ? mediaH : mediaW;
  const h = swap ? mediaW : mediaH;
  return h / w;
}
/** 懒渲染边距：进入即绘制；离屏不主动回收（组织视图一次性浏览全页的场景，
 *  滚动幅度有限；重排后 key 移位复用位图，内存口径与侧栏一致的渲染来源）。 */
const RENDER_ROOT_MARGIN = "600px 0px";

export interface DropTarget {
  /** 拖放锚页（源页索引）。 */
  src: number;
  place: "before" | "after";
}

export interface OrganizeGridProps {
  /** 页序：源页索引数组，数组序即当前页序。 */
  order: readonly number[];
  /** 每源页的旋转增量（度）。 */
  rotationDelta: Readonly<Record<number, number>>;
  /** 源页尺寸表（openDocument 装载，下标 = 源页索引）。 */
  pageSizes: readonly PageSize[];
  /** 选中源页索引集合（受控，状态归 OrganizePage）。 */
  selection: ReadonlySet<number>;
  /** 源页基数（未删除前总页数，pageSizes.length 兜底）。 */
  totalSourcePages: number;
  onSelectionChange: (next: ReadonlySet<number>) => void;
  /** 拖放重排：把 sourceIndices 移到 anchor 的 before/after。 */
  onMove: (sourceIndices: number[], anchor: number, place: "before" | "after") => void;
}

/** 单页缩略图：懒渲染 + 旋转变化重绘（渲染只经 core 缩略图服务）。 */
function OrgThumb({ pageNumber, rotation, aspect }: { pageNumber: number; rotation: number | undefined; aspect: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const inFlightRef = useRef<RenderHandle | null>(null);
  const startedRef = useRef(false);
  const [painted, setPainted] = useState(false);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || startedRef.current) return;
    startedRef.current = true;
    // 与侧栏同款：按最长边适配到目标宽度（aspect 为合成角下的显示高/宽）。
    const handle = renderQueue.renderThumbnail({
      pageNumber,
      canvas,
      maxEdge: Math.round(THUMB_WIDTH * Math.max(1, aspect)),
      rotation,
    });
    inFlightRef.current = handle;
    void handle.done.then((outcome) => {
      if (inFlightRef.current !== handle) return;
      setPainted(outcome.status === "painted");
    });
  }, [pageNumber, rotation, aspect]);

  // 可见性观察：进入渲染边距才绘制（一次）。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            paint();
            observer.disconnect();
          }
        }
      },
      { root: null, rootMargin: RENDER_ROOT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [paint]);

  // 旋转变化：作废旧任务、释放位图并重绘（此时必然已在视口内——用户刚点过旋转）。
  useEffect(() => {
    if (!startedRef.current) return; // 初次挂载由可见性观察触发
    inFlightRef.current?.cancel();
    inFlightRef.current = null;
    startedRef.current = false;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    setPainted(false);
    paint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation]);

  // 卸载：取消在途任务并释放位图。
  useEffect(() => {
    return () => {
      inFlightRef.current?.cancel();
      inFlightRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, []);

  return (
    <span className="org-thumb-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className={clsx("org-thumb", { hidden: !painted })} />
      {!painted && (
        <span className="org-thumb-fallback" aria-hidden>
          {pageNumber}
        </span>
      )}
    </span>
  );
}

/** 视口坐标系里的框选矩形。 */
interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function marqueeRect(m: Marquee): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.min(m.x0, m.x1),
    top: Math.min(m.y0, m.y1),
    width: Math.abs(m.x1 - m.x0),
    height: Math.abs(m.y1 - m.y0),
  };
}

export function OrganizeGrid(props: OrganizeGridProps) {
  const { order, rotationDelta, pageSizes, selection, onSelectionChange, onMove, totalSourcePages } = props;

  /** 拖拽中的源页集合（dragstart 记录；同组件内拖放以 ref 为准，dataTransfer 兜底）。 */
  const dragSetRef = useRef<number[] | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  /** Shift 范围选择的锚（最近一次单击的源页索引）。 */
  const clickAnchorRef = useRef<number | null>(null);
  /** 框选矩形层（DOM 直写，不走 React state：mousemove 每帧重渲 500 项网格不划算）。 */
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<number, HTMLElement>());

  const sameDropTarget = (a: DropTarget | null, b: DropTarget | null): boolean =>
    a?.src === b?.src && a?.place === b?.place;

  // ===== 点击选择（单击 / Ctrl / Shift） =====
  const handleItemClick = (src: number, event: MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selection);
      if (next.has(src)) next.delete(src);
      else next.add(src);
      onSelectionChange(next);
    } else if (event.shiftKey && clickAnchorRef.current !== null) {
      const anchorPos = order.indexOf(clickAnchorRef.current);
      const pos = order.indexOf(src);
      if (anchorPos >= 0 && pos >= 0) {
        const [from, to] = anchorPos <= pos ? [anchorPos, pos] : [pos, anchorPos];
        onSelectionChange(new Set(order.slice(from, to + 1)));
      }
    } else {
      onSelectionChange(new Set([src]));
    }
    clickAnchorRef.current = src;
  };

  // ===== HTML5 拖拽重排 =====
  const handleDragStart = (src: number, event: DragEvent) => {
    // 拖动项在选中集内 → 整块移动；否则单页（并把选择重置为该页）。
    const block = selection.has(src)
      ? order.filter((s) => selection.has(s))
      : [src];
    if (!selection.has(src)) onSelectionChange(new Set([src]));
    dragSetRef.current = block;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", JSON.stringify(block)); // WebView2 需有数据才触发
  };

  const handleDragOver = (src: number, event: DragEvent) => {
    if (!dragSetRef.current || dragSetRef.current.includes(src)) return; // 拖回自身块内：无落点
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const place: "before" | "after" = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    setDropTarget((prev) => (sameDropTarget(prev, { src, place }) ? prev : { src, place }));
  };

  const handleDrop = (src: number, event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const block = dragSetRef.current;
    if (block && !block.includes(src)) {
      // 与 dragover 同公式当场计算落点，不依赖异步 state（避免 dragover 未提交的竞态）。
      const rect = event.currentTarget.getBoundingClientRect();
      const place: "before" | "after" = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
      onMove(block, src, place);
    }
    dragSetRef.current = null;
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    dragSetRef.current = null;
    setDropTarget(null);
  };

  // 网格空白处 drop：移到末尾（拖出块外松手的最直觉落点）。
  const handleGridDrop = (event: DragEvent) => {
    const block = dragSetRef.current;
    const last = order[order.length - 1];
    if (block && last !== undefined && !block.includes(last)) {
      event.preventDefault();
      onMove(block, last, "after");
    }
    dragSetRef.current = null;
    setDropTarget(null);
  };

  // ===== 框选（矩形层 DOM 直写；mouseup 一次性结算命中页） =====
  const handleGridMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest(".org-item, button, input, textarea")) return; // 页卡上的按下不框选
    const base = event.ctrlKey || event.metaKey ? new Set(selection) : new Set<number>();
    const start = { x: event.clientX, y: event.clientY };

    const onMove2 = (e: globalThis.MouseEvent) => {
      const el = marqueeRef.current;
      if (!el) return;
      const rect = marqueeRect({ x0: start.x, y0: start.y, x1: e.clientX, y1: e.clientY });
      Object.assign(el.style, rect);
      el.style.display = rect.width > 2 || rect.height > 2 ? "block" : "none";
    };
    const onUp = (e: globalThis.MouseEvent) => {
      window.removeEventListener("mousemove", onMove2);
      window.removeEventListener("mouseup", onUp);
      if (marqueeRef.current) marqueeRef.current.style.display = "none";
      const rect = marqueeRect({ x0: start.x, y0: start.y, x1: e.clientX, y1: e.clientY });
      if (rect.width <= 3 && rect.height <= 3) {
        // 原地单击空白：清空选择。
        onSelectionChange(new Set<number>());
        return;
      }
      const hit = new Set(base);
      for (const [src, el] of itemRefs.current) {
        const r = el.getBoundingClientRect();
        const intersects =
          r.left < rect.left + rect.width &&
          r.right > rect.left &&
          r.top < rect.top + rect.height &&
          r.bottom > rect.top;
        if (intersects) hit.add(src);
        else hit.delete(src); // Ctrl 并集语义：框内添加、框外移除
      }
      onSelectionChange(hit);
    };
    window.addEventListener("mousemove", onMove2);
    window.addEventListener("mouseup", onUp);
  };

  // ===== 渲染 =====
  return (
    <div
      className="organize-grid"
      role="listbox"
      aria-label="页面网格"
      aria-multiselectable
      onMouseDown={handleGridMouseDown}
      onDragOver={(e) => e.preventDefault()} // 允许 drop 冒泡到网格空白
      onDrop={handleGridDrop}
    >
      {order.map((src, pos) => {
        const delta = rotationDelta[src] ?? 0;
        const effective = ((((pageSizes[src]?.rotation ?? 0) + delta) % 360) + 360) % 360;
        const aspect = displayAspectOf(pageSizes[src], delta);
        const selected = selection.has(src);
        return (
          <div
            key={src}
            ref={(el) => {
              if (el) itemRefs.current.set(src, el);
              else itemRefs.current.delete(src);
            }}
            role="option"
            aria-selected={selected}
            className={clsx("org-item", {
              selected,
              "drop-before": dropTarget?.src === src && dropTarget.place === "before",
              "drop-after": dropTarget?.src === src && dropTarget.place === "after",
            })}
            data-src={src}
            draggable
            onClick={(e) => handleItemClick(src, e)}
            onDragStart={(e) => handleDragStart(src, e)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(src, e)}
            onDrop={(e) => handleDrop(src, e)}
          >
            <span className="org-thumb-frame" style={{ aspectRatio: String(1 / aspect) }}>
              <OrgThumb pageNumber={src + 1} rotation={effective || undefined} aspect={aspect} />
            </span>
            <span className="org-label">
              第 {pos + 1} 页
              {src + 1 !== pos + 1 && <span className="org-origin">原 {src + 1}</span>}
            </span>
          </div>
        );
      })}
      {order.length === 0 && (
        <p className="org-empty">所有页面都已删除。可按 Ctrl+Z 撤销，或「另存副本」前先恢复页面。</p>
      )}
      {/* 框选矩形层：fixed 定位视口坐标，几何由 mousemove 直写（见 handleGridMouseDown） */}
      <div className="org-marquee" ref={marqueeRef} aria-hidden style={{ display: "none", position: "fixed" }} />
      <span className="org-grid-meta" aria-hidden>
        共 {order.length} 页 / 原 {totalSourcePages} 页
      </span>
    </div>
  );
}
