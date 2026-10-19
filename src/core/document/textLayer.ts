import type { PDFPageProxy } from "pdfjs-dist";
import { pdfjsLib } from "./pdfjs";
import { capScaleForRaster } from "./renderQueue";
import { useDocumentStore } from "./store";

/**
 * 文本层渲染封装（技术方案 5.2 第 8 条）：与画布使用同一 viewport 语义构建，
 * 保证选中位置与渲染像素对齐（M2 搜索/高亮的地基）。
 * 约定：传入的 cssScale 必须与画布渲染实际使用的缩放一致——请使用渲染结果
 * `painted.geometry.cssScale`（renderQueue 已做 8192 封顶），勿自行重算。
 */

export interface TextLayerHandle {
  /** 取消文本层渲染并清空容器（组件卸载/该页被取代时调用）。 */
  cancel(): void;
  /** 渲染完成 resolve；被取消 resolve 为 "cancelled"，失败 reject。 */
  done: Promise<"painted" | "cancelled">;
}

/** 渲染一页的文本层到 container（container 内部会被填充 span，重复调用先清空）。 */
export function renderTextLayer(params: {
  pageNumber: number;
  container: HTMLElement;
  /** 与画布一致的 CSS 缩放（用 painted.geometry.cssScale）。 */
  cssScale: number;
}): TextLayerHandle {
  const { pageNumber, container, cssScale } = params;
  const generation = useDocumentStore.getState().loadGeneration;
  let cancelled = false;
  let active: { cancel(): void } | null = null;

  const done = (async (): Promise<"painted" | "cancelled"> => {
    const { document } = useDocumentStore.getState();
    if (!document) throw new Error("尚未打开文档，无法渲染文本层");
    let page: PDFPageProxy;
    try {
      page = await document.getPage(pageNumber);
    } catch (error) {
      if (cancelled) return "cancelled";
      throw error;
    }
    if (cancelled || generation !== useDocumentStore.getState().loadGeneration) return "cancelled";

    container.replaceChildren();
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: capScaleForRaster(base.width, base.height, cssScale) });
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport,
    });
    active = textLayer;
    try {
      await textLayer.render();
    } catch (error) {
      // pdf.js 以 AbortException 终止进行中的文本层渲染：按契约 resolve "cancelled"，
      // 不让正常的取消（缩放/滚动重建文本层）走进异常路径。
      if (cancelled || error instanceof pdfjsLib.AbortException) return "cancelled";
      throw error;
    } finally {
      active = null;
    }
    if (cancelled) return "cancelled";
    return "painted";
  })();

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      active?.cancel();
      container.replaceChildren();
    },
    done,
  };
}
