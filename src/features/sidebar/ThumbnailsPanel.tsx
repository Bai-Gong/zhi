import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useDocumentStore } from "../../core/document/store";
import { renderQueue, type RenderHandle } from "../../core/document/renderQueue";

/**
 * 缩略图页签（技术方案模块 4 / 里程碑 M1-8）：
 * - 懒渲染：IntersectionObserver 报告进入渲染边距才发起绘制，每轮可见性只发起一次，
 *   文档切换（loadGeneration 变化）后重新按可见性发起；
 * - 离屏回收：滚出回收边距（比渲染边距更宽，留滞回带防边界抖动）的缩略图
 *   立即释放画布位图并复位状态，再次滚回时重绘——大文档下内存不随翻阅单调膨胀；
 * - 绘制一律经 core 的 renderQueue.renderThumbnail（4.3 规则 1「缩略图与
 *   整页渲染同源」，本模块不实现渲染），结算以 handle.done 为准；
 * - 点击跳页：写 store.currentPage，由查看器订阅并滚动到目标页；
 * - 当前页高亮：跟随 store.currentPage（查看器滚动时同步），并自动滚入可视区。
 */

/** 缩略图内容宽度（px）。侧栏内容区约 216px，留出页码标签与内边距。 */
const THUMB_WIDTH = 176;
/** 渲染边距：进入该范围即绘制。 */
const RENDER_ROOT_MARGIN = "400px 0px";
/** 回收边距：滚出该范围才释放位图（与渲染边距之间的带内画面保留，防抖动）。 */
const RECYCLE_ROOT_MARGIN = "1200px 0px";
/** pageSizes 缺失时的默认占位高宽比（高/宽，A4 纵向近似）。 */
const DEFAULT_ASPECT = Math.SQRT2;

type ThumbPhase = "rendered" | "failed";

export function ThumbnailsPanel() {
  const status = useDocumentStore((s) => s.status);
  const numPages = useDocumentStore((s) => s.numPages);
  const pageSizes = useDocumentStore((s) => s.pageSizes);
  const currentPage = useDocumentStore((s) => s.currentPage);
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const loadGeneration = useDocumentStore((s) => s.loadGeneration);

  /** page → 绘制结果（undefined = 尚未绘制/已被回收）。 */
  const [phases, setPhases] = useState<Readonly<Record<number, ThumbPhase>>>({});

  const itemRefs = useRef(new Map<number, HTMLElement>());
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  /** 当前可见性轮次中已发起过绘制的页（回收或文档切换时移除，允许重绘）。 */
  const startedRef = useRef(new Set<number>());
  const inFlightRef = useRef(new Map<number, RenderHandle>());
  const renderObserverRef = useRef<IntersectionObserver | null>(null);
  const recycleObserverRef = useRef<IntersectionObserver | null>(null);
  /** 每页稳定的元素挂载回调缓存（避免每次渲染重建 ref 造成反复解绑）。 */
  const attachCacheRef = useRef(new Map<number, (el: HTMLElement | null) => void>());

  /** 释放一页缩略图占用的位图与状态（滚出回收边距时调用）。 */
  const recycle = useCallback((page: number) => {
    inFlightRef.current.get(page)?.cancel();
    inFlightRef.current.delete(page);
    startedRef.current.delete(page);
    const canvas = canvasRefs.current.get(page);
    if (canvas) {
      // 归零画布尺寸释放位图后备存储；重绘时由渲染队列重新设定。
      canvas.width = 0;
      canvas.height = 0;
    }
    setPhases((prev) => {
      if (!(page in prev)) return prev;
      const next = { ...prev };
      delete next[page];
      return next;
    });
  }, []);

  /** 懒渲染入口：观察者命中时调用；渲染只经 core 的缩略图接口。 */
  const startRender = useCallback(async (page: number) => {
    const canvas = canvasRefs.current.get(page);
    if (!canvas || startedRef.current.has(page)) return;
    startedRef.current.add(page);
    const sizes = useDocumentStore.getState().pageSizes;
    const size = sizes[page - 1];
    const aspect = size && size.width > 0 ? size.height / size.width : DEFAULT_ASPECT;
    // renderThumbnail 按最长边适配：Portrait 时最长边是高，放大 maxEdge 使宽度落到 THUMB_WIDTH。
    const handle = renderQueue.renderThumbnail({
      pageNumber: page,
      canvas,
      maxEdge: Math.round(THUMB_WIDTH * Math.max(1, aspect)),
    });
    inFlightRef.current.set(page, handle);
    const outcome = await handle.done;
    // 结算前该页可能已被回收/取代（回收会从表中移除句柄）：迟到结果作废。
    if (inFlightRef.current.get(page) !== handle) return;
    if (outcome.status === "painted") {
      setPhases((prev) => ({ ...prev, [page]: "rendered" }));
    } else if (outcome.status === "failed") {
      setPhases((prev) => ({ ...prev, [page]: "failed" }));
    }
    // cancelled（文档切换/被取代）：保留页码占位，待新一轮可见性触发。
  }, []);

  /** 项挂载即登记元素并纳入懒渲染/回收双观察（观察者惰性创建，避免与 effect 顺序耦合）。 */
  const attachItem = useCallback(
    (page: number) => {
      let attach = attachCacheRef.current.get(page);
      if (!attach) {
        attach = (el: HTMLElement | null) => {
          if (!el) {
            itemRefs.current.delete(page);
            return;
          }
          itemRefs.current.set(page, el);
          if (!renderObserverRef.current || !recycleObserverRef.current) {
            renderObserverRef.current = new IntersectionObserver(
              (entries) => {
                for (const entry of entries) {
                  if (!entry.isIntersecting) continue;
                  const page = Number((entry.target as HTMLElement).dataset.page);
                  if (Number.isFinite(page)) void startRender(page);
                }
              },
              { root: null, rootMargin: RENDER_ROOT_MARGIN },
            );
            recycleObserverRef.current = new IntersectionObserver(
              (entries) => {
                for (const entry of entries) {
                  if (entry.isIntersecting) continue;
                  const page = Number((entry.target as HTMLElement).dataset.page);
                  if (Number.isFinite(page)) recycle(page);
                }
              },
              { root: null, rootMargin: RECYCLE_ROOT_MARGIN },
            );
          }
          renderObserverRef.current.observe(el);
          recycleObserverRef.current?.observe(el);
        };
        attachCacheRef.current.set(page, attach);
      }
      return attach;
    },
    [startRender, recycle],
  );

  // 文档切换（loadGeneration 递增）：复位绘制状态，取消在途任务并释放全部位图，
  // 再对已登记元素重开一轮可见性观察（observe 会补发一次当前状态回调）。
  useEffect(() => {
    startedRef.current.clear();
    for (const handle of inFlightRef.current.values()) handle.cancel();
    inFlightRef.current.clear();
    setPhases({});
    for (const canvas of canvasRefs.current.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
    const renderObserver = renderObserverRef.current;
    const recycleObserver = recycleObserverRef.current;
    if (renderObserver && recycleObserver) {
      renderObserver.disconnect();
      recycleObserver.disconnect();
      for (const el of itemRefs.current.values()) {
        renderObserver.observe(el);
        recycleObserver.observe(el);
      }
    }
  }, [loadGeneration]);

  // 卸载：取消在途绘制并断开观察（StrictMode 双挂载亦走到这里，重挂后逐项重新观察）。
  useEffect(() => {
    return () => {
      renderObserverRef.current?.disconnect();
      renderObserverRef.current = null;
      recycleObserverRef.current?.disconnect();
      recycleObserverRef.current = null;
      for (const handle of inFlightRef.current.values()) handle.cancel();
      inFlightRef.current.clear();
    };
  }, []);

  // 当前页高亮跟随（查看器滚动 → store.currentPage）：把高亮项滚入侧栏可视区。
  useEffect(() => {
    itemRefs.current.get(currentPage)?.scrollIntoView({ block: "nearest" });
  }, [currentPage]);

  if (status !== "ready") {
    return <p className="sidebar-empty">打开文档后可在此查看缩略图。</p>;
  }
  if (numPages <= 0) {
    return <p className="sidebar-empty">本文档没有页面。</p>;
  }

  const aspectOf = (page: number): number => {
    const size = pageSizes[page - 1];
    return size && size.width > 0 ? size.height / size.width : DEFAULT_ASPECT;
  };

  return (
    <div className="thumbnails-panel" aria-label="页面缩略图">
      <p className="sidebar-hint">共 {numPages} 页，点击缩略图跳转。</p>
      <div className="thumbnail-list" role="list">
        {Array.from({ length: numPages }, (_, index) => index + 1).map((page) => {
          const phase = phases[page];
          const aspect = aspectOf(page);
          return (
            <div
              key={page}
              role="listitem"
              className={clsx("thumbnail-item", { active: page === currentPage })}
              data-page={page}
              ref={attachItem(page)}
            >
              <button
                type="button"
                className="thumbnail-jump"
                title={`跳到第 ${page} 页`}
                aria-label={`跳到第 ${page} 页`}
                aria-current={page === currentPage ? "true" : undefined}
                onClick={() => setCurrentPage(page)}
              >
                <span className="thumbnail-canvas-wrap" style={{ aspectRatio: String(1 / aspect) }}>
                  <canvas
                    ref={(el) => {
                      if (el) canvasRefs.current.set(page, el);
                      else canvasRefs.current.delete(page);
                    }}
                    className={clsx("thumbnail-canvas", { hidden: phase !== "rendered" })}
                  />
                  {phase !== "rendered" && (
                    <span className="thumbnail-fallback" aria-hidden>
                      {page}
                    </span>
                  )}
                </span>
                <span className="thumbnail-label">第 {page} 页</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
