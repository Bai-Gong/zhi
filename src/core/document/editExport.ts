import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from "pdf-lib";
import { useDocumentStore, activeTabOf } from "./store";
import { useEditStore } from "./editStore";
import { readSourceBytes, sameDiskPath } from "./highlightExport";
import { editFontSpec, isVectorText, TEXT_LINE_HEIGHT, type EditImageAsset, type EditObject, type EditFontId, type TextEditObject } from "./editModel";

/**
 * 基础编辑「另存副本」（M5 验收 5）：读原文件字节，pdf-lib 把编辑会话的全部
 * 补丁对象写入内存副本（遮盖矩形 + 新文本/图片），经保存对话框落盘为用户选定的
 * **新文件**；原文件字节绝不改动（目标与原路径相同时直接拒绝写入）。
 *
 * 文本落笔的诚实双轨（依赖冻结下的定位，见 editModel.isVectorText）：
 * - **矢量文本**：内容全部可 WinAnsi 编码（西文/数字/常用符号）→ pdf-lib 标准
 *   字体（Helvetica/Times/Courier 四变体），导出后在 Acrobat 中**可再选中复制**；
 * - **位图文本**：含中文等不可编码字符 → 离屏 canvas 按屏幕同款排版渲染成
 *   PNG（3x 光栅，清晰可读、无缺字），embedPng 叠加——但**不可再选中复制**。
 *   返回值里的 bitmapTexts 计数供 UI 明示降级情况。
 *
 * 坐标：对象全程用户空间（同 HighlightRect 约定），pdf-lib 直接落笔，无 y 翻转、
 * 无 /Rotate 补偿（与 highlightExport 的零换算结论同源，见其文件头注释）。
 *
 * 模块边界：pdf-lib 只允许出现在 src/core/document（技术方案 4.3 规则 1），
 * 本文件不入 core/document/index.ts 桶导出，消费方直接 from（与 highlightExport 同例）。
 */

/** 位图文本的光栅倍率（3x：100% 视图下清晰，文件体积可控）。 */
const BITMAP_SCALE = 3;
/** 首行基线：矩形顶到基线 = 0.8em（近似 ascent，与预览的渲染差异肉眼可忽略）。 */
const FIRST_LINE_ASCENT = 0.8;

export type EditSaveResult =
  | { status: "saved"; path: string; bitmapTexts: number }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

function failed(message: string): EditSaveResult {
  return { status: "failed", message };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 标准字体四变体的解析：字体族 + 粗/斜 → StandardFonts 枚举值。 */
function standardFontOf(id: EditFontId, bold: boolean, italic: boolean): StandardFonts {
  if (id === "times") {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (id === "courier") {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/** `#RRGGBB` → 0–1 归一 RGB；非法回退黑色（文本默认色）。 */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return { r: 0, g: 0, b: 0 };
  const n = Number.parseInt(match[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/**
 * 位图文本渲染：按对象排版在离屏 canvas 画出全部行，返回 PNG 字节。
 * 白底（与遮盖矩形一致，避免透明底在深色阅读器主题下露底色）。
 */
async function renderTextBitmap(object: TextEditObject): Promise<Uint8Array> {
  const scale = BITMAP_SCALE;
  const width = Math.max(1, Math.ceil(object.cover.width * scale));
  const height = Math.max(1, Math.ceil(object.cover.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建位图文本画布。");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const family = editFontSpec(object.fontFamily).cssFamily;
  ctx.font = `${object.italic ? "italic " : ""}${object.bold ? "700" : "400"} ${object.fontSize * scale}px ${family}`;
  ctx.fillStyle = object.color;
  ctx.textBaseline = "alphabetic";
  const lines = object.text.split("\n");
  const baseline0 = object.fontSize * FIRST_LINE_ASCENT * scale;
  const lineHeight = object.fontSize * TEXT_LINE_HEIGHT * scale;
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, baseline0 + i * lineHeight, width);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("位图文本导出失败。");
  return new Uint8Array(await blob.arrayBuffer());
}

/** 导出前提：激活标签就绪 + 编辑会话有效且未过期。 */
function requireExportContext():
  | {
      ok: true;
      sourcePath: string;
      fileName: string;
      objects: readonly EditObject[];
      images: Record<string, EditImageAsset>;
    }
  | { ok: false; message: string } {
  const tab = activeTabOf(useDocumentStore.getState());
  if (tab.status !== "ready" || !tab.sourcePath) {
    return { ok: false, message: "当前没有可导出的文档会话。" };
  }
  const session = useEditStore.getState().sessions[tab.id];
  if (!session) {
    return { ok: false, message: "编辑会话尚未就绪，请重新进入编辑页面。" };
  }
  if (session.generation !== tab.loadGeneration) {
    return { ok: false, message: "文档已重新装载，编辑状态过期：请重新编辑后再导出。" };
  }
  return { ok: true, sourcePath: tab.sourcePath, fileName: tab.fileName ?? "文档", objects: session.objects, images: session.images };
}

/**
 * 把编辑会话的全部补丁写入副本并另存。不抛出：一切失败折算为 failed 结果，
 * 由调用方（编辑页工具栏）呈现。saved 携带 bitmapTexts（位图降级的文本对象数）。
 */
export async function saveEditedCopy(): Promise<EditSaveResult> {
  const ctx = requireExportContext();
  if (!ctx.ok) return failed(ctx.message);
  const { sourcePath, fileName, objects, images } = ctx;
  if (objects.length === 0) {
    return failed("还没有任何编辑内容：双击文本改写，或插入图片后再另存副本。");
  }

  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(sourcePath);
  } catch (error) {
    return failed(`读取原文件失败：${describeError(error)}`);
  }

  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    return failed(`解析原文件失败（加密或非常规 PDF）：${describeError(error)}`);
  }

  // 懒加载缓存：标准字体与图片按需嵌入一次，重复对象共享。
  const fontCache = new Map<string, PDFFont>();
  const imageCache = new Map<string, PDFImage>();
  const embedStdFont = async (id: EditFontId, bold: boolean, italic: boolean): Promise<PDFFont> => {
    const key = `${id}:${bold ? 1 : 0}${italic ? 1 : 0}`;
    let font = fontCache.get(key);
    if (!font) {
      font = await pdf.embedFont(standardFontOf(id, bold, italic));
      fontCache.set(key, font);
    }
    return font;
  };
  const embedAsset = async (srcId: string): Promise<PDFImage | null> => {
    let img = imageCache.get(srcId);
    if (img) return img;
    const asset = images[srcId];
    if (!asset) return null;
    img = asset.format === "png" ? await pdf.embedPng(asset.bytes) : await pdf.embedJpg(asset.bytes);
    imageCache.set(srcId, img);
    return img;
  };

  const pageCount = pdf.getPageCount();
  let bitmapTexts = 0;
  try {
    // 按页分桶后逐页落笔（页对象只取一次；对象数组顺序即叠放层级，先画先垫底）。
    const byPage = new Map<number, EditObject[]>();
    for (const object of objects) {
      if (object.pageNumber < 1 || object.pageNumber > pageCount) continue; // 理论不可达，防御即可
      const bucket = byPage.get(object.pageNumber);
      if (bucket) bucket.push(object);
      else byPage.set(object.pageNumber, [object]);
    }
    for (const [pageNumber, pageObjects] of byPage) {
      const page = pdf.getPage(pageNumber - 1);
      for (const object of pageObjects) {
        if (object.kind === "text") {
          if (!(object.cover.width > 0 && object.cover.height > 0)) continue; // 退化矩形不落笔
          // 1) 遮盖原文：无衬底白色矩形（不透明）。
          page.drawRectangle({
            x: object.cover.x,
            y: object.cover.y,
            width: object.cover.width,
            height: object.cover.height,
            color: rgb(1, 1, 1),
            borderWidth: 0,
          });
          if (object.text.trim().length === 0) continue; // 纯删除（只遮盖不重写）
          if (isVectorText(object.text)) {
            // 2a) 矢量文本：标准字体逐行落笔，基线自遮盖矩形顶下行。
            const font = await embedStdFont(object.fontFamily, object.bold, object.italic);
            const color = parseHexColor(object.color);
            const baseline0 = object.cover.y + object.cover.height - object.fontSize * FIRST_LINE_ASCENT;
            const lineHeight = object.fontSize * TEXT_LINE_HEIGHT;
            const lines = object.text.split("\n");
            lines.forEach((line, i) => {
              if (line.length === 0) return;
              page.drawText(line, {
                x: object.cover.x,
                y: baseline0 - i * lineHeight,
                size: object.fontSize,
                font,
                color: rgb(color.r, color.g, color.b),
              });
            });
          } else {
            // 2b) 位图文本：canvas 同排版渲染成 PNG 铺遮盖矩形（中文等不可编码字符）。
            const png = await renderTextBitmap(object);
            const img = await pdf.embedPng(png);
            page.drawImage(img, {
              x: object.cover.x,
              y: object.cover.y,
              width: object.cover.width,
              height: object.cover.height,
            });
            bitmapTexts += 1;
          }
        } else {
          const img = await embedAsset(object.srcId);
          if (!img) continue; // 引用丢失（理论不可达）：跳过该对象而非整体失败
          page.drawImage(img, { x: object.x, y: object.y, width: object.width, height: object.height });
        }
      }
    }
  } catch (error) {
    return failed(`生成编辑副本失败：${describeError(error)}`);
  }

  let output: Uint8Array;
  try {
    output = await pdf.save();
  } catch (error) {
    return failed(`生成编辑副本失败：${describeError(error)}`);
  }

  let target: string | null;
  try {
    const base = fileName.replace(/\.pdf$/i, "");
    target = await saveFileDialog({
      defaultPath: `${base}_编辑副本.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  } catch (error) {
    return failed(`另存对话框调用失败：${describeError(error)}`);
  }
  if (!target) return { status: "cancelled" };
  if (sameDiskPath(target, sourcePath)) {
    return failed("目标路径与原文件相同：为保护原文件，请换一个文件名或目录再保存。");
  }

  try {
    await writeFile(target, output);
  } catch (error) {
    return failed(`写入文件失败：${describeError(error)}`);
  }
  return { status: "saved", path: target, bitmapTexts };
}
