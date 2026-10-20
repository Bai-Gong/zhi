import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useDocumentStore } from "./store";
import { renderQueue, capScaleForRaster } from "./renderQueue";

/**
 * 逐页文本索引（M2 全文搜索地基，技术方案 M2 技术要点）：
 * - 预构建：openDocument 在 ready() 后调 scheduleTextIndexBuild()——先等渲染
 *   队列排空（首批可视页画布落笔）再开工，此后每批 4 页 getTextContent，
 *   批间宏任务让出且队列忙时让位（渲染绝对优先），避免与首屏渲染争抢 worker；
 * - 会话守卫：构建起点捕获文档引用 + loadGeneration，每批双检。close() 不递增
 *   代际（store.ts 的 close 实现），单查代际会漏关闭路径，必须同时比对文档引用；
 * - 可重试：批量失败保留已建页、清空构建位，下一次 ensureTextIndex 从断点续建，
 *   绝不缓存 rejected promise（防单例中毒，旧一轮的等待者按拒绝结算）；
 * - 几何：每 item 记录页拼接文本偏移与 PDF 用户空间基线/宽高（pdfjs TextItem），
 *   getHitRects 据此把命中区间映射为与文本层同坐标系的 CSS 矩形（页左上原点）。
 */

/** 每批构建的页数（沿 openDocument 读页尺寸批 8 防 worker 洪泛的经验取更小值）。 */
const BUILD_BATCH = 4;

/** 升部近似：字形主体约在基线上方 0.8 倍字高（实现后可按文本层实测校准）。 */
const ASCENT_RATIO = 0.8;
/** 降部近似：降部约探到基线下方 0.25 倍字高。 */
const DESCENT_RATIO = 0.25;

/** 单个文本项的几何与页串偏移（PDF 用户空间，y 向上）。 */
interface IndexedItem {
  /** item.str 在页拼接文本中的起始偏移。 */
  offset: number;
  length: number;
  /** 基线起点 x（transform[4]）。 */
  x: number;
  /** 基线 y（transform[5]）。 */
  y: number;
  /** 沿基线的推进宽度（用户空间单位）。 */
  width: number;
  /** 字高（用户空间单位）。 */
  height: number;
  /** 横排 ltr 才做段内线性插值；竖排/rtl 回退整 item 矩形。 */
  interpolatable: boolean;
}

/** 一页的文本索引（拼接文本 + 预小写副本 + item 偏移几何表）。 */
export interface PageTextIndex {
  text: string;
  /** 长度保持的小写折叠副本：不敏感匹配用（原始串留给摘录与敏感模式；needle 须用 foldCase 同源折叠）。 */
  lowerText: string;
  items: IndexedItem[];
}

/** 命中矩形（CSS 像素，页左上原点，与文本层/画布同坐标系）。 */
export interface HitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一份文档会话的索引构建状态。 */
interface IndexState {
  generation: number;
  doc: PDFDocumentProxy;
  /** 与页码一一对应（下标 0 = 第 1 页）；null = 未建。 */
  pages: Array<PageTextIndex | null>;
  /** 已建页数（仅用于进度与完成判定）。 */
  builtCount: number;
  /** 是否有构建驱动在跑（single-flight）。 */
  building: boolean;
  done: boolean;
  /** 本轮 ensureTextIndex 的等待者（成功/失败一次性结算，不跨轮缓存）。 */
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

/** 当前会话的索引状态（会话切换/关闭时被丢弃）。 */
let indexState: IndexState | null = null;

/** 宏任务让出：渲染队列派发与 React 提交得以插入。 */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 会话是否仍属于 state（文档引用 + 代际双检，G3：覆盖 close 不递增代际的路径）。 */
function isStale(state: IndexState): boolean {
  const { document, loadGeneration } = useDocumentStore.getState();
  return document !== state.doc || loadGeneration !== state.generation || indexState !== state;
}

/** 取当前会话的索引状态；会话已变/无文档返回 null（旧状态一并丢弃）。 */
function currentState(): IndexState | null {
  const { document, loadGeneration } = useDocumentStore.getState();
  if (!document) {
    indexState = null;
    return null;
  }
  if (indexState && indexState.doc === document && indexState.generation === loadGeneration) {
    return indexState;
  }
  indexState = null;
  return null;
}

/** 取/建当前会话的索引状态。 */
function ensureState(): IndexState | null {
  const existing = currentState();
  if (existing) return existing;
  const { document, loadGeneration } = useDocumentStore.getState();
  if (!document) return null;
  const state: IndexState = {
    generation: loadGeneration,
    doc: document,
    pages: new Array<PageTextIndex | null>(document.numPages).fill(null),
    builtCount: 0,
    building: false,
    done: false,
    waiters: [],
  };
  indexState = state;
  return state;
}

/** pdf.js 文本项的最小结构（types 里 items 为联合类型，这里按需收窄）。 */
interface RawTextItem {
  str: string;
  dir: string;
  transform: Array<number>;
  width: number;
  height: number;
  hasEOL?: boolean;
}

/**
 * 长度保持的小写折叠：整体 toLowerCase 命中变长映射（如 İ→i̇ 占 2 码位）时
 * 逐码点折叠、长度不等处保留原字符——保证折叠副本与原文逐码位对齐，命中
 * 偏移才能同时用于摘录与矩形映射。查询侧（needle）必须使用同一函数。
 */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let folded = "";
  for (const ch of text) {
    const mapped = ch.toLowerCase();
    folded += mapped.length === ch.length ? mapped : ch;
  }
  return folded;
}

/** 抽取一页文本并建索引（拼接 item.str，hasEOL 处插入 \n 便于摘录断行）。 */
async function buildPage(state: IndexState, pageNumber: number): Promise<PageTextIndex> {
  const page: PDFPageProxy = await state.doc.getPage(pageNumber);
  const content = await page.getTextContent();
  let text = "";
  const items: IndexedItem[] = [];
  for (const raw of content.items) {
    if (!("str" in raw)) continue; // TextMarkedContent 无文本
    const item = raw as RawTextItem;
    if (item.str.length > 0) {
      const t = item.transform;
      items.push({
        offset: text.length,
        length: item.str.length,
        x: t[4],
        y: t[5],
        width: item.width,
        height: item.height,
        // 仅横排 ltr 沿基线插值；竖排（b 分量非 0）与 rtl 回退整字块。
        interpolatable: item.dir === "ltr" && Math.abs(t[1]) < 1e-6,
      });
      text += item.str;
    }
    if (item.hasEOL) text += "\n";
  }
  return { text, lowerText: foldCase(text), items };
}

/** 把构建进度写入 store（供搜索面板进度行；会话已变则丢弃）。 */
function writeIndexProgress(state: IndexState): void {
  if (isStale(state)) return;
  useDocumentStore.setState({
    searchIndexProgress: { done: state.builtCount, total: state.pages.length },
  });
}

/** 一次性结算本轮等待者（error 为 undefined 表示成功）。 */
function settleWaiters(state: IndexState, error: unknown): void {
  if (state.waiters.length === 0) return;
  const waiters = state.waiters.splice(0, state.waiters.length);
  for (const waiter of waiters) {
    if (error === undefined) waiter.resolve();
    else waiter.reject(error);
  }
}

/**
 * 构建驱动：分批推进直到全部建完。失败保留已建页并按拒绝结算本轮等待者，
 * 构建位复位——下一次 ensureTextIndex 从断点续建（不缓存 rejected promise）。
 */
async function driveBuild(state: IndexState): Promise<void> {
  try {
    // 先让首屏落笔：等一个宏任务让 React 提交、可视页渲染入队，再等队列排空。
    await macrotask();
    while (!state.done && state.builtCount < state.pages.length) {
      if (isStale(state)) {
        settleWaiters(state, new Error("文档已切换，索引构建中止"));
        return;
      }
      // 渲染绝对优先：队列忙（整页/缩略图渲染）时等排空再取下一批文本。
      if (renderQueue.busy) await renderQueue.whenIdle();
      if (isStale(state)) {
        settleWaiters(state, new Error("文档已切换，索引构建中止"));
        return;
      }
      const batch: number[] = [];
      for (let n = 1; n <= state.pages.length && batch.length < BUILD_BATCH; n++) {
        if (state.pages[n - 1] === null) batch.push(n);
      }
      if (batch.length === 0) break;
      const built = await Promise.all(batch.map((n) => buildPage(state, n)));
      if (isStale(state)) {
        settleWaiters(state, new Error("文档已切换，索引构建中止"));
        return;
      }
      // 同步块内判空写入：与并发的按需单页补建（ensurePage）互不重复计数。
      let newlyBuilt = 0;
      batch.forEach((n, i) => {
        if (state.pages[n - 1] === null) {
          state.pages[n - 1] = built[i];
          newlyBuilt += 1;
        }
      });
      state.builtCount += newlyBuilt;
      writeIndexProgress(state);
      await macrotask();
    }
    state.done = state.pages.every((p) => p !== null);
    settleWaiters(state, undefined);
    // 构建完成：清进度，避免残留值（面板仅在 indexing 态显示，此处兜底归位）。
    if (indexState === state) {
      useDocumentStore.setState({ searchIndexProgress: null });
    }
  } catch (error) {
    // 本轮失败：已建页保留（断点续建的资本），等待者按拒绝结算由调用方提示。
    settleWaiters(state, error);
  } finally {
    if (indexState === state) state.building = false;
  }
}

/**
 * 预构建入口（openDocument 在 ready() 后调用）：不阻塞装载路径，内部自调度。
 * 已建/在建则无事发生。
 */
export function scheduleTextIndexBuild(): void {
  const state = ensureState();
  if (!state || state.done || state.building) return;
  state.building = true;
  void driveBuild(state);
}

/**
 * 确保全量索引就绪：未建/中断则（重新）驱动构建并等待完成。可重试——上一轮
 * 失败不缓存拒绝，下一次调用从已建页续建。
 */
export function ensureTextIndex(): Promise<void> {
  const state = ensureState();
  if (!state) return Promise.reject(new Error("尚未打开文档，无法建立文本索引"));
  if (state.done) return Promise.resolve();
  if (!state.building) {
    state.building = true;
    void driveBuild(state);
  }
  return new Promise<void>((resolve, reject) => {
    state.waiters.push({ resolve, reject });
  });
}

/**
 * 就绪单页索引（「当前页」范围搜索用）：不等全量构建，按需取该页文本。
 * 与后台批量构建并发时以先写者为准（互不重复计数）。
 */
export async function ensurePage(pageNumber: number): Promise<PageTextIndex | null> {
  const state = ensureState();
  if (!state) return null;
  const existing = state.pages[pageNumber - 1];
  if (existing) return existing;
  const built = await buildPage(state, pageNumber);
  if (isStale(state)) return null;
  if (state.pages[pageNumber - 1] === null) {
    state.pages[pageNumber - 1] = built;
    state.builtCount += 1;
    state.done = state.pages.every((p) => p !== null);
    writeIndexProgress(state);
  }
  return state.pages[pageNumber - 1];
}

/** 读某页的已建索引（未建/会话已变返回 null；扫描用）。 */
export function getPageIndex(pageNumber: number): PageTextIndex | null {
  return currentState()?.pages[pageNumber - 1] ?? null;
}

/** 把 PDF 用户空间矩形两角变换为 CSS 矩形（min/max 归一，旋转由 viewport 处理）。 */
function toCssRect(
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): HitRect {
  const p1 = viewport.convertToViewportPoint(x1, y1);
  const p2 = viewport.convertToViewportPoint(x2, y2);
  const left = Math.min(p1[0], p2[0]);
  const right = Math.max(p1[0], p2[0]);
  const top = Math.min(p1[1], p2[1]);
  const bottom = Math.max(p1[1], p2[1]);
  return { left, top, width: right - left, height: bottom - top };
}

/** 把单个命中区间映射为矩形列表（跨 item/跨行时每段一个矩形）。 */
function rectsForRange(
  index: PageTextIndex,
  range: { start: number; end: number },
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
): HitRect[] {
  const rects: HitRect[] = [];
  for (const item of index.items) {
    const itemEnd = item.offset + item.length;
    if (itemEnd <= range.start || item.offset >= range.end) continue;
    const a = Math.max(range.start, item.offset) - item.offset;
    const b = Math.min(range.end, itemEnd) - item.offset;
    let x1: number;
    let x2: number;
    if (item.interpolatable && item.length > 0) {
      // 段内字符位置按占整段宽度的比例线性插值（等步长游程的通行近似）。
      x1 = item.x + (a / item.length) * item.width;
      x2 = item.x + (b / item.length) * item.width;
    } else {
      x1 = item.x;
      x2 = item.x + item.width;
    }
    // PDF 用户空间 y 向上：字形约在 [基线−0.25h（降部）, 基线+0.8h（升部）]，
    // 经 viewport 的 y 翻转后即贴住文字行的 CSS 矩形。
    const h = item.height > 0 ? item.height : 8;
    const yBottom = item.y - DESCENT_RATIO * h;
    const yTop = item.y + ASCENT_RATIO * h;
    const rect = toCssRect(viewport, x1, yBottom, x2, yTop);
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  return rects;
}

/**
 * 把页内命中区间批量映射为 CSS 矩形（与文本层同 viewport 语义，技术方案 5.2
 * 第 8 条地基的直接复用）。
 *
 * 缩放契约：requestedScale 一律传 store.scale（请求缩放）——内部经
 * capScaleForRaster 封顶（与渲染队列落笔、查看器页框同式同源），返回实际
 * cssScale 供调用方对账。注意封顶计算依赖 window.devicePixelRatio，窗口跨
 * 显示器移动可能漂移一档（仅 8192 封顶生效时可见亚像素偏差，缩放/重挂载自愈）。
 */
export async function getHitRects(
  pageNumber: number,
  ranges: Array<{ start: number; end: number }>,
  requestedScale: number,
): Promise<{ cssScale: number; rects: HitRect[][] }> {
  const state = currentState();
  const index = state?.pages[pageNumber - 1] ?? null;
  if (!state || !index) throw new Error("该页文本索引尚未建立");
  const page: PDFPageProxy = await state.doc.getPage(pageNumber);
  if (currentState() !== state) throw new Error("文档已切换，命中矩形作废");
  const base = page.getViewport({ scale: 1 });
  const cssScale = capScaleForRaster(base.width, base.height, requestedScale);
  const viewport = page.getViewport({ scale: cssScale });
  return { cssScale, rects: ranges.map((range) => rectsForRange(index, range, viewport)) };
}
