import { useEffect, useRef, useState } from "react";
import { CaseSensitive, Search, X } from "lucide-react";
import clsx from "clsx";
import { revealRelativeSearchResult, revealSearchResult, runSearch } from "../../core/document/search";
import { useDocumentStore, type SearchScope } from "../../core/document/store";
import { escapeFromEditable, useUiStore } from "../../shell/uiStore";

/**
 * 全文搜索面板（M2，里程碑验收 1/2）：
 * - 查询与选项（区分大小写、当前页/全文档）以 core 的文档会话 store 为唯一
 *   真源，本地 state 仅暂存未提交的输入；选项变更即以当前 query 自动重跑；
 * - 输入防抖 300ms 提交，回车立即；空查询清结果；
 * - 进度行随搜索状态机（indexing/searching/done/error）展示，索引进度
 *   「x/y 页」来自 core 构建器；
 * - 结果列表：页码 + 上下文摘录（命中段 mark）；点击调 core 的
 *   revealSearchResult（跳页/滚动/闪烁经 core store 下发，本模块不接触 viewer）。
 */

/** 输入防抖（毫秒）。 */
const INPUT_DEBOUNCE_MS = 300;

export function SearchPanel() {
  const status = useDocumentStore((s) => s.status);
  const searchQuery = useDocumentStore((s) => s.searchQuery);
  const caseSensitive = useDocumentStore((s) => s.searchCaseSensitive);
  const scope = useDocumentStore((s) => s.searchScope);
  const searchStatus = useDocumentStore((s) => s.searchStatus);
  const searchError = useDocumentStore((s) => s.searchError);
  const results = useDocumentStore((s) => s.searchResults);
  const totalHits = useDocumentStore((s) => s.searchTotalHits);
  const docWithoutText = useDocumentStore((s) => s.searchDocWithoutText);
  const indexProgress = useDocumentStore((s) => s.searchIndexProgress);
  const activeResultId = useDocumentStore((s) => s.activeSearchResultId);
  const loadGeneration = useDocumentStore((s) => s.loadGeneration);
  const searchFocusRequest = useUiStore((s) => s.searchFocusRequest);

  const [input, setInput] = useState(searchQuery);
  /** 已提交到 store 的查询快照（防抖去重）。 */
  const committedRef = useRef(searchQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 页签切入/挂载即聚焦输入。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Ctrl+F 聚焦请求（序号递增）：页签已是 search 时也重聚焦并全选
  // （补足仅挂载时聚焦的缺口，M2 阅读模式）。
  useEffect(() => {
    if (searchFocusRequest === 0) return;
    const inputEl = inputRef.current;
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  }, [searchFocusRequest]);

  // 输入防抖：提交到 store（唯一真源）并触发搜索。
  useEffect(() => {
    if (input === committedRef.current) return;
    const timer = window.setTimeout(() => {
      committedRef.current = input;
      useDocumentStore.getState().setSearchQuery(input);
      void runSearch();
    }, INPUT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input]);

  // 会话切换/复位：本地输入随 store 清空，未提交的防抖一并作废。
  useEffect(() => {
    const query = useDocumentStore.getState().searchQuery;
    committedRef.current = query;
    setInput(query);
  }, [loadGeneration]);

  const submit = () => {
    committedRef.current = input;
    useDocumentStore.getState().setSearchQuery(input);
    void runSearch();
  };

  const clearInput = () => {
    setInput("");
    committedRef.current = "";
    useDocumentStore.getState().setSearchQuery("");
    void runSearch();
    inputRef.current?.focus();
  };

  /** 选项变更：写入 store 后以当前 query 立即重跑（验收 2）。 */
  const setCaseSensitive = (next: boolean) => {
    useDocumentStore.getState().setSearchOptions({ caseSensitive: next });
    if (useDocumentStore.getState().searchQuery.trim()) void runSearch();
  };
  const setScope = (next: SearchScope) => {
    if (next === scope) return;
    useDocumentStore.getState().setSearchOptions({ scope: next });
    if (useDocumentStore.getState().searchQuery.trim()) void runSearch();
  };

  if (status !== "ready") {
    return <p className="sidebar-empty">打开文档后可在此搜索全文。</p>;
  }

  const statusText = (() => {
    if (searchStatus === "indexing") {
      return indexProgress ? `正在建立文本索引 ${indexProgress.done}/${indexProgress.total} 页…` : "正在建立文本索引…";
    }
    if (searchStatus === "searching") return "正在搜索…";
    if (searchStatus === "error") return searchError ?? "搜索失败。";
    if (searchStatus === "done") {
      if (totalHits === 0) {
        return docWithoutText
          ? "本文档没有可搜索的文本（可能为扫描件，OCR 属后置能力）。"
          : "没有找到匹配的结果。";
      }
      const pageText =
        scope === "currentPage" && results.length > 0 ? `，第 ${results[0].pageNumber} 页` : "";
      return `共 ${totalHits} 个结果${pageText}`;
    }
    return null;
  })();
  const busy = searchStatus === "indexing" || searchStatus === "searching";

  return (
    <div className="search-panel" aria-label="全文搜索">
      <div className="search-input-row">
        <Search size={14} className="search-input-icon" aria-hidden />
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="搜索全文…"
          aria-label="搜索关键词"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Enter 语义：query 与已提交一致且已有结果 → 揭示下一处（Shift=上一处），
              // 输入框内即可完成命中遍历；query 已变则提交重跑。
              const s = useDocumentStore.getState();
              if (input === s.searchQuery && s.searchStatus === "done" && s.searchResults.length > 0) {
                revealRelativeSearchResult(e.shiftKey ? -1 : 1);
              } else {
                submit();
              }
            }
            if (e.key === "Escape") {
              if (input) clearInput();
              // 无可清内容：交还焦点；沉浸下退出沉浸（逃生通道）。
              else escapeFromEditable(e.currentTarget);
            }
          }}
        />
        {input && (
          <button type="button" className="search-clear" aria-label="清空搜索" onClick={clearInput}>
            <X size={12} aria-hidden />
          </button>
        )}
      </div>

      <div className="search-options-row" role="group" aria-label="搜索选项">
        <button
          type="button"
          className={clsx("search-toggle", { active: caseSensitive })}
          aria-pressed={caseSensitive}
          title="区分大小写"
          aria-label="区分大小写"
          onClick={() => setCaseSensitive(!caseSensitive)}
        >
          <CaseSensitive size={14} aria-hidden />
        </button>
        <div className="search-scope" role="group" aria-label="搜索范围">
          <button
            type="button"
            className={clsx("search-scope-btn", { active: scope === "all" })}
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            全文档
          </button>
          <button
            type="button"
            className={clsx("search-scope-btn", { active: scope === "currentPage" })}
            aria-pressed={scope === "currentPage"}
            onClick={() => setScope("currentPage")}
          >
            当前页
          </button>
        </div>
      </div>

      {statusText && (
        <p className={clsx("search-status", { "is-error": searchStatus === "error" })}>
          {busy && <span className="search-spinner" aria-hidden />}
          {statusText}
        </p>
      )}

      {searchStatus === "done" && results.length > 0 && (
        <div className="search-result-list" role="list">
          {results.map((hit) => (
            <button
              key={hit.id}
              type="button"
              role="listitem"
              className={clsx("search-result-item", { active: hit.id === activeResultId })}
              title={`跳到第 ${hit.pageNumber} 页的命中位置`}
              onClick={() => void revealSearchResult(hit.id)}
            >
              <span className="search-result-page">第 {hit.pageNumber} 页</span>
              <span className="search-result-excerpt">
                {hit.excerptBefore}
                <mark>{hit.excerptMatch}</mark>
                {hit.excerptAfter}
              </span>
            </button>
          ))}
          {totalHits > results.length && (
            <p className="search-result-more">共 {totalHits} 个命中，仅显示前 {results.length} 条。</p>
          )}
        </div>
      )}
    </div>
  );
}
