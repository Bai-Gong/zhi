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

/**
 * 高亮矩形：**PDF 用户空间坐标，单位 pt**（M2-计划 D5 三层模型的中间层，
 * 查看器覆盖层与 pdf-lib 导出共用这一个定义，两侧不得各自另立坐标系）。
 *
 * 换算约定：
 * - 原点在页面左下角，x 向右、y 向上；数值未经缩放，也不做 /Rotate 旋转归一
 *   （即 PDF 规范意义上的用户空间，与 pdf.js `getViewport({ scale: 1 })` 的
 *   基准尺寸同源）；
 * - **查看器覆盖层**（屏幕 CSS 像素）：
 *   `page.getViewport({ scale }).convertToViewportRectangle([x, y, x + width, y + height])`
 *   一次完成缩放、y 翻转与页面旋转，输出为 [x1, y1, x2, y2]，再取
 *   min/max 归一四角即可定位 div（与文本层/画布同 viewport，技术方案 5.2 第 8 条）；
 * - **pdf-lib 导出**：pdf-lib 同为用户空间且 y 向上，直接以
 *   `(x, y)` 与 `width × height` 画半透明矩形即可，无需翻转；页面带 /Rotate 时
 *   由导出侧按页面旋转角统一归一（M2-计划风险 4）；
 * - 同一高亮内的多个矩形来自一次选区拆出的连续行块，渲染与导出都按数组顺序叠加。
 */
export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 批注高亮对象（M2 范围：仅会话内有效，跨会话持久化不在本阶段）。
 * 每条高亮归属一个标签会话，随标签关闭一并丢弃。
 */
export interface Highlight {
  /** 会话内唯一标识（store 生成）。 */
  id: string;
  /** 1 起页码。 */
  pageNumber: number;
  /** 选区拆出的矩形组（PDF 用户空间 pt，见 {@link HighlightRect}）。 */
  rects: HighlightRect[];
  /** CSS 颜色字符串（约定 `#RRGGBB`：覆盖层直接使用，导出侧解析为 RGB）。 */
  color: string;
}

/** 标签数量上限（M2-计划 D1：超出由 openDocument 拒绝并给出可读提示）。 */
export const MAX_TABS = 8;

/**
 * 单个标签的文档会话（M2-计划 D1）：路径、页码、缩放、pdf.js 文档与高亮集
 * 全部按标签隔离。`document` 仅供 core 内部流转；外部请经 core 暴露的
 * getPage/renderPage 等接口访问。
 */
export interface TabSession {
  id: string;
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
   * 装载代际（**按标签隔离**，与其他标签互不相干）：该标签每次重新装载递增。
   * openDocument 用它丢弃该标签自己的过期装载结果；渲染队列取「激活标签」的
   * 代际作 generation token（防竞态串页，技术方案 5.2 第 6 条）。
   */
  loadGeneration: number;
  /** 本标签的高亮集（M2-3；store 侧就绪，覆盖层 UI 由后续任务接）。 */
  highlights: Highlight[];
}

/**
 * 文档会话 store（技术方案模块 5）：多标签模型（`tabs` + `activeTabId`），
 * 查看器与侧栏只消费此 store 与 core 接口。
 * 会话级动作（翻页/缩放/高亮）一律作用于**激活标签**——与「本阶段应用呈现为
 * 单标签、数据模型按多标签」的迁移策略一致，标签条 UI（M2 T9）接入时无需再改消费方。
 */
export interface DocumentStoreState {
  tabs: TabSession[];
  activeTabId: string | null;
  /**
   * 与标签会话无关的「打开被拒」提示（如标签达到上限）：不影响任何既有标签的
   * 状态，由查看器以横幅呈现；下一次 beginLoadTab 或手动忽略时清除。
   * 装载失败（损坏/加密等）走标签自身的 error 状态，不经此字段。
   */
  openRejection: string | null;

  /**
   * 新建标签并开始装载（激活之）；同路径标签已存在时**原地重置重开**
   * （保留标签 id、递增其 loadGeneration），避免不可见的重复标签泄漏文档。
   * 返回标签 id。标签上限检查归 openDocument（需要区分新建/重开）。
   */
  beginLoadTab: (path: string, fileName: string) => string;
  /** 激活一个标签（保留其页码/缩放/高亮等会话状态）。 */
  activateTab: (id: string) => void;
  /** 装载成功：写入元数据并回到第 1 页（M1 重开语义保持）。 */
  readyTab: (id: string, meta: DocumentMeta) => void;
  /** 装载失败：该标签置错误态（复位会话数据，但保留 loadGeneration 与 sourcePath/fileName）。 */
  failTab: (id: string, message: string) => void;
  /**
   * 摘除一个标签（激活标签被关闭时移交给邻位标签）。
   * 只管数据；pdf.js 资源的销毁（page.cleanup + 文档销毁）由 openDocument.ts
   * 的 closeDocument 编排——store 动作保持同步纯数据，杜绝「引用先丢、资源不释放」。
   */
  closeTab: (id: string) => void;
  /** 翻页（作用于激活标签；1 起，按页数夹取）。 */
  setCurrentPage: (page: number) => void;
  /** 缩放（作用于激活标签；0.25–4.0 夹取）。 */
  setScale: (scale: number) => void;
  /** 新增高亮到激活标签；无就绪会话或矩形组为空时返回 null。 */
  addHighlight: (input: { pageNumber: number; rects: HighlightRect[]; color: string; id?: string }) => Highlight | null;
  /** 按 id 移除激活标签的一条高亮。 */
  removeHighlight: (id: string) => void;
  /** 改激活标签一条高亮的颜色。 */
  setHighlightColor: (id: string, color: string) => void;
  /** 清空激活标签的高亮。 */
  clearHighlights: () => void;
  /** 记录一次打开拒绝（openDocument 用，标签上限等）。 */
  rejectOpen: (message: string) => void;
  /** 忽略打开拒绝横幅。 */
  dismissOpenRejection: () => void;
  /** 仅供测试/复位使用（不销毁 pdf.js 资源）。 */
  reset: () => void;
}

function blankTab(id: string): TabSession {
  return {
    id,
    status: "idle",
    document: null,
    sourcePath: null,
    fileName: null,
    numPages: 0,
    pageSizes: [],
    outline: [],
    currentPage: 1,
    scale: 1,
    error: null,
    loadGeneration: 0,
    highlights: [],
  };
}

/** 无标签时的只读哨兵会话：消费方免判空，选择器始终拿到稳定引用（不触发多余渲染）。 */
const IDLE_SESSION: TabSession = Object.freeze(blankTab(""));

/** 取激活标签；无标签时返回只读哨兵（stable 引用，供选择器与 getState 共用）。 */
export function activeTabOf(state: DocumentStoreState): TabSession {
  return state.tabs.find((t) => t.id === state.activeTabId) ?? IDLE_SESSION;
}

/** 标签 id：应用会话内单调递增即可（标签不持久化，无跨会话唯一性要求）。 */
let tabSequence = 0;
function makeTabId(): string {
  tabSequence += 1;
  return `tab-${tabSequence}`;
}

/** 高亮 id：优先 uuid（Tauri WebView2 为安全上下文），老环境退化为时间戳+序号。 */
let highlightSequence = 0;
function makeHighlightId(): string {
  highlightSequence += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `highlight-${Date.now().toString(36)}-${highlightSequence}`;
}

/** 只更新指定标签的字段（不可变更新，其余标签对象原样保留，选择器按引用判等）。 */
function patchTab(state: DocumentStoreState, id: string, patch: (tab: TabSession) => Partial<TabSession>): TabSession[] {
  return state.tabs.map((t) => (t.id === id ? { ...t, ...patch(t) } : t));
}

export const useDocumentStore = create<DocumentStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  openRejection: null,

  beginLoadTab: (path, fileName) => {
    const existing = get().tabs.find((t) => t.sourcePath === path);
    const id = existing?.id ?? makeTabId();
    set((s) => ({
      openRejection: null,
      activeTabId: id,
      tabs: existing
        ? s.tabs.map((t) =>
            t.id === id
              ? {
                  ...blankTab(id),
                  loadGeneration: t.loadGeneration + 1, // 旧装载结果立即过期
                  status: "loading" as DocumentStatus,
                  sourcePath: path,
                  fileName,
                }
              : t,
          )
        : [...s.tabs, { ...blankTab(id), loadGeneration: 1, status: "loading" as DocumentStatus, sourcePath: path, fileName }],
    }));
    return id;
  },

  activateTab: (id) =>
    set((s) => (s.activeTabId === id || !s.tabs.some((t) => t.id === id) ? {} : { activeTabId: id })),

  readyTab: (id, meta) =>
    set((s) => ({
      tabs: patchTab(s, id, () => ({
        status: "ready" as DocumentStatus,
        document: meta.document,
        numPages: meta.numPages,
        pageSizes: meta.pageSizes,
        outline: meta.outline,
        currentPage: 1,
        scale: 1,
        error: null,
      })),
    })),

  failTab: (id, message) =>
    set((s) => ({
      tabs: patchTab(s, id, (t) => ({
        ...blankTab(id),
        loadGeneration: t.loadGeneration,
        // sourcePath/fileName 必须保留：openDocument/beginLoadTab 按 sourcePath
        // 寻址既有标签，清空后重试同一损坏/加密文件会认不出错误标签而每次另开
        // 新标签，反复重试顶满 MAX_TABS（违背「同一路径原地重开」语义）。
        sourcePath: t.sourcePath,
        fileName: t.fileName,
        status: "error" as DocumentStatus,
        error: message,
      })),
    })),

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index < 0) return {};
      const tabs = s.tabs.filter((t) => t.id !== id);
      // 激活标签被关闭：先右后左移交（浏览器惯例）；全关则回空态。
      if (s.activeTabId === id) {
        const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
        return { tabs, activeTabId: neighbor ? neighbor.id : null };
      }
      return { tabs };
    }),

  setCurrentPage: (page) =>
    set((s) => {
      if (!s.activeTabId) return {};
      return {
        tabs: patchTab(s, s.activeTabId, (t) => ({
          currentPage: t.numPages <= 0 ? 1 : Math.min(t.numPages, Math.max(1, Math.round(page))),
        })),
      };
    }),

  setScale: (scale) =>
    set((s) => {
      if (!s.activeTabId) return {};
      return { tabs: patchTab(s, s.activeTabId, () => ({ scale: Math.min(4, Math.max(0.25, scale)) })) };
    }),

  addHighlight: (input) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab || tab.status !== "ready" || tab.numPages <= 0 || input.rects.length === 0) return null;
    const pageNumber = Math.min(tab.numPages, Math.max(1, Math.round(input.pageNumber)));
    const highlight: Highlight = {
      id: input.id ?? makeHighlightId(),
      pageNumber,
      rects: input.rects.map((r) => ({ ...r })),
      color: input.color,
    };
    set({ tabs: patchTab(s, tab.id, (t) => ({ highlights: [...t.highlights, highlight] })) });
    return highlight;
  },

  removeHighlight: (id) =>
    set((s) => {
      if (!s.activeTabId) return {};
      return { tabs: patchTab(s, s.activeTabId, (t) => ({ highlights: t.highlights.filter((h) => h.id !== id) })) };
    }),

  setHighlightColor: (id, color) =>
    set((s) => {
      if (!s.activeTabId) return {};
      return {
        tabs: patchTab(s, s.activeTabId, (t) => ({
          highlights: t.highlights.map((h) => (h.id === id ? { ...h, color } : h)),
        })),
      };
    }),

  clearHighlights: () =>
    set((s) => {
      if (!s.activeTabId) return {};
      return { tabs: patchTab(s, s.activeTabId, () => ({ highlights: [] })) };
    }),

  rejectOpen: (message) => set({ openRejection: message }),
  dismissOpenRejection: () => set((s) => (s.openRejection ? { openRejection: null } : {})),

  reset: () => set({ tabs: [], activeTabId: null, openRejection: null }),
}));
