// 全文搜索面板（M2-计划 D4 / T4，验收 M2-1/M2-2）：
// 查看器主区右侧可折叠面板（开合走 uiStore.searchPanelOpen，会话级瞬态），
// 消费 core 的文本索引服务（textIndex.ts，懒构建 + 进度 + 取消），自身零 pdfjs 依赖。
//
// 与查看器的联动走「模块内桥」（同 scrollBridge 模式，非全局 store）：
// - 面板把选中命中换算成页内 CSS 矩形后发布 hitFocus；
// - ViewerPage 订阅 hitFocus：滚动定位 + 在对应页项里渲染 SearchHitLayer（闪烁标识）。
// 覆盖层矩形与画布/文本层同 viewport 语义（技术方案 5.2 第 8 条），换算在 core
// 的 hitRectsToPageCss 内用页面实际 viewport 完成（含旋转/翻转），本模块只给 cssScale。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import { Search, X } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { useDocumentStore, activeTabOf } from "../../core/document/store";
import {
  ensurePageTextIndex,
  ensureTabTextIndex,
  getTabTextIndexStats,
  hitRectsToPageCss,
  searchTextIndex,
  type PageCssRect,
  type SearchHit,
  type SearchResult,
} from "../../core/document/textIndex";
import { useUiStore } from "../../shell/uiStore";
import { capScaleForRaster } from "../../core/document/renderQueue";
import "./searchPanel.css";

/** 输入防抖（ms）：打字停顿后再触发索引构建/搜索，避免每个键击一轮全册扫描。 */
const SEARCH_DEBOUNCE_MS = 250;
/** 进度刷新节流间隔（ms）：500 页逐页回调按 ~20fps 呈现，不打爆渲染。 */
const PROGRESS_THROTTLE_MS = 48;

type ScopeKind = "all" | "page";

/** 会话级输入留存（模块内单例，非全局 store）：面板收起再展开不丢关键词与开关。 */
const sessionInput = { query: "", caseSensitive: false, scopeKind: "all" as ScopeKind };

// ===== 面板 → 查看器的命中聚焦桥 =====

/** 选中命中的聚焦描述：所在页 + 该页各命中的 CSS 矩形 + 闪烁目标。 */
export interface SearchHitFocus {
  pageNumber: number;
  /** 按展示顺序排列的「每命中一组矩形」。 */
  hitRects: PageCssRect[][];
  /** 闪烁目标（hitRects 下标）。 */
  hitIndex: number;
  /** 闪烁令牌：点击命中时递增；覆盖层以之为 key 重放闪烁动画。 */
  flashToken: number;
}

let hitFocusState: SearchHitFocus | null = null;
const hitFocusListeners = new Set<() => void>();

function publishHitFocus(next: SearchHitFocus | null): void {
  hitFocusState = next;
  for (const listener of [...hitFocusListeners]) listener();
}

/** 查看器订阅命中聚焦（useSyncExternalStore 快照即模块内当前值，引用稳定）。 */
export function useSearchHitFocus(): SearchHitFocus | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      hitFocusListeners.add(onStoreChange);
      return () => {
        hitFocusListeners.delete(onStoreChange);
      };
    },
    () => hitFocusState,
  );
}

/** 搜索面板本体：输入 + 开关（大小写/范围）+ 进度 + 按页分组的结果列表。 */
export function SearchPanel() {
  const tab = useDocumentStore(activeTabOf);
  const tabId = useDocumentStore((s) => s.activeTabId);
  const status = tab.status;
  const numPages = tab.numPages;
  const currentPage = tab.currentPage;
  const scale = tab.scale;
  const pageSizes = tab.pageSizes;
  const setPanelOpen = useUiStore((s) => s.setSearchPanelOpen);

  const [query, setQuery] = useState(sessionInput.query);
  const [caseSensitive, setCaseSensitive] = useState(sessionInput.caseSensitive);
  const [scopeKind, setScopeKind] = useState<ScopeKind>(sessionInput.scopeKind);
  useEffect(() => {
    sessionInput.query = query;
    sessionInput.caseSensitive = caseSensitive;
    sessionInput.scopeKind = scopeKind;
  }, [query, caseSensitive, scopeKind]);

  const [result, setResult] = useState<SearchResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [build, setBuild] = useState<{ built: number; total: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(-1);

  const runIdRef = useRef(0);
  const lastProgressAtRef = useRef(0);
  const runNowRef = useRef<(() => void) | null>(null);
  const pendingFlashRef = useRef(false);
  const flashTokenRef = useRef(0);

  /** 会话就绪的标签 id（未就绪为 null，后续流程据此短路）。 */
  const readyTabId = status === "ready" && tabId ? tabId : null;
  const trimmed = query.trim();
  /** 范围=当前页时的目标页；全文档时恒 0（不参与依赖抖动）。 */
  const scopePage = scopeKind === "page" ? currentPage : 0;

  // 面板挂载即回放缓存进度（例如重开面板时提示「已索引 x/y 页」）。
  useEffect(() => {
    if (!tabId) return;
    const stats = getTabTextIndexStats(tabId);
    if (stats && stats.built < stats.total) setBuild(stats);
  }, [tabId]);

  // ===== 搜索编排：防抖 → 按范围 ensure 索引 → 同步搜索 =====
  // runId 作废在途轮次：输入/开关/标签/当前页任一变化即开启新一轮，
  // 旧轮次的 ensure/search 结果一律丢弃（索引构建本身在 core 单飞续跑，不浪费）。
  useEffect(() => {
    if (!readyTabId || !trimmed) {
      runIdRef.current += 1;
      runNowRef.current = null;
      setResult(null);
      setNotice(null);
      setBuild(null);
      setSearching(false);
      setSelected(-1);
      publishHitFocus(null);
      return;
    }
    const runId = ++runIdRef.current;
    setSearching(true);

    const runSearch = async () => {
      setNotice(null);
      setBuild(null); // 上一轮的全册进度先清掉：本轮可能是单页路径，不再有进度可续
      try {
        if (scopeKind === "all") {
          // 全文档：先建全册索引（时间切片不阻塞渲染，进度经 onProgress 上板）。
          const handle = ensureTabTextIndex({
            tabId: readyTabId,
            onProgress: (built, total) => {
              if (runIdRef.current !== runId) return;
              const now = performance.now();
              if (built < total && now - lastProgressAtRef.current < PROGRESS_THROTTLE_MS) return;
              lastProgressAtRef.current = now;
              setBuild({ built, total });
            },
          });
          const outcome = await handle.done;
          if (runIdRef.current !== runId) return;
          if (outcome.status !== "ready") {
            setBuild(null);
            setResult(null);
            setNotice(
              outcome.status === "cancelled"
                ? "文档已切换或关闭，本次搜索已取消。"
                : "文本索引构建失败，请重试。",
            );
            return;
          }
          setBuild(null);
        } else {
          // 当前页：只建这一页的索引，不为一次搜索扫整册。
          const ok = await ensurePageTextIndex(readyTabId, scopePage);
          if (runIdRef.current !== runId) return;
          if (!ok) {
            setResult(null);
            setNotice("当前页文本索引构建失败，请重试。");
            return;
          }
        }
        const found = searchTextIndex({
          tabId: readyTabId,
          query: trimmed,
          caseSensitive,
          scope: scopeKind === "page" ? { kind: "page", pageNumber: scopePage } : { kind: "all" },
        });
        if (runIdRef.current !== runId) return;
        if (!found) {
          setResult(null);
          setNotice("文档会话已变化，请重新搜索。");
          return;
        }
        setResult(found);
        setSelected(-1);
        publishHitFocus(null);
      } finally {
        if (runIdRef.current === runId) setSearching(false);
      }
    };

    runNowRef.current = () => void runSearch();
    const timer = window.setTimeout(() => void runSearch(), SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      runNowRef.current = null;
    };
  }, [readyTabId, trimmed, caseSensitive, scopeKind, scopePage]);

  // ===== 选中命中 → 页内 CSS 矩形 → 发布给查看器 =====
  const selectedHit = selected >= 0 && result ? result.hits[selected] ?? null : null;
  useEffect(() => {
    if (!selectedHit || !readyTabId) return;
    const size = pageSizes[selectedHit.pageNumber - 1];
    if (!size) return;
    // 与 ViewerPage 页项同源的封顶缩放：矩形才能贴住当前布局的页框。
    const cssScale = capScaleForRaster(size.width, size.height, scale);
    const flash = pendingFlashRef.current;
    pendingFlashRef.current = false;
    if (flash) flashTokenRef.current += 1;
    const flashToken = flashTokenRef.current;
    let cancelled = false;
    (async () => {
      const pageHits = (result?.hits ?? []).filter((h) => h.pageNumber === selectedHit.pageNumber);
      const hitRects: PageCssRect[][] = [];
      for (const hit of pageHits) {
        const rects = await hitRectsToPageCss({
          tabId: readyTabId,
          pageNumber: selectedHit.pageNumber,
          rects: hit.rects,
          cssScale,
        });
        if (cancelled) return;
        hitRects.push(rects ?? []);
      }
      if (cancelled) return;
      publishHitFocus({
        pageNumber: selectedHit.pageNumber,
        hitRects,
        hitIndex: pageHits.indexOf(selectedHit),
        flashToken,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHit, readyTabId, pageSizes, scale, result]);

  /** 点击结果：置选中并请求闪烁（矩形换算在上方效应里完成）。 */
  const handleHitClick = useCallback((index: number) => {
    pendingFlashRef.current = true;
    setSelected(index);
  }, []);

  // 结果按页分组（页间升序、页内出现顺序，与 core 返回顺序一致）。
  const groups = useMemo(() => {
    const out: { pageNumber: number; items: { hit: SearchHit; index: number }[] }[] = [];
    for (let index = 0; index < (result?.hits.length ?? 0); index += 1) {
      const hit = result!.hits[index];
      const last = out[out.length - 1];
      if (last && last.pageNumber === hit.pageNumber) last.items.push({ hit, index });
      else out.push({ pageNumber: hit.pageNumber, items: [{ hit, index }] });
    }
    return out;
  }, [result]);

  const countLabel =
    result && result.hits.length > 0
      ? `共 ${result.hits.length} 处 · ${result.hitPages} 页${result.truncated ? "（已截断）" : ""}`
      : "";

  return (
    <section className="search-panel" aria-label="全文搜索">
      <header className="search-panel-header">
        <Search size={14} aria-hidden />
        <span className="search-panel-title">搜索</span>
        {countLabel && <span className="search-panel-count">{countLabel}</span>}
        <IconButton icon={X} label="收起搜索面板" onClick={() => setPanelOpen(false)} />
      </header>
      <div className="search-field">
        <input
          className="search-input"
          type="text"
          aria-label="搜索关键词"
          autoFocus
          placeholder={readyTabId ? "输入关键词，Enter 立即搜索" : "打开文档后即可搜索"}
          value={query}
          disabled={!readyTabId}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runNowRef.current?.();
            }
          }}
        />
        <button
          type="button"
          className={clsx("search-toggle", caseSensitive && "search-toggle-on")}
          title="区分大小写"
          aria-pressed={caseSensitive}
          disabled={!readyTabId}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
      </div>
      <div className="search-scope-row" role="group" aria-label="搜索范围">
        <button
          type="button"
          className={clsx("search-scope", scopeKind === "all" && "search-scope-on")}
          aria-pressed={scopeKind === "all"}
          disabled={!readyTabId}
          onClick={() => setScopeKind("all")}
        >
          全文档
        </button>
        <button
          type="button"
          className={clsx("search-scope", scopeKind === "page" && "search-scope-on")}
          aria-pressed={scopeKind === "page"}
          disabled={!readyTabId}
          onClick={() => setScopeKind("page")}
        >
          当前页{numPages > 0 ? `（第 ${currentPage} 页）` : ""}
        </button>
      </div>
      {build && (
        <div className="search-progress" role="status">
          <span className="search-progress-text">
            正在建立文本索引 {build.built} / {build.total} 页…
          </span>
          <div className="search-progress-bar">
            <div
              className="search-progress-fill"
              style={{ width: `${build.total > 0 ? Math.round((build.built / build.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}
      <div className="search-results">
        {notice ? (
          <p className="search-empty">{notice}</p>
        ) : !readyTabId ? (
          <p className="search-empty">打开文档后，即可在这里全文搜索。</p>
        ) : !trimmed ? (
          <p className="search-empty">输入关键词开始搜索；结果按页分组，点击可跳转定位。</p>
        ) : build ? null : !result || searching ? (
          <p className="search-empty">正在搜索…</p>
        ) : result.hits.length === 0 ? (
          <p className="search-empty">
            {scopeKind === "page" ? `第 ${scopePage} 页未找到「${trimmed}」。` : `未找到「${trimmed}」。`}
            {caseSensitive ? " 可尝试关闭大小写开关。" : ""}
          </p>
        ) : (
          <>
            {!result.complete && (
              <p className="search-incomplete">索引未完整（范围内有页未能解析），结果可能不全。</p>
            )}
            {groups.map((group) => (
              <div key={group.pageNumber} className="search-group">
                <p className="search-group-title">第 {group.pageNumber} 页</p>
                {group.items.map(({ hit, index }) => (
                  <button
                    type="button"
                    key={index}
                    className={clsx("search-hit-item", index === selected && "search-hit-item-active")}
                    onClick={() => handleHitClick(index)}
                  >
                    <span className="search-excerpt">
                      {hit.excerptBefore}
                      <mark className="search-excerpt-mark">{hit.excerptMatch}</mark>
                      {hit.excerptAfter}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** 命中覆盖层：渲染在页项内（矩形即该页 viewport 下的 CSS 像素，点击后闪烁）。 */
export function SearchHitLayer({ focus }: { focus: SearchHitFocus }) {
  return (
    <div className="search-hit-layer" aria-hidden>
      {focus.hitRects.map((group, groupIndex) =>
        group.map((rect, rectIndex) => {
          const active = groupIndex === focus.hitIndex;
          // 激活矩形以 flashToken 入 key：令牌变化即重挂载，闪烁动画得以重放。
          return (
            <div
              key={active ? `a-${focus.flashToken}-${rectIndex}` : `${groupIndex}-${rectIndex}`}
              className={clsx("search-hit-rect", active && "search-hit-rect-active")}
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            />
          );
        }),
      )}
    </div>
  );
}
