import type { PDFPageProxy } from "pdfjs-dist";
import { pdfjsLib } from "./pdfjs";
import { useDocumentStore, activeTabOf } from "./store";

/**
 * 渲染任务队列（技术方案 5.2 第 6/7 条）：
 * - 串行派发：同一时刻最多一个 pdf.js render 在跑，避免 worker 争抢与掉帧；
 * - 可视页优先：priority 越小越先出队（建议：可视页 0、预取 10、缩略图 20）；
 * - 防竞态：每个画布维护单调递增 ticket 与最新 generation——同画布来新任务时
 *   旧任务立即 cancel，落笔前再校验一次「仍是该画布最新一代」，杜绝旧结果
 *   覆盖新画面（串页）；
 * - 分辨率：物理像素 = viewport(scale) × devicePixelRatio，CSS 尺寸 = viewport(scale)；
 *   单边光栅上限 8192px（Chromium 上限 16384 留余量），超限自动封顶该页缩放；
 * - 双缓冲上屏（M2 闪屏修复）：渲染先落队列私有的离屏画布，成功且仍是该画布
 *   最新代之后，才在同一个同步块里对可见画布「赋尺寸 + 拷贝位图 + 写 CSS 尺寸」。
 *   对可见画布直接赋 width/height 会同步清空位图，而 pdf.js 绘制是异步的——
 *   中间窗口画布全透明、露出页项白底，即缩放闪屏的根源；被取代的任务从头到尾
 *   不碰可见画布（防竞态语义比逐格清屏重绘更严）。
 */

/** 单边光栅上限（px）。 */
export const MAX_RASTER_EDGE = 8192;

/** 封顶下限，防止极端长宽比把缩放压到 0。 */
const MIN_SCALE = 0.01;

/** 可视页 0、预取 10、缩略图 20（越小越先渲染）。 */
export const RENDER_PRIORITY = {
  visible: 0,
  prefetch: 10,
  thumbnail: 20,
} as const;

/** 单次渲染的落笔几何（CSS 尺寸与画布物理尺寸同源）。 */
export interface RenderGeometry {
  /** 封顶后的实际 CSS 缩放（≤ 请求缩放）。 */
  cssScale: number;
  cssWidth: number;
  cssHeight: number;
  /** 画布物理尺寸（= CSS × devicePixelRatio，单边 ≤ 8192）。 */
  rasterWidth: number;
  rasterHeight: number;
}

/**
 * 把请求缩放封顶到光栅安全值（技术方案 5.2 第 7 条）。
 * 查看器排版占位与本队列落笔必须用同一函数，保证占位与画面尺寸一致。
 */
export function capScaleForRaster(pageWidth: number, pageHeight: number, scale: number): number {
  const dpr = window.devicePixelRatio || 1;
  const maxCssEdge = Math.max(pageWidth, pageHeight) * scale;
  if (maxCssEdge * dpr <= MAX_RASTER_EDGE) return scale;
  return Math.max(MIN_SCALE, MAX_RASTER_EDGE / (Math.max(pageWidth, pageHeight) * dpr));
}

function computeGeometry(page: PDFPageProxy, requestedScale: number, rotationOverride?: number): RenderGeometry {
  const base = page.getViewport({ scale: 1, rotation: rotationOverride });
  const cssScale = capScaleForRaster(base.width, base.height, requestedScale);
  const viewport = page.getViewport({ scale: cssScale, rotation: rotationOverride });
  const dpr = window.devicePixelRatio || 1;
  return {
    cssScale,
    cssWidth: Math.floor(viewport.width),
    cssHeight: Math.floor(viewport.height),
    rasterWidth: Math.floor(viewport.width * dpr),
    rasterHeight: Math.floor(viewport.height * dpr),
  };
}

export type RenderOutcome =
  | { status: "painted"; geometry: RenderGeometry }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

export interface RenderHandle {
  /** 取消本次渲染（排队/取页/绘制中均可取消；已完成的不再有副作用）。 */
  cancel(): void;
  /** 结算 Promise（永不 reject）：painted=已上屏，cancelled=被取消/被取代。 */
  readonly done: Promise<RenderOutcome>;
}

interface QueueJob {
  id: number;
  priority: number;
  generation: number;
  /** generation 是否由队列从 store 注入（外部令牌只与本画布令牌比，不与 store 比）。 */
  storeGeneration: boolean;
  ticket: number;
  canvas: HTMLCanvasElement;
  /** 出队时才解析，保证取页也串行、取消可穿透取页阶段。 */
  providePage: () => Promise<PDFPageProxy>;
  /** 依据页面实际尺寸决定 CSS 缩放（整页=固定值；缩略图=按边长适配）。 */
  resolveScale: (page: PDFPageProxy) => number;
  /** 覆盖页面旋转角（度；缺省用页面自身 /Rotate）。M3 组织视图按旋转增量预览用。 */
  rotationOverride: number | undefined;
  cancelRequested: boolean;
  runningTask: { cancel(): void } | null;
  settle: (outcome: RenderOutcome) => void;
}

/** 每个画布的最新请求信息：只有最新 ticket 允许上屏（防旧结果覆盖新画面）。 */
interface CanvasSlot {
  ticket: number;
}

export class RenderQueue {
  private nextJobId = 1;
  private readonly slots = new WeakMap<HTMLCanvasElement, CanvasSlot>();
  private readonly jobs: QueueJob[] = [];
  private running: QueueJob | null = null;
  /** 离屏中转画布（双缓冲）：串行执行期间同一时刻只有一个任务在跑，独占复用
   *  一块即可，避免每次渲染分配大位图；clear() 时缩为 0×0 释放位图不跨文档滞留。 */
  private scratch: HTMLCanvasElement | null = null;

  /**
   * 低阶入口（占位契约延续）：调用方已持有 PDFPageProxy 时直接排队渲染。
   * @param request.generation 代际令牌：同画布 newer generation 取代 older；
   *   缺省取激活标签的 loadGeneration（标签切换或重开后过期）。外部令牌
   *   只与本画布 ticket 比较，不与 store 比对。
   */
  enqueue(request: {
    page: PDFPageProxy;
    canvas: HTMLCanvasElement;
    scale: number;
    priority?: number;
    generation?: number;
  }): RenderHandle {
    return this.submit({
      canvas: request.canvas,
      priority: request.priority,
      generation: request.generation,
      providePage: () => Promise.resolve(request.page),
      resolveScale: () => request.scale,
      rotationOverride: undefined,
    });
  }

  /**
   * 高阶入口：按页号渲染当前激活标签文档的一页（页对象在出队时向激活标签的
   * 文档取）。generation 缺省取**激活标签**的 loadGeneration，标签切换或该标签
   * 重新装载后自动过期。
   */
  renderPage(request: {
    pageNumber: number;
    canvas: HTMLCanvasElement;
    scale: number;
    priority?: number;
    generation?: number;
  }): RenderHandle {
    const pageNumber = request.pageNumber;
    return this.submit({
      canvas: request.canvas,
      priority: request.priority,
      generation: request.generation,
      providePage: () => getPageOrThrow(pageNumber),
      resolveScale: () => request.scale,
      rotationOverride: undefined,
    });
  }

  /**
   * 缩略图渲染（与整页渲染同源，技术方案 4.3 规则 1）：按最长边适配。
   * `rotation`（0/90/180/270）覆盖页面 /Rotate——M3 组织视图的旋转预览与侧栏
   * 共用本接口；pdf.js 的 viewport rotation 语义是「替换」而非「叠加」，
   * 调用方须传 原角+增量 的合成值（页面自身旋转 + 组织旋转增量）。
   */
  renderThumbnail(request: {
    pageNumber: number;
    canvas: HTMLCanvasElement;
    /** 缩略图区域最长边（CSS px），默认 160。 */
    maxEdge?: number;
    priority?: number;
    generation?: number;
    /** 覆盖旋转角（度）；缺省渲染页面自身朝向（与侧栏行为一致）。 */
    rotation?: number;
  }): RenderHandle {
    const pageNumber = request.pageNumber;
    const maxEdge = request.maxEdge ?? 160;
    const rotation = request.rotation;
    return this.submit({
      canvas: request.canvas,
      priority: request.priority ?? RENDER_PRIORITY.thumbnail,
      generation: request.generation,
      providePage: () => getPageOrThrow(pageNumber),
      resolveScale: (page) => {
        const base = page.getViewport({ scale: 1, rotation });
        return capScaleForRaster(base.width, base.height, maxEdge / Math.max(base.width, base.height));
      },
      rotationOverride: rotation,
    });
  }

  /** 清空队列并取消全部任务（文档关闭/切换时由 openDocument 调用）。 */
  clear(): void {
    const pending = this.jobs.splice(0, this.jobs.length);
    const running = this.running;
    this.running = null;
    for (const job of pending) job.settle({ status: "cancelled" });
    if (running) {
      running.cancelRequested = true;
      running.runningTask?.cancel();
      running.settle({ status: "cancelled" });
    }
    // 离屏画布缩为 0×0 释放后备位图：上一份文档的最大页光栅不跨文档滞留
    //（元素本身保留复用，下次渲染会重新赋到所需尺寸）。
    if (this.scratch) {
      this.scratch.width = 0;
      this.scratch.height = 0;
    }
  }

  // ---- 内部实现 -----------------------------------------------------------

  private submit(input: {
    canvas: HTMLCanvasElement;
    priority?: number;
    generation?: number;
    providePage: () => Promise<PDFPageProxy>;
    resolveScale: (page: PDFPageProxy) => number;
    rotationOverride: number | undefined;
  }): RenderHandle {
    const storeGeneration = input.generation === undefined;
    // 默认代际令牌来自激活标签（多标签下各标签代际互不单调，故用全等比对：
    // 换激活标签或本标签重开都会让旧令牌过期，杜绝跨标签旧结果落笔）。
    const generation = input.generation ?? activeTabOf(useDocumentStore.getState()).loadGeneration;
    const slot = this.slots.get(input.canvas) ?? { ticket: 0 };
    slot.ticket += 1;
    this.slots.set(input.canvas, slot);

    const job: QueueJob = {
      id: this.nextJobId++,
      priority: input.priority ?? RENDER_PRIORITY.visible,
      generation,
      storeGeneration,
      ticket: slot.ticket,
      canvas: input.canvas,
      providePage: input.providePage,
      resolveScale: input.resolveScale,
      rotationOverride: input.rotationOverride,
      cancelRequested: false,
      runningTask: null,
      settle: () => undefined,
    };
    // 同画布旧任务立即作废：新请求已代表该画布的最新一代。
    this.cancelStaleForCanvas(input.canvas, job);

    let settleJob!: (outcome: RenderOutcome) => void;
    job.settle = (outcome) => {
      job.settle = () => undefined; // 幂等
      settleJob(outcome);
    };
    const done = new Promise<RenderOutcome>((resolve) => {
      settleJob = resolve;
    });
    const handle: RenderHandle = {
      cancel: () => {
        job.cancelRequested = true;
        if (this.running === job) job.runningTask?.cancel();
        this.removeQueued(job, { status: "cancelled" });
      },
      done,
    };
    this.jobs.push(job);
    this.jobs.sort((a, b) => a.priority - b.priority || a.id - b.id);
    this.pump();
    return handle;
  }

  /** 作废同画布上除 latest 以外的排队/运行中任务。 */
  private cancelStaleForCanvas(canvas: HTMLCanvasElement, latest: QueueJob): void {
    for (const other of this.jobs) {
      if (other.canvas === canvas && other !== latest) {
        other.cancelRequested = true;
      }
    }
    const running = this.running;
    if (running && running.canvas === canvas && running !== latest) {
      running.cancelRequested = true;
      running.runningTask?.cancel();
    }
  }

  private removeQueued(job: QueueJob, outcome: RenderOutcome): void {
    const index = this.jobs.indexOf(job);
    if (index >= 0) {
      this.jobs.splice(index, 1);
      job.settle(outcome);
    }
  }

  private isCurrentOnCanvas(job: QueueJob): boolean {
    if (job.cancelRequested) return false;
    // 仅当 generation 是队列从 store 注入的默认值时才与「激活标签」的代际比对
    // （换标签/本标签重开都过期）；调用方自带的外部令牌（如侧栏本地代际）
    // 只与本画布 ticket 比较，语义互不串扰。
    if (job.storeGeneration && job.generation !== activeTabOf(useDocumentStore.getState()).loadGeneration) {
      return false;
    }
    const slot = this.slots.get(job.canvas);
    return slot !== undefined && slot.ticket === job.ticket;
  }

  private pump(): void {
    if (this.running !== null) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.running = job;
    void this.execute(job).finally(() => {
      if (this.running === job) this.running = null;
      this.pump();
    });
  }

  private async execute(job: QueueJob): Promise<void> {
    if (!this.isCurrentOnCanvas(job)) {
      job.settle({ status: "cancelled" });
      return;
    }
    let page: PDFPageProxy;
    try {
      page = await job.providePage();
    } catch (error) {
      job.settle({ status: "failed", error });
      return;
    }
    // 取页期间可能被新任务取代，落笔前再校验一次（防竞态串页）。
    if (!this.isCurrentOnCanvas(job)) {
      job.settle({ status: "cancelled" });
      return;
    }

    const geometry = computeGeometry(page, job.resolveScale(page), job.rotationOverride);
    const viewport = page.getViewport({ scale: geometry.cssScale, rotation: job.rotationOverride });
    const dpr = window.devicePixelRatio || 1;
    const { canvas } = job;
    // 双缓冲：先画到队列私有的离屏画布。若在这里就对可见画布赋 width/height，
    // 位图会被同步清空为透明，而新画面要等异步 render 完成才存在——中间窗口
    // 露出页项白底，正是缩放闪屏的根源。离屏画布每次赋到精确尺寸再渲染，
    // 保证 drawImage 上屏时是 1:1 拷贝（不留上一代的残影区域）。
    const scratch = (this.scratch ??= document.createElement("canvas"));
    scratch.width = geometry.rasterWidth;
    scratch.height = geometry.rasterHeight;

    try {
      const task = page.render({
        canvas: scratch,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      job.runningTask = task;
      await task.promise;
      if (!this.isCurrentOnCanvas(job)) {
        // 渲染完成后已被取代：丢弃离屏结果即可——可见画布从头到尾未被触碰
        // （旧位图仍铺满占位框），新任务落地前不出现空白窗口，仅结算取消。
        job.settle({ status: "cancelled" });
        return;
      }
      // 上屏：位图清空（赋 width/height）与拷贝绘制、CSS 尺寸写在同一个同步块，
      // 合成器没有机会在「清空 → 新位图」之间插入空白帧。
      canvas.width = geometry.rasterWidth;
      canvas.height = geometry.rasterHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(scratch, 0, 0);
      canvas.style.width = `${geometry.cssWidth}px`;
      canvas.style.height = `${geometry.cssHeight}px`;
      job.settle({ status: "painted", geometry });
    } catch (error) {
      if (job.cancelRequested || error instanceof pdfjsLib.RenderingCancelledException) {
        job.settle({ status: "cancelled" });
      } else {
        job.settle({ status: "failed", error });
      }
    } finally {
      job.runningTask = null;
    }
  }
}

/** 取激活标签文档的指定页（1 起）；无标签会话时抛错。 */
function getPageOrThrow(pageNumber: number): Promise<PDFPageProxy> {
  const { document } = activeTabOf(useDocumentStore.getState());
  if (!document) {
    return Promise.reject(new Error("尚未打开文档，无法渲染页面"));
  }
  return document.getPage(pageNumber);
}

/** 全局唯一渲染队列实例（core 持有，查看器/侧栏只经 core 接口使用）。 */
export const renderQueue = new RenderQueue();
