// 文档查看核心（模块 3，路由 /viewer）：pdf.js 连续滚动渲染 + 虚拟化 + 缩放 + 翻页。
//
// 交互契约（技术方案 5.2/5.3）：
// - 连续滚动：页项自上而下堆叠，占位高度 = 基准页尺寸 × 封顶后缩放
//   （capScaleForRaster，与 core 渲染队列落笔同源，8192 封顶时占位与画面不错位）；
// - 页面基准尺寸随文档会话由 openDocument 装载进 store.pageSizes，此处直接消费，
//   不再二次取页（与侧栏缩略图共用同一份尺寸）；
// - 虚拟化：IntersectionObserver（rootMargin ±1 视口，近似可视页 ±1 页）决定挂载
//   PageCanvas 的页，离屏页卸载并回收 pdf.js 资源；
// - 当前页：以「视口顶边所在页」为准（顶部基准 + 4px 容差），写入 store.currentPage；
// - 外部页号（工具栏按钮/页码输入/侧栏缩略图/书签/键盘）一律经 store.currentPage，
//   本页比对 lastReported 消费差异并滚动定位——报告与消费同一通道，天然无回环；
// - 缩放：Ctrl/⌘+滚轮、工具栏按钮、适应宽度均更新 store.scale；变更后按
//   「当前页 + 页内相对位置」锚点补偿滚动（5.3 第 10 条），避免视口跳飞。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import { openDocument } from "../../core/document/openDocument";
import { capScaleForRaster } from "../../core/document/renderQueue";
import { useDocumentStore, type PageSize } from "../../core/document/store";
import { clampScale, ZOOM_STEP } from "./pageGeometry";
import { PageCanvas } from "./PageCanvas";
import { registerFitWidthHandler } from "./scrollBridge";
import { ViewerToolbar } from "./ViewerToolbar";
import "./viewer.css";

/** 滚动内容与视口边的留白（.viewer-pages 的内联 padding，单侧）。 */
const VIEWER_PADDING = 24;
/** 当前页判定容差：视口顶边以下该像素内仍视为上一页贴边。 */
const CURRENT_PAGE_TOLERANCE = 4;

export function ViewerPage() {
  const [params] = useSearchParams();
  const path = params.get("path");

  const status = useDocumentStore((s) => s.status);
  const error = useDocumentStore((s) => s.error);
  const fileName = useDocumentStore((s) => s.fileName);
  const currentPage = useDocumentStore((s) => s.currentPage);
  const scale = useDocumentStore((s) => s.scale);
  const pdfDocument = useDocumentStore((s) => s.document);
  const storePageSizes = useDocumentStore((s) => s.pageSizes);

  useEffect(() => {
    if (path) void openDocument(path);
  }, [path]);

  // ===== 页面基准尺寸（虚拟化占位与适应宽度计算的依据） =====
  // 由 core 的 openDocument 在 ready() 时随会话写入；无会话/装载中为空数组。
  // 残留渲染的取消由 core 统一负责（openDocument/closeDocument 均 renderQueue.clear()）。
  const pageSizes: PageSize[] | null = storePageSizes.length > 0 ? storePageSizes : null;

  // ===== 滚动几何 =====
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** 每页项的 offsetTop（布局提交后重算）。 */
  const offsetsRef = useRef<number[] | null>(null);
  /** 查看器最近报告/消费的页号；0 表示尚未初始化（用于会话页恢复）。 */
  const lastReportedRef = useRef(0);
  /** 缩放锚点：{ 页号, 页内相对位置 }，滚动时持续刷新。 */
  const anchorRef = useRef<{ page: number; ratio: number } | null>(null);
  const rafRef = useRef(0);
  /** 虚拟化：允许挂载 PageCanvas 的页索引集合（可视 ±1 视口）。 */
  const [visibleSet, setVisibleSet] = useState<ReadonlySet<number>>(() => new Set());

  const recomputeOffsets = useCallback(() => {
    const tops: number[] = [];
    for (const item of itemRefs.current) {
      tops.push(item ? item.offsetTop : (tops[tops.length - 1] ?? 0));
    }
    offsetsRef.current = tops;
  }, []);

  const currentPageFromScroll = useCallback((): number => {
    const el = scrollRef.current;
    const tops = offsetsRef.current;
    if (!el || !tops || tops.length === 0) return 0;
    const y = el.scrollTop + CURRENT_PAGE_TOLERANCE;
    let page = 1;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] <= y) page = i + 1;
      else break;
    }
    return page;
  }, []);

  const updateAnchor = useCallback(() => {
    const el = scrollRef.current;
    const tops = offsetsRef.current;
    const page = currentPageFromScroll();
    if (!el || !tops || page === 0) return;
    const top = tops[page - 1] ?? 0;
    const item = itemRefs.current[page - 1];
    const height = Math.max(1, item ? item.offsetHeight : 1);
    const ratio = Math.min(1, Math.max(0, (el.scrollTop - top) / height));
    anchorRef.current = { page, ratio };
  }, [currentPageFromScroll]);

  const reportCurrentPage = useCallback(() => {
    const page = currentPageFromScroll();
    if (page === 0 || page === lastReportedRef.current) return;
    lastReportedRef.current = page;
    useDocumentStore.getState().setCurrentPage(page);
  }, [currentPageFromScroll]);

  const scrollToPage = useCallback((page: number) => {
    const el = scrollRef.current;
    const tops = offsetsRef.current;
    if (!el || !tops || tops.length === 0) return;
    const index = Math.min(Math.max(1, page), tops.length) - 1;
    const top = tops[index];
    if (top === undefined) return;
    el.scrollTop = top;
  }, []);

  const handleScroll = () => {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      updateAnchor();
      reportCurrentPage();
    });
  };

  // 点击文档区即聚焦滚动容器，方向键/PageUp/PageDown 翻页随手可用。
  const handleMouseDown = () => {
    scrollRef.current?.focus();
  };

  useEffect(() => () => {
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
  }, []);

  // ===== 布局就绪：重算偏移、恢复会话页、初始化锚点 =====
  useLayoutEffect(() => {
    if (!pageSizes) return;
    setVisibleSet(new Set()); // IO 回调随后按实际相交重新填充
    recomputeOffsets();
    const target = Math.min(Math.max(1, useDocumentStore.getState().currentPage), pageSizes.length);
    lastReportedRef.current = target;
    if (target > 1) scrollToPage(target);
    updateAnchor();
  }, [pageSizes, recomputeOffsets, scrollToPage, updateAnchor]);

  // ===== 外部页号消费（工具栏/侧栏/键盘 → store.currentPage → 滚动定位） =====
  useEffect(() => {
    if (!pageSizes) return; // 布局未就绪：恢复逻辑已处理
    if (currentPage === lastReportedRef.current) return;
    lastReportedRef.current = currentPage;
    scrollToPage(currentPage);
  }, [currentPage, pageSizes, scrollToPage]);

  // ===== 虚拟化：只挂载可视区 ±1 视口内的页 =====
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !pageSizes) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleSet((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.page);
            if (!Number.isFinite(page)) continue;
            const index = page - 1;
            if (entry.isIntersecting && !next.has(index)) {
              next.add(index);
              changed = true;
            } else if (!entry.isIntersecting && next.has(index)) {
              next.delete(index);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      // 上下各扩一个视口：典型文档页高 ≈ 视口高，即「可视页 ±1 页」。
      { root, rootMargin: "100% 0px 100% 0px" },
    );
    for (const el of itemRefs.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [pageSizes]);

  // ===== 缩放锚点补偿（技术方案 5.3 第 10 条） =====
  const prevScaleRef = useRef(scale);
  useLayoutEffect(() => {
    const prev = prevScaleRef.current;
    prevScaleRef.current = scale;
    if (prev === scale || !pageSizes) return;
    recomputeOffsets();
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (el && anchor) {
      const top = offsetsRef.current?.[anchor.page - 1] ?? 0;
      const item = itemRefs.current[anchor.page - 1];
      const height = Math.max(1, item ? item.offsetHeight : 1);
      el.scrollTop = Math.max(0, top + anchor.ratio * height);
    }
    reportCurrentPage();
  }, [scale, pageSizes, recomputeOffsets, reportCurrentPage]);

  // ===== Ctrl/⌘ + 滚轮缩放（原生监听，passive:false 才能 preventDefault） =====
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pageSizes) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // 归一化滚动量：像素模式约 ±100/档；行/页模式按 33/100 折算。
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 33
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? 100
            : 1;
      const steps = (-event.deltaY * unit) / 100;
      const store = useDocumentStore.getState();
      store.setScale(clampScale(store.scale * Math.pow(ZOOM_STEP, steps)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pageSizes]);

  // ===== 键盘翻页（方向键/PageUp/PageDown/Home/End，技术方案 5.3 第 9 条） =====
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pageSizes) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && target.closest("input, textarea, [contenteditable='true']")) return;
      const store = useDocumentStore.getState();
      const max = Math.max(1, store.numPages);
      let destination: number;
      switch (event.key) {
        case "ArrowDown":
        case "PageDown":
          destination = Math.min(max, store.currentPage + 1);
          break;
        case "ArrowUp":
        case "PageUp":
          destination = Math.max(1, store.currentPage - 1);
          break;
        case "Home":
          destination = 1;
          break;
        case "End":
          destination = max;
          break;
        default:
          return;
      }
      event.preventDefault();
      store.setCurrentPage(destination);
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [pageSizes]);

  // ===== 窗口尺寸变化：重算偏移与锚点 =====
  useEffect(() => {
    const onResize = () => {
      recomputeOffsets();
      updateAnchor();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [recomputeOffsets, updateAnchor]);

  // ===== 适应宽度：真实计算在持有容器与页宽的这一侧注册，工具栏经桥请求 =====
  const pageSizesRef = useRef<PageSize[] | null>(null);
  useEffect(() => {
    pageSizesRef.current = pageSizes;
  }, [pageSizes]);
  useEffect(() => {
    if (!pageSizes) return;
    return registerFitWidthHandler(() => {
      const el = scrollRef.current;
      const sizes = pageSizesRef.current;
      if (!el || !sizes || sizes.length === 0) return;
      const page = Math.min(Math.max(1, useDocumentStore.getState().currentPage), sizes.length);
      const base = sizes[page - 1];
      if (!base || base.width <= 0) return;
      const available = el.clientWidth - 2 * VIEWER_PADDING;
      if (available <= 0) return;
      useDocumentStore.getState().setScale(clampScale(available / base.width));
    });
  }, [pageSizes]);

  // pdf.js 文本层/尺寸契约：--scale-factor 开在页栈上作默认值，
  // 各页项再按封顶后缩放逐页覆盖（百分比定位随之生效）。
  const pagesStyle = { "--scale-factor": String(scale), padding: VIEWER_PADDING } as CSSProperties;

  return (
    <div className="viewer-page">
      <ViewerToolbar />
      <div
        ref={scrollRef}
        className="viewer-scroll"
        tabIndex={0}
        aria-label={fileName ? `${fileName} 文档视图` : "文档视图"}
        onScroll={handleScroll}
        onMouseDown={handleMouseDown}
      >
        {status !== "ready" ? (
          <div className="viewer-state">
            {status === "idle" && (
              <p className="viewer-empty">尚未打开文件——从首页「打开 PDF 文件」开始。</p>
            )}
            {status === "loading" && <p className="viewer-empty">正在装载文档…</p>}
            {status === "error" && (
              <div className="viewer-error" role="alert">
                <p>打开失败：{error ?? "未知错误"}</p>
                <p className="viewer-error-path">{path ?? fileName ?? ""}</p>
              </div>
            )}
          </div>
        ) : !pageSizes ? (
          <div className="viewer-state">
            <p className="viewer-empty">正在计算页面布局…</p>
          </div>
        ) : (
          <div className="viewer-pages" style={pagesStyle}>
            {pageSizes.map((size, index) => {
              // 占位框与 core 队列落笔同源封顶（cssWidth = floor(viewport.cssScale)）；
              // --scale-factor 按页给定，供文本层字体缩放使用（封顶后与 store.scale 不同）。
              const cssScale = capScaleForRaster(size.width, size.height, scale);
              return (
                <div
                  key={index}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  className="viewer-page-item"
                  data-page={index + 1}
                  style={
                    {
                      width: Math.floor(size.width * cssScale),
                      height: Math.floor(size.height * cssScale),
                      "--scale-factor": String(cssScale),
                    } as CSSProperties
                  }
                >
                  {visibleSet.has(index) && pdfDocument ? (
                    <PageCanvas pageNumber={index + 1} scale={scale} distance={Math.abs(index + 1 - currentPage)} />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
