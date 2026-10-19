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

  beginLoad: (path: string, fileName: string) => void;
  ready: (meta: DocumentMeta) => void;
  fail: (message: string) => void;
  /** 关闭当前会话（会由 openDocument 内部负责销毁 pdf.js 文档与渲染任务）。 */
  close: () => void;
  setCurrentPage: (page: number) => void;
  setScale: (scale: number) => void;
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
  reset: () => set(initial),
}));
