import { create } from "zustand";
import type { PDFDocumentProxy } from "pdfjs-dist";

export type DocumentStatus = "idle" | "loading" | "ready" | "error";

/** 单页几何信息（PDF 坐标系，单位 pt，未经缩放）。 */
export interface PageSize {
  /** 页宽（pt，已按 viewport 旋转语义归一，宽度始终对应显示方向的横向边）。 */
  width: number;
  /** 页高（pt）。 */
  height: number;
  /** 页面声明旋转角（0/90/180/270，度）。 */
  rotation: number;
}

/** 书签树节点（纯数据，已把 pdf.js 目标解析为页码，侧栏免接触 pdfjs 类型）。 */
export interface OutlineNode {
  title: string;
  /** 目标页码（1 起）；外链或无法解析的目标为 null。 */
  pageNumber: number | null;
  /** 书签外链地址（url 型书签才有）。 */
  url: string | null;
  children: OutlineNode[];
}

/** 装载完成时由 openDocument 汇总的文档元数据。 */
export interface DocumentMeta {
  document: PDFDocumentProxy;
  numPages: number;
  /** 与页码一一对应（下标 0 = 第 1 页）。 */
  pageSizes: PageSize[];
  outline: OutlineNode[];
}

// ===== 全文搜索（M2）=====

/** 搜索范围（里程碑 M2 验收 2：当前页/全文档开关）。 */
export type SearchScope = "all" | "currentPage";

/** 搜索会话状态机：indexing=等索引构建，searching=扫描中。 */
export type SearchStatus = "idle" | "indexing" | "searching" | "done" | "error";

/** 单条搜索命中（纯数据，供侧栏结果列表与查看器高亮层消费）。 */
export interface SearchResult {
  /** 稳定主键：`页码:页内偏移`。 */
  id: string;
  /** 1 起。 */
  pageNumber: number;
  /** 命中在页拼接文本中的 [start, end) 字符偏移（供 core 映射命中矩形）。 */
  start: number;
  end: number;
  /** 上下文摘录（pre-split，UI 直接以 mark 渲染命中段）。 */
  excerptBefore: string;
  excerptMatch: string;
  excerptAfter: string;
}

/**
 * 命中揭示请求：core 的 revealSearchResult 写入，ViewerPage 订阅 seq 执行
 * 「跳页 + 滚动到命中位置」。跨模块数据只经本 store 下发（技术方案 4.3 规则 2），
 * 侧栏不接触查看器内部。矩形为当前缩放下的 CSS 像素（页左上原点，与文本层
 * 同坐标系），由 core 计算保证与画布/文本层同 viewport 语义。
 */
export interface SearchReveal {
  /** 单调递增序号：每次揭示递增，消费方据此触发（同值不重触发）。 */
  seq: number;
  /** 1 起。 */
  page: number;
  cssTop: number;
  cssHeight: number;
  cssLeft: number;
  cssWidth: number;
}

/**
 * 文档会话 store（技术方案模块 5）：查看器与侧栏只消费此 store 与 core 接口。
 * `document` 仅供 core 内部流转；外部请经 core 暴露的 getPage/renderPage 等接口访问。
 */
export interface DocumentSessionState {
  status: DocumentStatus;
  document: PDFDocumentProxy | null;
  /** 打开时的本地绝对路径（/viewer?path= 传入）。 */
  sourcePath: string | null;
  fileName: string | null;
  numPages: number;
  pageSizes: PageSize[];
  outline: OutlineNode[];
  /** 1 起。 */
  currentPage: number;
  /** 缩放 0.25–4.0（技术方案 5.3）。 */
  scale: number;
  error: string | null;
  /**
   * 装载代际：每次 beginLoad 递增。openDocument 用它丢弃过期装载结果，
   * 渲染队列用它作 generation token 的来源（防竞态串页，技术方案 5.2 第 6 条）。
   */
  loadGeneration: number;

  // ===== 全文搜索（M2）：查询与选项以本 store 为唯一真源，
  // 状态/结果/进度由 core 的 search 模块写入，UI 只读消费 =====
  searchQuery: string;
  searchCaseSensitive: boolean;
  searchScope: SearchScope;
  searchStatus: SearchStatus;
  searchError: string | null;
  searchResults: SearchResult[];
  /** 完整命中总数（searchResults 受渲染上限截断时此值仍为全量）。 */
  searchTotalHits: number;
  /** 全文档零命中且所有页均无文本（扫描件）：面板据此给专门空态文案。 */
  searchDocWithoutText: boolean;
  /** 文本索引构建进度（构建中才有值）。 */
  searchIndexProgress: { done: number; total: number } | null;
  activeSearchResultId: string | null;
  searchReveal: SearchReveal | null;

  beginLoad: (path: string, fileName: string) => void;
  ready: (meta: DocumentMeta) => void;
  fail: (message: string) => void;
  /** 关闭当前会话（会由 openDocument 内部负责销毁 pdf.js 文档与渲染任务）。 */
  close: () => void;
  setCurrentPage: (page: number) => void;
  setScale: (scale: number) => void;
  /** 提交搜索查询（防抖后的输入；空串即清结果）。 */
  setSearchQuery: (query: string) => void;
  /** 变更搜索选项（大小写/范围）；调用方随即以 store 当前 query 重跑（验收 2）。 */
  setSearchOptions: (options: { caseSensitive?: boolean; scope?: SearchScope }) => void;
  /** 仅供测试/复位使用。 */
  reset: () => void;
}

const initial = {
  status: "idle" as DocumentStatus,
  document: null,
  sourcePath: null,
  fileName: null,
  numPages: 0,
  pageSizes: [] as PageSize[],
  outline: [] as OutlineNode[],
  currentPage: 1,
  scale: 1,
  error: null,
  loadGeneration: 0,
  searchQuery: "",
  searchCaseSensitive: false,
  searchScope: "all" as SearchScope,
  searchStatus: "idle" as SearchStatus,
  searchError: null,
  searchResults: [] as SearchResult[],
  searchTotalHits: 0,
  searchDocWithoutText: false,
  searchIndexProgress: null,
  activeSearchResultId: null,
  searchReveal: null,
};

export const useDocumentStore = create<DocumentSessionState>((set) => ({
  ...initial,
  beginLoad: (path, fileName) =>
    set((s) => ({
      ...initial,
      loadGeneration: s.loadGeneration + 1,
      status: "loading",
      sourcePath: path,
      fileName,
    })),
  ready: (meta) =>
    set((s) => ({
      status: "ready" as DocumentStatus,
      document: meta.document,
      numPages: meta.numPages,
      pageSizes: meta.pageSizes,
      outline: meta.outline,
      currentPage: 1,
      scale: 1,
      error: null,
      loadGeneration: s.loadGeneration,
    })),
  fail: (message) =>
    set((s) => ({ ...initial, loadGeneration: s.loadGeneration, status: "error" as DocumentStatus, error: message })),
  close: () => set((s) => ({ ...initial, loadGeneration: s.loadGeneration })),
  setCurrentPage: (page) =>
    set((s) => {
      if (s.numPages <= 0) return { currentPage: 1 };
      return { currentPage: Math.min(s.numPages, Math.max(1, Math.round(page))) };
    }),
  setScale: (scale) => set({ scale: Math.min(4, Math.max(0.25, scale)) }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchOptions: (options) =>
    set((s) => ({
      searchCaseSensitive: options.caseSensitive ?? s.searchCaseSensitive,
      searchScope: options.scope ?? s.searchScope,
    })),
  reset: () => set(initial),
}));
