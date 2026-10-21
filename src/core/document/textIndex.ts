// 全文文本索引与搜索服务（M2-计划 D3 / T3，验收 M2-1、M2-2）。
//
// 设计要点：
// - 逐页 `getTextContent` 保存文本串与文本矩阵（PDF 用户空间），命中时按
//   「字符偏移 → 项内子串 → 矩形」换算出命中矩形，坐标约定与 store.ts 的
//   HighlightRect 完全一致（用户空间 pt、y 向上、未缩放），查看器覆盖层与
//   后续高亮导出共用同一坐标系，不得各自另立；
// - 懒构建 + 按标签缓存：首次搜索才建索引；缓存随标签存活，标签关闭即剔除，
//   同一标签重开文档（loadGeneration 变化 / 文档对象换代）时整册重建；
// - 时间切片：构建循环逐页 await（worker 侧解析本就不占主线程），每消耗
//   SLICE_BUDGET_MS 预算再让出一次主线程（MessageChannel 宏任务，无 setTimeout
//   的 4ms 嵌套钳制），渲染与输入始终有机会插队（M2-计划风险 2）；
// - 取消语义：不做公开的 cancel——构建随标签装载代际自动取消（isCacheStale
//   逐页校验），面板关闭不取消（缓存按标签保留，重开面板即秒搜）。
//
// 本文件对 pdfjs-dist 只有 **类型** import：文档/页代理均经 store 的标签会话
// 取得，运行时零依赖（也因此可在 Node 下直接做性能验证）。
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useDocumentStore, type HighlightRect } from "./store";

// ===== 数据结构 =====

/** 单个可搜文本项：字符串 + 文本矩阵（用户空间）+ 整串推进宽度（pt）。 */
export interface SearchTextItem {
  str: string;
  /** 6 元文本矩阵 [a,b,c,d,e,f]（用户空间，(e,f) 为基线起点）。 */
  transform: number[];
  /** str 沿 (a,b) 方向的总推进宽度（用户空间 pt）。 */
  width: number;
}

/** 单页索引：页文本 + 各项在页文本中的区间。 */
export interface PageTextIndex {
  pageNumber: number;
  /** 项串直接拼接；带 EOL 的项补 "\n"（供摘录断行，也缓解跨行误匹配）。 */
  text: string;
  /** 与 text 逐字符对齐的大小写折叠副本（长度恒等，见 foldText）。 */
  lowerText: string;
  items: SearchTextItem[];
  /** items[i] 在 text 中的起始偏移；长度 = items.length + 1（末位 = text.length）。 */
  itemOffsets: Uint32Array;
}

/** 搜索范围（M2-2：全文档 / 当前页）。 */
export type SearchScope = { kind: "all" } | { kind: "page"; pageNumber: number };

/** 单条命中：页码 + 三段式摘录（命中段单独渲染）+ 命中矩形组。 */
export interface SearchHit {
  pageNumber: number;
  excerptBefore: string;
  excerptMatch: string;
  excerptAfter: string;
  /** 用户空间 pt（约定同 HighlightRect；空数组 = 纯换行等无几何命中）。 */
  rects: HighlightRect[];
}

export interface SearchResult {
  query: string;
  caseSensitive: boolean;
  scope: SearchScope;
  /** 按页组织：页间按页码升序，页内按出现顺序。 */
  hits: SearchHit[];
  /** 有命中的页数（去重）。 */
  hitPages: number;
  /** 范围内索引是否完整（false = 有页未建索引，结果可能不全）。 */
  complete: boolean;
  /** 是否因命中数超出 MAX_TOTAL_HITS 而截断。 */
  truncated: boolean;
}

/** 全册命中上限：防御性截断（如单字母关键词在 500 页文档里的上万命中）。 */
export const MAX_TOTAL_HITS = 2000;

/** 单页构建失败不拖垮整册：该页按无文本落空，构建继续（详见构建循环注释）。 */
export type TextIndexOutcome =
  | { status: "ready" }
  | { status: "cancelled" }
  | { status: "failed"; error: unknown };

type ProgressListener = (built: number, total: number) => void;

/** 单标签的索引缓存：文档代理 + 装载代际共同决定缓存有效性。 */
interface TabIndexCache {
  doc: PDFDocumentProxy;
  generation: number;
  numPages: number;
  pages: (PageTextIndex | null)[];
  /** 已构建页数（含失败落空页；单页 ensure 不推进此口径）。 */
  builtCount: number;
  flight: BuildFlight | null;
}

/** 进行中的全量构建（单飞：同标签同代际的 ensure 复用同一任务）。 */
interface BuildFlight {
  generation: number;
  listeners: Set<ProgressListener>;
  done: Promise<TextIndexOutcome>;
}

const tabCaches = new Map<string, TabIndexCache>();

/** 时间切片预算（ms）：超过即让出主线程一次。12ms 兼顾吞吐与掉帧风险。 */
const SLICE_BUDGET_MS = 12;

// ===== 缓存生命周期 =====

/**
 * 标签关闭即剔除其索引缓存（内存口径与 pdf.js 文档销毁对齐——文档已在
 * closeDocument 销毁，留着页文本除延迟回收外无意义）。订阅副作用与
 * shell/uiStore 的模块级副作用同风格。
 */
useDocumentStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  for (const id of [...tabCaches.keys()]) {
    if (!state.tabs.some((t) => t.id === id)) tabCaches.delete(id);
  }
});

/** 标签会话是否已换代（关闭/重开/文档替换）：换代后旧缓存与在途构建全部作废。 */
function isCacheStale(tabId: string, cache: TabIndexCache): boolean {
  const tab = useDocumentStore.getState().tabs.find((t) => t.id === tabId);
  return !tab || tab.status !== "ready" || tab.document !== cache.doc || tab.loadGeneration !== cache.generation;
}

/**
 * 取该标签当前可用的缓存；不可用（无标签/未就绪）返回 null，
 * 已换代则整册重建（旧缓存对象作废，仍在跑的旧构建会经 isCacheStale 自行取消）。
 */
function prepareCache(tabId: string): TabIndexCache | null {
  const tab = useDocumentStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || tab.status !== "ready" || !tab.document || tab.numPages <= 0) return null;
  const cached = tabCaches.get(tabId);
  if (cached && cached.doc === tab.document && cached.generation === tab.loadGeneration) return cached;
  const cache: TabIndexCache = {
    doc: tab.document,
    generation: tab.loadGeneration,
    numPages: tab.numPages,
    pages: new Array<PageTextIndex | null>(tab.numPages).fill(null),
    builtCount: 0,
    flight: null,
  };
  tabCaches.set(tabId, cache);
  return cache;
}

/** 让出主线程一次（MessageChannel 宏任务）：渲染/输入可插队，且不受定时器钳制。 */
function yieldToMain(): Promise<void> {
  return new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

// ===== 索引构建 =====

export interface TextIndexEnsureHandle {
  done: Promise<TextIndexOutcome>;
  /** 摘除进度监听（面板卸载时调用；不影响构建本身）。 */
  detach: () => void;
}

/** 供面板初始化展示缓存进度（如重开面板时「已索引 x/y 页」）。 */
export function getTabTextIndexStats(tabId: string): { built: number; total: number } | null {
  const cache = tabCaches.get(tabId);
  if (!cache) return null;
  return { built: cache.builtCount, total: cache.numPages };
}

/**
 * 确保激活文档的**全册**文本索引就绪（懒构建入口）：
 * 已完整 → 立即 ready；构建中 → 挂到同一单飞任务（新监听立即回放当前进度）；
 * 未开始 → 启动时间切片逐页构建，进度按页回调（已建页数/总页数）。
 * 构建随标签代际自动取消；面板关闭不取消（缓存按标签保留）。
 */
export function ensureTabTextIndex(params: {
  tabId: string;
  onProgress?: ProgressListener;
}): TextIndexEnsureHandle {
  const { tabId, onProgress } = params;
  const cache = prepareCache(tabId);
  if (!cache) {
    // 无标签会话（面板在空态渲染等场景）：按取消结算，调用方展示可读提示。
    return { done: Promise.resolve({ status: "cancelled" as const }), detach: () => undefined };
  }
  if (cache.builtCount >= cache.numPages) {
    return { done: Promise.resolve({ status: "ready" as const }), detach: () => undefined };
  }
  if (cache.flight && cache.flight.generation === cache.generation) {
    const flight = cache.flight;
    if (onProgress) {
      flight.listeners.add(onProgress);
      onProgress(cache.builtCount, cache.numPages); // 晚到的订阅者立即看到当前进度
    }
    return { done: flight.done, detach: () => flight.listeners.delete(onProgress ?? noop) };
  }

  const listeners = new Set<ProgressListener>();
  if (onProgress) listeners.add(onProgress);
  const flight: BuildFlight = { generation: cache.generation, listeners, done: Promise.resolve({ status: "ready" }) };
  cache.flight = flight;
  if (onProgress) onProgress(cache.builtCount, cache.numPages);

  flight.done = (async (): Promise<TextIndexOutcome> => {
    const finish = () => {
      if (cache.flight === flight) cache.flight = null;
      listeners.clear();
    };
    const notify = (built: number) => {
      for (const listener of [...listeners]) listener(built, cache.numPages);
    };
    try {
      let sliceStart = performance.now();
      // 从已建高水位继续（上次构建被取消后可续建）；循环内跳过已被单页
      // ensure 提前建好的页，保证 builtCount 单调且无重复解析。
      for (let pageNumber = cache.builtCount + 1; pageNumber <= cache.numPages; pageNumber += 1) {
        if (isCacheStale(tabId, cache)) {
          finish();
          return { status: "cancelled" };
        }
        if (!cache.pages[pageNumber - 1]) {
          try {
            const page = await cache.doc.getPage(pageNumber);
            const content = await page.getTextContent();
            if (isCacheStale(tabId, cache)) {
              finish();
              return { status: "cancelled" };
            }
            cache.pages[pageNumber - 1] = buildPageIndex(pageNumber, content.items);
          } catch (error) {
            // 代际未变而取页/抽文本失败：单页落空（按无文本处理），
            // 不让一页的损坏拖垮整册索引；真正换代的情况已在上方拦截。
            console.warn(`第 ${pageNumber} 页文本索引构建失败：`, error);
          }
        }
        cache.builtCount = pageNumber;
        notify(pageNumber);
        if (performance.now() - sliceStart >= SLICE_BUDGET_MS) {
          await yieldToMain();
          sliceStart = performance.now();
        }
      }
      finish();
      return { status: "ready" };
    } catch (error) {
      finish();
      return { status: "failed", error };
    }
  })();

  return { done: flight.done, detach: () => listeners.delete(onProgress ?? noop) };
}

function noop(): void {}

/**
 * 取一页的文本项几何（M5 编辑双击命中用）：必要时建单页索引，返回该页
 * 全部文本项（str + 用户空间矩阵 + 推进宽度）。标签不可用/换代/该页无文本
 * 返回 null 或空数组。与搜索共用同一份缓存（不重复解析）。
 */
export async function getPageTextItems(tabId: string, pageNumber: number): Promise<readonly SearchTextItem[] | null> {
  const cache = prepareCache(tabId);
  if (!cache) return null;
  const page = Math.min(Math.max(1, Math.round(pageNumber)), cache.numPages);
  if (!cache.pages[page - 1]) {
    const built = await ensurePageTextIndex(tabId, page);
    if (!built) return null;
  }
  const after = tabCaches.get(tabId);
  if (!after || after !== cache || isCacheStale(tabId, cache)) return null;
  return cache.pages[page - 1]?.items ?? null;
}

/**
 * 只建单页索引（范围=当前页时避免为一次搜索建整册）：返回 false 表示
 * 标签不可用或该页构建失败。与全量构建互不冲突（全量循环会跳过已建页）。
 */
export async function ensurePageTextIndex(tabId: string, pageNumber: number): Promise<boolean> {
  const cache = prepareCache(tabId);
  if (!cache) return false;
  const page = Math.min(Math.max(1, Math.round(pageNumber)), cache.numPages);
  if (cache.pages[page - 1]) return true;
  if (isCacheStale(tabId, cache)) return false;
  try {
    const proxy = await cache.doc.getPage(page);
    const content = await proxy.getTextContent();
    if (isCacheStale(tabId, cache)) return false;
    if (!cache.pages[page - 1]) cache.pages[page - 1] = buildPageIndex(page, content.items);
    return true;
  } catch (error) {
    console.warn(`第 ${page} 页文本索引构建失败：`, error);
    return false;
  }
}

// ===== 索引构建（纯函数部分） =====

/**
 * pdf.js 文本项的最小结构收窄（官方类型未从包入口导出 TextItem，
 * 且 items 联合了 marked content 项；按实际字段守卫，同 outline.ts 的处理）。
 */
function isRawTextItem(raw: unknown): raw is { str: string; hasEOL: boolean; transform: number[]; width: number } {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.str === "string" &&
    typeof r.width === "number" &&
    Array.isArray(r.transform) &&
    r.transform.length >= 6 &&
    r.transform.every((n) => typeof n === "number")
  );
}

/** 把一页 getTextContent 的 items 拼成可搜索引（纯函数，永不抛出）。 */
function buildPageIndex(pageNumber: number, rawItems: ReadonlyArray<unknown>): PageTextIndex {
  const items: SearchTextItem[] = [];
  const offsets: number[] = [];
  let text = "";
  for (const raw of rawItems) {
    if (!isRawTextItem(raw)) continue; // marked content 等无 str 项
    offsets.push(text.length);
    text += raw.str;
    if (raw.hasEOL) text += "\n";
    items.push({ str: raw.str, transform: raw.transform, width: raw.width });
  }
  offsets.push(text.length);
  return {
    pageNumber,
    text,
    lowerText: foldText(text),
    items,
    itemOffsets: Uint32Array.from(offsets),
  };
}

/**
 * 大小写折叠（用于不敏感匹配）：逐码点 toLowerCase，折叠后 UTF-16 长度
 * 变化的位置（如土耳其 İ 折成两码元）保留原字符——保证与原文逐位对齐，
 * 命中偏移才能直接映射回原文与矩形换算。
 */
function foldText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i) ?? text.charCodeAt(i);
    const ch = String.fromCodePoint(codePoint);
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
    i += ch.length;
  }
  return out;
}

// ===== 搜索 =====

/**
 * 同步搜索已建索引（通常在 ensure 之后调用）：
 * 返回 null 表示该标签无缓存（尚未 ensure 或标签已换代）；
 * 空关键词返回空结果；范围=当前页只查该页，范围=全文档需索引完整
 * （complete=false 时结果可能不全，调用方可据此提示）。
 */
export function searchTextIndex(params: {
  tabId: string;
  query: string;
  caseSensitive?: boolean;
  scope?: SearchScope;
}): SearchResult | null {
  const { tabId, query } = params;
  const caseSensitive = params.caseSensitive ?? false;
  const scope = params.scope ?? { kind: "all" as const };
  const cache = tabCaches.get(tabId);
  if (!cache) return null;
  // 换代缓存直接视为无索引（下一次 ensure 会重建，这里不做副作用式自愈）。
  if (isCacheStale(tabId, cache)) return null;

  const scopePage = scope.kind === "page" ? Math.min(Math.max(1, Math.round(scope.pageNumber)), cache.numPages) : 0;
  const complete =
    scope.kind === "page" ? cache.pages[scopePage - 1] !== undefined : cache.builtCount >= cache.numPages;

  const needle = (caseSensitive ? query : foldText(query)).replace(/\n/g, " ");
  const empty: SearchResult = { query, caseSensitive, scope, hits: [], hitPages: 0, complete, truncated: false };
  if (needle.length === 0) return empty;

  const from = scope.kind === "page" ? scopePage : 1;
  const to = scope.kind === "page" ? scopePage : cache.numPages;
  const hits: SearchHit[] = [];
  let truncated = false;
  let lastHitPage = 0;
  let hitPages = 0;
  for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
    const index = cache.pages[pageNumber - 1];
    if (!index) continue; // 未建页（不应出现在 ensure 之后，防御性跳过）
    const haystack = caseSensitive ? index.text : index.lowerText;
    let cursor = 0;
    for (;;) {
      const at = haystack.indexOf(needle, cursor);
      if (at < 0) break;
      if (hits.length >= MAX_TOTAL_HITS) {
        truncated = true;
        break;
      }
      hits.push(makeHit(index, at, at + needle.length));
      if (pageNumber !== lastHitPage) {
        hitPages += 1;
        lastHitPage = pageNumber;
      }
      cursor = at + needle.length; // 不重叠匹配
    }
    if (truncated) break;
  }
  return { query, caseSensitive, scope, hits, hitPages, complete, truncated };
}

/** 摘录窗口：命中前 24 字符、后 36 字符（肉眼定位够用，列表不换行爆版）。 */
const EXCERPT_BEFORE = 24;
const EXCERPT_AFTER = 36;

/** 摘录里的空白折叠（换行/多空格 → 单空格），超窗以省略号示意。 */
function excerptPart(text: string, start: number, end: number, ellipsis: boolean): string {
  const part = text.slice(start, end).replace(/\s+/g, " ");
  return ellipsis ? `…${part}` : part;
}

function makeHit(index: PageTextIndex, start: number, end: number): SearchHit {
  return {
    pageNumber: index.pageNumber,
    excerptBefore: excerptPart(index.text, Math.max(0, start - EXCERPT_BEFORE), start, start > EXCERPT_BEFORE),
    excerptMatch: index.text.slice(start, end).replace(/\s+/g, " "),
    excerptAfter: excerptPart(index.text, end, Math.min(index.text.length, end + EXCERPT_AFTER), end + EXCERPT_AFTER < index.text.length),
    rects: hitRectsOfRange(index, start, end),
  };
}

// ===== 命中 → 矩形 =====

/** 命中盒的升部/降部占字高比例：略放大（0.8+0.25）保证低对比度下可见。 */
const TEXT_ASCENT_RATIO = 0.8;
const TEXT_DESCENT_RATIO = 0.25;

/** 把页文本区间 [start,end) 映射为各覆盖项的子串矩形（用户空间，AABB）。 */
function hitRectsOfRange(index: PageTextIndex, start: number, end: number): HighlightRect[] {
  const rects: HighlightRect[] = [];
  const { items, itemOffsets } = index;
  // 二分找起始项：最大的 i 满足 offsets[i] <= start。
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (itemOffsets[mid] <= start) lo = mid + 1;
    else hi = mid - 1;
  }
  for (let i = Math.max(0, hi); i < items.length; i += 1) {
    const itemStart = itemOffsets[i];
    if (itemStart >= end) break;
    const rect = subItemRect(items[i], Math.max(0, start - itemStart), end - itemStart);
    if (rect) rects.push(rect);
  }
  return rects;
}

/** 项内子串 [charStart,charEnd) 的矩形：按「每字符等宽推进」近似（高亮定位足够）。 */
function subItemRect(item: SearchTextItem, charStart: number, charEnd: number): HighlightRect | null {
  const length = item.str.length;
  const cs = Math.max(0, Math.min(charStart, length));
  const ce = Math.max(0, Math.min(charEnd, length));
  if (ce <= cs || length === 0 || !(item.width > 0)) return null;
  // 矩阵缺位的防御默认值（isRawTextItem 已保证 6 元，双保险）。
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform;
  const advance = Math.hypot(a, b);
  const dirX = advance > 0 ? a / advance : 1;
  const dirY = advance > 0 ? b / advance : 0;
  const fontHeight = Math.hypot(c, d);
  if (!(fontHeight > 0)) return null;
  const upX = c / fontHeight; // 基线 → 升线方向（旋转/镜像文本同样成立）
  const upY = d / fontHeight;
  const perChar = item.width / length;
  const sx = e + dirX * perChar * cs;
  const sy = f + dirY * perChar * cs;
  const ex = e + dirX * perChar * ce;
  const ey = f + dirY * perChar * ce;
  const descent = fontHeight * TEXT_DESCENT_RATIO;
  const ascent = fontHeight * TEXT_ASCENT_RATIO;
  // 四角取包围盒：viewport 变换是 90° 整数倍旋转 + 翻转，AABB 在用户空间先取
  // 一次即可（旋转文本的斜盒也以 AABB 近似，闪烁标识用途下可接受）。
  const x1 = Math.min(sx, ex) + Math.min(upX * descent, -upX * ascent);
  const x2 = Math.max(sx, ex) + Math.max(upX * descent, -upX * ascent);
  const y1 = Math.min(sy, ey) + Math.min(upY * descent, -upY * ascent);
  const y2 = Math.max(sy, ey) + Math.max(upY * descent, -upY * ascent);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ===== 矩形 → 页内 CSS 像素（供查看器覆盖层） =====

/** 页内 CSS 像素矩形（相对页项左上角，与画布/文本层同 viewport 语义）。 */
export interface PageCssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 把用户空间命中矩形换算为页内 CSS 像素：viewport 取 `getViewport({ scale: cssScale })`
 * （cssScale 必须与查看器页项实际使用的封顶缩放一致——capScaleForRaster 的结果），
 * 两个对角点经 viewport 变换后取 min/max（技术方案 5.2 第 8 条：与画布同源）。
 * 返回 null 表示标签不可用或换算失败（文档已销毁等）。
 */
export async function hitRectsToPageCss(params: {
  tabId: string;
  pageNumber: number;
  rects: readonly HighlightRect[];
  cssScale: number;
}): Promise<PageCssRect[] | null> {
  const { tabId, pageNumber, rects, cssScale } = params;
  const tab = useDocumentStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || !tab.document) return null;
  try {
    const page = await tab.document.getPage(pageNumber);
    // await 期间标签可能关闭/重开：文档代理换代即放弃本轮换算。
    const after = useDocumentStore.getState().tabs.find((t) => t.id === tabId);
    if (!after || after.document !== tab.document) return null;
    const viewport = page.getViewport({ scale: cssScale });
    return rects.map((r) => {
      const p1 = viewport.convertToViewportPoint(r.x, r.y);
      const p2 = viewport.convertToViewportPoint(r.x + r.width, r.y + r.height);
      const left = Math.min(p1[0], p2[0]);
      const right = Math.max(p1[0], p2[0]);
      const top = Math.min(p1[1], p2[1]);
      const bottom = Math.max(p1[1], p2[1]);
      return { left, top, width: right - left, height: bottom - top };
    });
  } catch (error) {
    console.warn(`第 ${pageNumber} 页命中矩形换算失败：`, error);
    return null;
  }
}
