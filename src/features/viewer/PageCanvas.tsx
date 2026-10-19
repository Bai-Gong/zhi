// 单页渲染：画布 + 文本层（技术方案 5.2）。
// 一切 pdf.js 绘制经 core 的 renderQueue / renderTextLayer 派发（4.3 规则 1，
// 本模块零 pdfjs-dist import，与缩略图共用同一条串行队列）：
// - 画布物理分辨率（viewport × devicePixelRatio）与 8192 单边光栅封顶由队列统一计算，
//   排版占位框由 ViewerPage 用同源 capScaleForRaster 定尺寸，保证占位与画面一致；
// - 文本层用 painted.geometry.cssScale 构建，与画布同一 viewport 语义（5.2 第 8 条）；
// - 卸载/缩放变化时取消排队任务与文本层，并对页代理执行 cleanup 回收 pdf.js
//   内部资源（风险表第 4 条；渲染进行中 cleanup 由 pdf.js 内部挂起，安全）；
// - 文档切换的竞态由队列的 store 代际令牌防护（5.2 第 6 条），本组件无需自理。
import { useEffect, useRef } from "react";
import {
  getPage,
  renderQueue,
  renderTextLayer,
  RENDER_PRIORITY,
  type RenderHandle,
  type TextLayerHandle,
} from "../../core/document";

interface PageCanvasProps {
  /** 1 起的页码。 */
  pageNumber: number;
  /** CSS 缩放（store.scale）。 */
  scale: number;
  /** 调度优先级输入：距当前页的距离，越小越先渲染（取挂载时刻的值）。 */
  distance: number;
}

export function PageCanvas({ pageNumber, scale, distance }: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  // 渲染生命周期：挂载或缩放变化时（重新）渲染；卸载/变化前取消旧任务并回收页资源。
  // distance 只影响入队优先级：翻页滚动中不重排/取消已入队任务，避免滚动风暴下反复重启。
  useEffect(() => {
    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!canvas || !textLayerDiv) return;

    // 先把上一代画布的固定尺寸交还给占位框（回落 CSS 100% 拉伸），
    // 队列重绘完成前旧位图继续铺满占位框——缩放即时反馈且无白屏闪烁。
    canvas.style.width = "";
    canvas.style.height = "";

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

    return () => {
      handle.cancel();
      textLayer?.cancel();
      // 离屏/卸载：回收该页在 pdf.js 内部的缓存资源。
      void getPage(pageNumber)
        .then((page) => {
          page.cleanup();
        })
        .catch(() => {
          /* 文档已销毁：忽略 */
        });
    };
  }, [pageNumber, scale]);

  return (
    <>
      <canvas ref={canvasRef} className="viewer-page-canvas" aria-hidden />
      <div ref={textLayerRef} className="viewer-text-layer" />
    </>
  );
}
