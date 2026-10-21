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
import { useDocumentStore, activeTabOf, type PageSize } from "../../core/document/store";
import { useUiStore } from "../../shell/uiStore";
import { clampScale, ZOOM_STEP } from "./pageGeometry";
import { PageCanvas } from "./PageCanvas";
import { registerFitWidthHandler } from "./scrollBridge";
import { SearchHitLayer, SearchPanel, useSearchHitFocus } from "./searchPanel";
import { TabStrip } from "./tabStrip";
import { ViewerToolbar } from "./ViewerToolbar";
import "./viewer.css";

/** 滚动内容与视口边的留白（.viewer-pages 的内联 padding，单侧）。 */
const VIEWER_PADDING = 24;
/** 当前页判定容差：视口顶边以下该像素内仍视为上一页贴边。 */
const CURRENT_PAGE_TOLERANCE = 4;
/** 沉浸边缘唤出阈值（T7）：与 AppShell 同款（顶缘 8px 唤出、越过 140px 收起）。
 *  两处各自持有一份常量是有意的——模块间不为共享一个小阈值增加耦合，改时同步。 */
const IMMERSIVE_REVEAL_PX = 8;
const IMMERSIVE_HIDE_PX = 140;

export function ViewerPage() {
  const [params] = useSearchParams();
  const path = params.get("path");

  // 多标签 store（M2-计划 D1）：整个查看器只看「激活标签」的会话字段；
  // activeTabOf 无标签时返回稳定哨兵（idle 空态），本组件免判空。
  const tab = useDocumentStore(activeTabOf);
  const status = tab.status;
  const error = tab.error;
  const fileName = tab.fileName;
  const currentPage = tab.currentPage;
  const scale = tab.scale;
  const pdfDocument = tab.document;
  const storePageSizes = tab.pageSizes;
  const activeTabId = useDocumentStore((s) => s.activeTabId);
  const openRejection = useDocumentStore((s) => s.openRejection);
  const dismissOpenRejection = useDocumentStore((s) => s.dismissOpenRejection);

  // 搜索面板（M2 T4）：开合是 uiStore 的会话级瞬态；命中聚焦经 searchPanel 模块内桥订阅。
  const searchPanelOpen = useUiStore((s) => s.searchPanelOpen);
  const hitFocus = useSearchHitFocus();

  // 沉浸模式（M2 T7）：uiStore 会话级瞬态。shell 侧已隐藏顶栏/侧栏/右侧面板；
  // 本页隐藏标签条与工具栏，鼠标移到窗口顶缘临时唤出（与 AppShell 同款阈值
  // 联动，两侧独立判定、无共享状态）。
  const immersive = useUiStore((s) => s.immersive);
  // 画布反色（T7 / M2-计划 D8）：开关在工具栏，落点见下方 canvas-invert 同步效应。
  const canvasInvert = useUiStore((s) => s.canvasInvert);
  // 标签条（M2 T9）：无标签时不渲染（空态下孤零零一个「+」反而误导）。
  const tabCount = useDocumentStore((s) => s.tabs.length);

  // 沉浸边缘唤出：只在沉浸期间挂 mousemove 监听，退出即复位（不留瞬态残留）。
  const [immersivePeek, setImmersivePeek] = useState(false);
  useEffect(() => {
    if (!immersive) {
      setImmersivePeek(false);
      return;
    }
    const onMove = (event: MouseEvent) => {
      if (event.clientY <= IMMERSIVE_REVEAL_PX) setImmersivePeek(true);
      else if (event.clientY > IMMERSIVE_HIDE_PX) setImmersivePeek(false);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [immersive]);
  const chromeVisible = !immersive || immersivePeek;

  // 路由参数驱动装载（技术方案 5.1）：换文件或首次进入才装载；同路径标签已就绪
  // 则跳过（M3：从组织视图返回时不重载，页码/缩放与未导出的组织状态一并保留）。
  useEffect(() => {
    if (!path) return;
    const current = activeTabOf(useDocumentStore.getState());
    if (current.status === "ready" && current.sourcePath === path) return;
    void openDocument(path);
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
    const target = Math.min(Math.max(1, activeTabOf(useDocumentStore.getState()).currentPage), pageSizes.length);
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
      const session = activeTabOf(useDocumentStore.getState());
      useDocumentStore.getState().setScale(clampScale(session.scale * Math.pow(ZOOM_STEP, steps)));
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
      const session = activeTabOf(useDocumentStore.getState());
      const max = Math.max(1, session.numPages);
      let destination: number;
      switch (event.key) {
        case "ArrowDown":
        case "PageDown":
          destination = Math.min(max, session.currentPage + 1);
          break;
        case "ArrowUp":
        case "PageUp":
          destination = Math.max(1, session.currentPage - 1);
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
      useDocumentStore.getState().setCurrentPage(destination);
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

  // ===== 画布反色落点（T7 / D8）：按 uiStore.canvasInvert 把 theme.css 既有的
  // .canvas-invert 类挂到每张页面画布上（该滤镜只反色画布，不碰文本层与高亮
  // 覆盖层）。画布由 PageCanvas 随虚拟化挂卸，本组件用 MutationObserver 在容器
  // 侧同步类名——PageCanvas.tsx 不在本任务授权文件清单内，这里是不动它的等价
  // 落点；观察器随滚动舞台（key=activeTabId）重建，无泄漏。 =====
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const sync = () => {
      for (const el of root.querySelectorAll<HTMLElement>(".viewer-page-canvas")) {
        el.classList.toggle("canvas-invert", canvasInvert);
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [canvasInvert, activeTabId, pageSizes]);

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
      const page = Math.min(Math.max(1, activeTabOf(useDocumentStore.getState()).currentPage), sizes.length);
      const base = sizes[page - 1];
      if (!base || base.width <= 0) return;
      const available = el.clientWidth - 2 * VIEWER_PADDING;
      if (available <= 0) return;
      useDocumentStore.getState().setScale(clampScale(available / base.width));
    });
  }, [pageSizes]);

  // ===== 搜索命中跳转（M2-1）：面板发布聚焦 → 滚动到命中矩形上方约 1/3 视口处 =====
  // 命中矩形 top 是「页项内 CSS 偏移」（与页项 offsetTop 同基准），直接叠加即可；
  // 缩放后的重发布也会走到这里，命中持续保持在视口内。
  useEffect(() => {
    if (!hitFocus) return;
    const el = scrollRef.current;
    const item = itemRefs.current[hitFocus.pageNumber - 1];
    const target = hitFocus.hitRects[hitFocus.hitIndex]?.[0];
    if (!el || !item || !target) return;
    el.scrollTop = Math.max(0, item.offsetTop + target.top - el.clientHeight / 3);
  }, [hitFocus]);

  // pdf.js 文本层/尺寸契约：--scale-factor 开在页栈上作默认值，
  // 各页项再按封顶后缩放逐页覆盖（百分比定位随之生效）。
  const pagesStyle = { "--scale-factor": String(scale), padding: VIEWER_PADDING } as CSSProperties;

  return (
    <div className="viewer-page">
      {/* 沉浸（T7）：标签条与工具栏一并隐藏，鼠标移到窗口顶缘临时唤出（与 AppShell
          侧同款阈值联动）。「打开被拒」横幅是警报、搜索面板是阅读伴随工具——
          不算界面骨架，沉浸下保持可见。 */}
      {chromeVisible && tabCount > 0 && <TabStrip />}
      {chromeVisible && <ViewerToolbar />}
      {/* 打开被拒（标签达到上限等）：不侵入任何标签的会话状态，横幅提示即可 */}
      {openRejection && (
        <div className="viewer-rejection" role="alert">
          <span className="viewer-rejection-text">{openRejection}</span>
          <button type="button" className="viewer-rejection-dismiss" onClick={dismissOpenRejection}>
            知道了
          </button>
        </div>
      )}
      {/* 主区横向行（M2-计划 D4）：滚动舞台 + 右侧可折叠搜索面板。
          面板是 viewer 内部布局，不动 shell 的右侧面板占位（留给 M5）。 */}
      <div className="viewer-main-row">
        {/* key 绑定标签 id：切换标签时整个滚动舞台重挂载——滚动位置/虚拟化集合/
            观察者全部按新标签重建（页码由下方布局恢复效应滚动到位），旧标签的
            画布句柄随之卸载取消，杜绝两标签的画面串扰。 */}
        <div
          key={activeTabId ?? "no-tab"}
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
                    {/* 搜索命中覆盖层（T4）：自己的层渲染命中矩形，不碰 PageCanvas；
                        只挂在有聚焦命中的那一页，矩形随缩放由面板重算发布。 */}
                    {hitFocus && hitFocus.pageNumber === index + 1 ? <SearchHitLayer focus={hitFocus} /> : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {searchPanelOpen && <SearchPanel />}
      </div>
    </div>
  );
}
