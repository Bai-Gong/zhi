import { PDFDocument, EncryptedPDFError } from "pdf-lib";
import { readSourceBytes } from "./highlightExport";
import { renderQueue, RENDER_PRIORITY } from "./renderQueue";
import { baseNameOf } from "./mergeSplit";
import { exportSplitFiles, type SplitOutputItem } from "./mergeSplitExport";
import {
  throwIfCancelled,
  withStandalonePdf,
  type ConvertControl,
} from "./convertCommon";

/**
 * PDF ⇄ 图片 转换层（M6，模块 5；里程碑 M6-1/M6-2）：
 * - PDF→图片：**渲染一律经 core 既有的 renderQueue**（技术方案 4.3 规则 1
 *   「整页渲染与缩略图渲染同源」——出图与查看器/侧栏共用同一队列与同一套
 *   viewport/双缓冲实现，本文件不自建 pdf.js 绘制），逐页渲染离屏画布 →
 *   白底合成 → canvas.toBlob 得 png/jpg（96/192 dpi 两档）；
 * - 图片→PDF：pdf-lib embedPng/embedJpg 逐张成页，页面大小可「适应图片」或
 *   固定纸型（A4/Letter，含横版）+ 可调边距。
 *
 * 模块边界：pdf-lib / pdfjs-dist（经 renderQueue）只在 src/core/document；
 * 本文件不入桶导出，消费方直接 from。
 */

/** 出图格式。 */
export type ImageExportFormat = "png" | "jpg";

/** 出图清晰度两档（验收 M6-1）。 */
export type ImageExportDpi = 96 | 192;

/** 向导文件步的 PDF 元信息（出图方向）：页数 + 首页尺寸（pt，未按 /Rotate 归一，仅供预估）。 */
export interface PdfForImagesSummary {
  path: string;
  fileName: string;
  numPages: number;
  pageWidthPt: number;
  pageHeightPt: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析 PDF（出图向导的 inspect）：pdf-lib 装载取页数与首页尺寸。
 * 加密/损坏折算中文错误（文案按「转换」口径）。
 */
export async function inspectPdfForImages(path: string): Promise<PdfForImagesSummary> {
  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(path);
  } catch (error) {
    throw new Error(`读取文件失败：${describeError(error)}`);
  }
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const first = doc.getPage(0);
    const { width, height } = first.getSize();
    return {
      path,
      fileName: path.split(/[\\/]/).pop() || path,
      numPages: doc.getPageCount(),
      pageWidthPt: width,
      pageHeightPt: height,
    };
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new Error("文件已加密：暂不支持转换受密码保护的 PDF。");
    }
    throw new Error("文件已损坏或不是有效的 PDF 文档。");
  }
}

// ===== PDF → 图片 =====

/** 单页产物：文件名（带页码）+ 图像字节（png/jpg 编码后）。 */
export interface ImagePageItem {
  fileName: string;
  blob: Blob;
  /** 实际光栅尺寸（px）。 */
  width: number;
  height: number;
}

/** PDF→图片 执行结果。 */
export interface PdfToImagesResult {
  items: ImagePageItem[];
  /** 因超出单边 8192px 光栅上限而被封顶（实际 dpi 低于所选档）的页数。 */
  cappedPages: number;
  /** 每页耗时(ms)——诊断用（可忽略）。 */
  elapsedMs: number;
}

/** canvas.toBlob 的 Promise 包装。 */
function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("画布导出失败（toBlob 返回空）"))),
      mime,
      quality,
    );
  });
}

/**
 * PDF→图片执行（验收 M6-1）：逐页经 renderQueue 渲染（显式 generation 令牌
 * 隔离标签会话；专用离屏画布，与查看器画面互不干扰）→ 白底合成（PDF 页可能
 * 不画底色，jpg 无透明通道、png 透明底在各查看器呈现不一，统一铺白最可预期）
 * → toBlob。目标像素 = 页尺寸 pt × dpi/72；请求缩放按 devicePixelRatio 反除，
 * 使队列内部「viewport × dpr」的光栅恰落在目标像素上（出图分辨率不受
 * 系统缩放影响）。取消在页间安全点生效。
 */
export async function runPdfToImages(
  file: { path: string; fileName: string },
  options: { format: ImageExportFormat; dpi: ImageExportDpi; indices: readonly number[] },
  control: ConvertControl,
): Promise<PdfToImagesResult> {
  const { format, dpi, indices } = options;
  if (indices.length === 0) throw new Error("没有选中任何页。");
  const base = baseNameOf(file.fileName);
  const digits = String(indices.length).length;
  const mime = format === "png" ? "image/png" : "image/jpeg";
  const started = performance.now();
  let cappedPages = 0;

  return withStandalonePdf(file.path, file.fileName, async (doc) => {
    const items: ImagePageItem[] = [];
    for (let i = 0; i < indices.length; i += 1) {
      throwIfCancelled(control);
      const pageIndex = indices[i];
      const pageNumber = pageIndex + 1;
      control.onStage(`正在导出第 ${pageNumber} 页…（${i + 1}/${indices.length}）`, i / indices.length);
      const page = await doc.getPage(pageNumber);
      // 基准视口（含 /Rotate 归一）：目标像素 = 基准 × dpi/72。
      const baseViewport = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      // 队列的光栅 = viewport(cssScale) × dpr，故 cssScale 反除 dpr 抵消，
      // 光栅即目标像素（capScaleForRaster 超 8192 封顶时略小，按实际结算）。
      const scale = dpi / 72 / dpr;
      const canvas = document.createElement("canvas");
      const handle = renderQueue.enqueue({ page, canvas, scale, priority: RENDER_PRIORITY.thumbnail, generation: 1 });
      const outcome = await handle.done;
      if (outcome.status === "cancelled") {
        throw new Error("渲染任务被中断（文档会话发生变化），请重新执行。");
      }
      if (outcome.status === "failed") {
        throw new Error(`第 ${pageNumber} 页渲染失败：${describeError(outcome.error)}`);
      }
      const { rasterWidth, rasterHeight } = outcome.geometry;
      if (rasterWidth < Math.floor(baseViewport.width * (dpi / 72)) - 1) cappedPages += 1;
      // 白底合成（见函数头注释）。
      const composited = document.createElement("canvas");
      composited.width = rasterWidth;
      composited.height = rasterHeight;
      const ctx = composited.getContext("2d");
      if (!ctx) throw new Error("无法创建画布上下文（导出中止）。");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rasterWidth, rasterHeight);
      ctx.drawImage(canvas, 0, 0);
      const blob = await canvasToBlob(composited, mime, format === "jpg" ? 0.92 : undefined);
      const pageLabel = String(pageNumber).padStart(digits, "0");
      items.push({
        fileName: `${base}_${pageLabel}.${format}`,
        blob,
        width: rasterWidth,
        height: rasterHeight,
      });
      // 逐页释放 pdf.js 页资源（与查看器 PageCanvas 卸载清理同口径）。
      page.cleanup();
    }
    control.onStage("导出完成。", 1);
    return { items, cappedPages, elapsedMs: Math.round(performance.now() - started) };
  });
}

/**
 * 图片产物落盘：目录对话框 + 覆盖确认 + 逐文件写入，全部复用 M4 拆分的
 * exportSplitFiles（同一套「只写用户新选目标」流程）。Blob 在此刻才展开为字节。
 */
export async function exportImageFiles(
  items: readonly ImagePageItem[],
  sourcePath: string,
): Promise<{ status: "saved"; paths: string[] } | { status: "cancelled" } | { status: "failed"; message: string }> {
  const bytesItems: SplitOutputItem[] = [];
  for (const item of items) {
    bytesItems.push({ fileName: item.fileName, bytes: new Uint8Array(await item.blob.arrayBuffer()) });
  }
  const outcome = await exportSplitFiles(bytesItems, sourcePath);
  if (outcome.status === "saved") return { status: "saved" as const, paths: outcome.paths ?? [outcome.path] };
  if (outcome.status === "cancelled") return { status: "cancelled" as const };
  return { status: "failed" as const, message: outcome.message };
}

// ===== 图片 → PDF =====

/** 图片种类（按魔数判定，与可嵌入 pdf-lib 的编码一一对应）。 */
export type ImageKind = "png" | "jpeg";

/** 向导文件步的图片元信息：尺寸经 createImageBitmap 解码读取（numPages 恒 1——每张图一页）。 */
export interface ImageFileSummary {
  path: string;
  fileName: string;
  numPages: 1;
  kind: ImageKind;
  width: number;
  height: number;
}

/** 魔数嗅探：PNG（89 50 4E 47）/ JPEG（FF D8 FF）。 */
function sniffImageKind(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  return null;
}

/**
 * 解析一张图片（合成向导的 inspect）：读字节 → 魔数判定 → 解码取宽高。
 * 不支持的格式（非 png/jpg）抛中文错误。
 */
export async function inspectImageFile(path: string): Promise<ImageFileSummary> {
  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(path);
  } catch (error) {
    throw new Error(`读取文件失败：${describeError(error)}`);
  }
  const kind = sniffImageKind(bytes);
  if (!kind) {
    throw new Error("不支持的图片格式：请选择 PNG 或 JPG 文件。");
  }
  try {
    // bytes.slice() 复制到独立的 ArrayBuffer（Blob 构造需要 ArrayBuffer 底座，
    // 且 readSourceBytes 的视图可能挂在 ArrayBufferLike 上）。
    const copy = bytes.slice();
    const bitmap = await createImageBitmap(
      new Blob([copy.buffer], { type: kind === "png" ? "image/png" : "image/jpeg" }),
    );
    const summary: ImageFileSummary = {
      path,
      fileName: path.split(/[\\/]/).pop() || path,
      numPages: 1,
      kind,
      width: bitmap.width,
      height: bitmap.height,
    };
    bitmap.close();
    return summary;
  } catch (error) {
    throw new Error(`图片解码失败（文件可能已损坏）：${describeError(error)}`);
  }
}

/** 合成 PDF 的页面大小策略：适应图片（页=图，1px=0.75pt）或固定纸型。 */
export type ImagePageSize =
  | { kind: "fit" }
  | { kind: "fixed"; paper: "a4" | "letter"; landscape: boolean };

/** mm → pt。 */
export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

/** 固定纸型的页面尺寸（pt）。 */
function fixedPaperSize(paper: "a4" | "letter", landscape: boolean): { width: number; height: number } {
  // A4 = 210×297mm；Letter = 8.5×11in。
  const size = paper === "a4" ? { width: 595.28, height: 841.89 } : { width: 612, height: 792 };
  return landscape ? { width: size.height, height: size.width } : size;
}

/** 图片→PDF 执行结果。 */
export interface ImagesToPdfResult {
  bytes: Uint8Array;
  pageCount: number;
}

/**
 * 图片→PDF 执行（验收 M6-2）：按列表顺序逐张嵌入成页。固定纸型时图片等比
 * 缩放进「页边距内框」并居中；适应图片时页面即图片（1px=0.75pt，即 96dpi
 * 假定，与常见屏幕图片的观感一致）。取消在张间安全点生效。
 */
export async function runImagesToPdf(
  files: readonly { path: string; fileName: string }[],
  options: { pageSize: ImagePageSize; marginMm: number },
  control: ConvertControl,
): Promise<ImagesToPdfResult> {
  if (files.length === 0) throw new Error("请先选择图片。");
  const doc = await PDFDocument.create();
  doc.setTitle("图片合成文档", { showInWindowTitleBar: false });
  for (let i = 0; i < files.length; i += 1) {
    throwIfCancelled(control);
    const file = files[i];
    control.onStage(`正在合成第 ${i + 1}/${files.length} 张图片…`, i / files.length);
    let bytes: Uint8Array;
    try {
      bytes = await readSourceBytes(file.path);
    } catch (error) {
      throw new Error(`读取「${file.fileName}」失败：${describeError(error)}`);
    }
    const kind = sniffImageKind(bytes);
    if (!kind) throw new Error(`「${file.fileName}」不是有效的 PNG/JPG 图片（可能已损坏）。`);
    const image = kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    if (options.pageSize.kind === "fit") {
      const page = doc.addPage([image.width * 0.75, image.height * 0.75]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    } else {
      const paper = fixedPaperSize(options.pageSize.paper, options.pageSize.landscape);
      const margin = mmToPt(Math.max(0, options.marginMm));
      const page = doc.addPage([paper.width, paper.height]);
      const boxW = Math.max(1, paper.width - margin * 2);
      const boxH = Math.max(1, paper.height - margin * 2);
      const scale = Math.min(boxW / image.width, boxH / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: margin + (boxW - w) / 2, y: margin + (boxH - h) / 2, width: w, height: h });
    }
  }
  control.onStage("正在生成 PDF 文件…", null);
  const bytes = await doc.save();
  control.onStage("合成完成。", 1);
  return { bytes, pageCount: files.length };
}
