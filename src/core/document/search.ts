import { useDocumentStore, type SearchResult } from "./store";
import { ensureTextIndex, ensurePage, getPageIndex, getHitRects, foldCase } from "./textIndex";

/**
 * 查询编排与命中揭示（M2 全文搜索）：
 * - runSearch：查询与选项一律取 store 当前值（唯一真源）；空查询清结果；
 *   范围=全文档先 ensureTextIndex（未就绪时进度可见），范围=当前页按需
 *   ensurePage 单页取文本；扫描分块让出主线程，查询代际令牌使新查询取代旧轮；
 * - revealSearchResult：置当前命中 → core 内算矩形 → 写 store.searchReveal
 *   （seq 递增），由查看器订阅执行「跳页 + 滚动到命中位置」（跨模块只经 store）；
 * - 索引构建的拒绝会被捕获并落为中文错误态（可重试），不会让后续搜索永久失败。
 */

/** 结果渲染上限：总数完整统计，列表超出部分截断并提示（防高频单字撑爆 DOM）。 */
const RESULT_RENDER_CAP = 1000;
/** 扫描分块：每块让出一次主线程并校验查询代际。 */
const SCAN_CHUNK = 50;
/** 摘录上下文长度（命中前后各取的字符数）。 */
const EXCERPT_CONTEXT = 32;

/** 查询代际：每次 runSearch 递增，旧轮异步步点自废（新查询取代旧轮）。 */
let searchGeneration = 0;
/** 命中揭示序号（searchReveal.seq 的来源）。 */
let revealSeq = 0;

/** 宏任务让出：扫描长文档时保持 UI 可响应。 */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 摘录用空白折叠（换行/多空格折为单空格；命中段保持原文）。 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** 在 haystack 中找 needle 的全部非重叠出现位置。 */
function findAll(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    positions.push(at);
    from = at + needle.length;
  }
  return positions;
}

/** 组装单条命中（含 pre-split 摘录，UI 直接以 mark 渲染命中段）。 */
function makeResult(pageNumber: number, start: number, length: number, text: string): SearchResult {
  const beforeFrom = Math.max(0, start - EXCERPT_CONTEXT);
  const afterTo = Math.min(text.length, start + length + EXCERPT_CONTEXT);
  return {
    id: `${pageNumber}:${start}`,
    pageNumber,
    start,
    end: start + length,
    excerptBefore:
      (beforeFrom > 0 ? "…" : "") + collapseWhitespace(text.slice(beforeFrom, start)),
    excerptMatch: text.slice(start, start + length),
    excerptAfter:
      collapseWhitespace(text.slice(start + length, afterTo)) + (afterTo < text.length ? "…" : ""),
  };
}

/** 扫描一页：命中入 results（受渲染上限），返回该页新增命中数。 */
function scanPage(
  pageNumber: number,
  needle: string,
  caseSensitive: boolean,
  results: SearchResult[],
): number {
  const index = getPageIndex(pageNumber);
  if (!index) return 0;
  const haystack = caseSensitive ? index.text : index.lowerText;
  const positions = findAll(haystack, needle);
  for (const start of positions) {
    if (results.length >= RESULT_RENDER_CAP) break;
    results.push(makeResult(pageNumber, start, needle.length, index.text));
  }
  return positions.length;
}

/**
 * 执行当前 store 中的查询（选项同取 store）。状态/结果/进度写回 store，
 * 供侧栏结果列表与查看器高亮层消费；异步步点均校验查询与会话代际。
 */
export async function runSearch(): Promise<void> {
  const generation = ++searchGeneration;
  const beginState = useDocumentStore.getState();
  const loadGeneration = beginState.loadGeneration;
  const sessionDoc = beginState.document;
  // 会话判据双检：close() 不递增 loadGeneration，须同时比对文档引用
  // （与 textIndex 的会话守卫一致），防在途轮次把结果写进已复位的 store。
  const stale = () =>
    searchGeneration !== generation ||
    useDocumentStore.getState().loadGeneration !== loadGeneration ||
    useDocumentStore.getState().document !== sessionDoc;
  const query = beginState.searchQuery.trim();
  const { searchCaseSensitive, searchScope } = beginState;
  // 不敏感模式的 needle 必须与页文本副本同用 foldCase 折叠（同为长度保持，
  // 命中偏移才与 items 偏移对齐；原样传 query 会导致含大写查询零命中）。
  const needle = searchCaseSensitive ? query : foldCase(query);

  if (!query) {
    if (stale()) return;
    useDocumentStore.setState({
      searchStatus: "idle",
      searchError: null,
      searchResults: [],
      searchTotalHits: 0,
      searchDocWithoutText: false,
      activeSearchResultId: null,
      searchIndexProgress: null,
    });
    return;
  }
  if (beginState.status !== "ready") {
    if (stale()) return;
    useDocumentStore.setState({
      searchStatus: "error",
      searchError: "尚未打开文档，无法搜索。",
      searchResults: [],
      searchTotalHits: 0,
      searchDocWithoutText: false,
    });
    return;
  }

  const results: SearchResult[] = [];
  let total = 0;
  let docWithoutText = false;
  try {
    if (searchScope === "currentPage") {
      if (stale()) return;
      // 与全文档分支一致：进入执行态，重跑期间 spinner/文案即时反馈。
      useDocumentStore.setState({ searchStatus: "searching", searchError: null });
      // 当前页范围：按需取该页文本即可，不等全量索引。
      const pageNumber = useDocumentStore.getState().currentPage;
      const index = await ensurePage(pageNumber);
      if (stale()) return;
      if (index) total = scanPage(pageNumber, needle, searchCaseSensitive, results);
    } else {
      if (stale()) return;
      useDocumentStore.setState({ searchStatus: "indexing", searchError: null });
      await ensureTextIndex();
      if (stale()) return;
      useDocumentStore.setState({ searchStatus: "searching" });
      const numPages = useDocumentStore.getState().numPages;
      for (let startPage = 1; startPage <= numPages; startPage += SCAN_CHUNK) {
        const endPage = Math.min(startPage + SCAN_CHUNK - 1, numPages);
        for (let page = startPage; page <= endPage; page += 1) {
          total += scanPage(page, needle, searchCaseSensitive, results);
          if (results.length >= RESULT_RENDER_CAP) break;
        }
        await macrotask();
        if (stale()) return;
      }
      if (total === 0) {
        // 全文档零命中：判定整册是否无文本层（扫描件），给专门空态文案。
        docWithoutText = true;
        for (let page = 1; page <= numPages; page++) {
          const index = getPageIndex(page);
          if (index === null || index.text.trim().length > 0) {
            docWithoutText = false;
            break;
          }
        }
      }
    }
    if (stale()) return;
    useDocumentStore.setState({
      searchStatus: "done",
      searchError: null,
      searchResults: results,
      searchTotalHits: total,
      searchDocWithoutText: docWithoutText,
      activeSearchResultId: null,
      searchIndexProgress: null,
    });
  } catch (error) {
    if (stale()) return; // 会话/查询已被取代：本轮静默丢弃
    useDocumentStore.setState({
      searchStatus: "error",
      searchError:
        error instanceof Error
          ? `搜索失败：${error.message}`
          : "搜索失败。",
      searchResults: [],
      searchTotalHits: 0,
      searchDocWithoutText: false,
      searchIndexProgress: null,
    });
  }
}

/**
 * 相对当前命中循环揭示（+1 下一处 / -1 上一处；无当前命中则 +1 从首条、-1 从末条
 * 开始）。F3/Shift+F3 与搜索输入框 Enter/Shift+Enter 共用；sidebar 与 viewer 的
 * 快捷键分发器都只经 core 取用，互不依赖（技术方案 4.3 规则 2）。
 */
export function revealRelativeSearchResult(offset: 1 | -1): void {
  const { searchResults, activeSearchResultId } = useDocumentStore.getState();
  if (searchResults.length === 0) return;
  const currentIndex = searchResults.findIndex((result) => result.id === activeSearchResultId);
  const nextIndex =
    currentIndex < 0
      ? offset === 1
        ? 0
        : searchResults.length - 1
      : (currentIndex + offset + searchResults.length) % searchResults.length;
  void revealSearchResult(searchResults[nextIndex].id);
}

/**
 * 揭示一条命中：置当前命中并请求查看器滚动定位（「跳页 + 滚动到命中位置 +
 * 高亮闪烁」，里程碑 M2 验收 1）。矩形以 store 当前缩放请求、由 core 按文本层
 * 同 viewport 语义计算，写入 searchReveal（seq 递增触发消费方）。
 */
export async function revealSearchResult(id: string): Promise<void> {
  const store = useDocumentStore.getState();
  const hit = store.searchResults.find((result) => result.id === id);
  if (!hit) return;
  useDocumentStore.setState({ activeSearchResultId: id });
  try {
    const { rects } = await getHitRects(
      hit.pageNumber,
      [{ start: hit.start, end: hit.end }],
      store.scale,
    );
    if (useDocumentStore.getState().activeSearchResultId !== id) return; // 已切到别的结果
    const first = rects[0]?.[0];
    if (!first) return;
    useDocumentStore.setState({
      searchReveal: {
        seq: ++revealSeq,
        page: hit.pageNumber,
        cssTop: first.top,
        cssHeight: first.height,
        cssLeft: first.left,
        cssWidth: first.width,
      },
    });
  } catch (error) {
    console.warn("定位搜索结果失败：", error);
  }
}
