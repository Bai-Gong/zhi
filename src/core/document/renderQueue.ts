import type { PDFPageProxy } from "pdfjs-dist";
import { pdfjsLib } from "./pdfjs";
import { useDocumentStore } from "./store";

/**
 * 渲染任务队列（技术方案 5.2 第 6/7 条）：
 * - 串行派发：同一时刻最多一个 pdf.js render 在跑，避免 worker 争抢与掉帧；
 * - 可视页优先：priority 越小越先出队（建议：可视页 0、预取 10、缩略图 20）；
 * - 防竞态：每个画布维护单调递增 ticket 与最新 generation——同画布来新任务时
 *   旧任务立即 cancel，落笔前再校验一次「仍是该画布最新一代」，杜绝旧结果
 *   覆盖新画面（串页）；
 * - 分辨率：物理像素 = viewport(scale) × devicePixelRatio，CSS 尺寸 = viewport(scale)；
 *   单边光栅上限 8192px（Chromium 上限 16384 留余量），超限自动封顶该页缩放。
 * - 双缓冲：新帧先完整绘入离屏画布，完成后才重设在屏画布尺寸并在同一同步块内
 *   整帧复制——尺寸重置产生的空白位图永不上屏，缩放重渲期间旧帧按占位框
 *   CSS 拉伸垫底（pdf.js 以 alpha:false 建上下文，重设在屏画布会露出整页黑位图，
 *   且填白要等 worker 回传首批指令），消除缩放黑闪。
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

function computeGeometry(page: PDFPageProxy, requestedScale: number): RenderGeometry {
  const base = page.getViewport({ scale: 1 });
  const cssScale = capScaleForRaster(base.width, base.height, requestedScale);
  const viewport = page.getViewport({ scale: cssScale });
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
  /** 等待队列排空的回调（whenIdle 登记，drain 时一次性结算）。 */
  private idleWaiters: Array<() => void> = [];

  /** 是否有排队/运行中的任务（core 内部信号，供文本索引调度让位）。 */
  get busy(): boolean {
    return this.running !== null || this.jobs.length > 0;
  }

  /**
   * 等待队列排空（drain）；当前已空闲则立即 resolve。core 内部供 M2 文本索引
   * 调度让位：渲染绝对优先，索引在队列空闲的间隙分批推进（不改变对外渲染契约）。
   */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** 队列已排空：结算全部等待者（clear 后同样视为空闲）。 */
  private notifyIdle(): void {
    if (this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }

  /**
   * 低阶入口（占位契约延续）：调用方已持有 PDFPageProxy 时直接排队渲染。
   * @param request.generation 代际令牌：同画布 newer generation 取代 older；
   *   传入小于 store 当前 loadGeneration 的任务会被直接丢弃（文档已切换）。
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
    });
  }

  /**
   * 高阶入口：按页号渲染当前会话文档的一页（页对象在出队时向 store 里的
   * 文档取）。generation 缺省取 store 当前 loadGeneration，文档切换后自动过期。
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
    });
  }

  /** 缩略图渲染（与整页渲染同源，技术方案 4.3 规则 1）：按最长边适配。 */
  renderThumbnail(request: {
    pageNumber: number;
    canvas: HTMLCanvasElement;
    /** 缩略图区域最长边（CSS px），默认 160。 */
    maxEdge?: number;
    priority?: number;
    generation?: number;
  }): RenderHandle {
    const pageNumber = request.pageNumber;
    const maxEdge = request.maxEdge ?? 160;
    return this.submit({
      canvas: request.canvas,
      priority: request.priority ?? RENDER_PRIORITY.thumbnail,
      generation: request.generation,
      providePage: () => getPageOrThrow(pageNumber),
      resolveScale: (page) => {
        const base = page.getViewport({ scale: 1 });
        return capScaleForRaster(base.width, base.height, maxEdge / Math.max(base.width, base.height));
      },
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
    this.notifyIdle();
  }

  // ---- 内部实现 -----------------------------------------------------------

  private submit(input: {
    canvas: HTMLCanvasElement;
    priority?: number;
    generation?: number;
    providePage: () => Promise<PDFPageProxy>;
    resolveScale: (page: PDFPageProxy) => number;
  }): RenderHandle {
    const storeGeneration = input.generation === undefined;
    const generation = input.generation ?? useDocumentStore.getState().loadGeneration;
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
    // 仅当 generation 是队列从 store 注入的默认值时才与 store 比对（文档切换过期）；
    // 调用方自带的外部令牌（如侧栏本地代际）只与本画布 ticket 比较，语义互不串扰。
    if (job.storeGeneration && job.generation < useDocumentStore.getState().loadGeneration) return false;
    const slot = this.slots.get(job.canvas);
    return slot !== undefined && slot.ticket === job.ticket;
  }

  private pump(): void {
    if (this.running !== null) return;
    const job = this.jobs.shift();
    if (!job) {
      this.notifyIdle();
      return;
    }
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

    const geometry = computeGeometry(page, job.resolveScale(page));
    const viewport = page.getViewport({ scale: geometry.cssScale });
    const dpr = window.devicePixelRatio || 1;
    const { canvas } = job;
    // 双缓冲：先把新帧完整绘入离屏画布（重置位图/填白/逐条 ops 全程不上屏），
    // 成功后在同一同步块内重设在屏画布尺寸并整帧复制——合成器采样不到
    // 「已重置、未复制」的中间位图；缩放等待期旧帧继续按占位框 CSS 拉伸垫底。
    const offscreen = document.createElement("canvas");
    offscreen.width = geometry.rasterWidth;
    offscreen.height = geometry.rasterHeight;

    try {
      const task = page.render({
        canvas: offscreen,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      job.runningTask = task;
      await task.promise;
      if (!this.isCurrentOnCanvas(job)) {
        // 渲染完成后已被取代：不动在屏画布（新任务即将覆盖），仅结算取消。
        job.settle({ status: "cancelled" });
        return;
      }
      canvas.width = geometry.rasterWidth;
      canvas.height = geometry.rasterHeight;
      canvas.style.width = `${geometry.cssWidth}px`;
      canvas.style.height = `${geometry.cssHeight}px`;
      canvas.getContext("2d")?.drawImage(offscreen, 0, 0);
      job.settle({ status: "painted", geometry });
    } catch (error) {
      if (job.cancelRequested || error instanceof pdfjsLib.RenderingCancelledException) {
        job.settle({ status: "cancelled" });
      } else {
        job.settle({ status: "failed", error });
      }
    } finally {
      job.runningTask = null;
      // 归零离屏画布释放位图后备存储（高倍缩放时单帧可达数千万像素）。
      offscreen.width = 0;
      offscreen.height = 0;
    }
  }
}

/** 取当前会话文档的指定页（1 起）；无文档会话时抛错。 */
function getPageOrThrow(pageNumber: number): Promise<PDFPageProxy> {
  const { document } = useDocumentStore.getState();
  if (!document) {
    return Promise.reject(new Error("尚未打开文档，无法渲染页面"));
  }
  return document.getPage(pageNumber);
}

/** 全局唯一渲染队列实例（core 持有，查看器/侧栏只经 core 接口使用）。 */
export const renderQueue = new RenderQueue();
