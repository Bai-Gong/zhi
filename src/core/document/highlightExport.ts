import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { PDFDocument, rgb } from "pdf-lib";
import { useDocumentStore, activeTabOf } from "./store";

/**
 * 批注高亮「另存副本」（M2-3 / M2-计划 D5 导出层、风险 4）：
 * 读原文件字节（与 openDocument 同一条「asset 协议 → plugin-fs 兜底」双路径），
 * pdf-lib 把**激活标签**的全部高亮画成半透明矩形，经保存对话框写入用户选定的
 * 新文件；原文件字节绝不改动（目标与原路径相同时直接拒绝写入）。
 *
 * 坐标换算（本文件的命门，见 store.HighlightRect 的换算约定）：
 * - 高亮矩形存的是 PDF 用户空间坐标（原点左下、y 向上、单位 pt、未做 /Rotate 归一），
 *   与 pdf-lib 落笔坐标系**同为用户空间且 y 同向，直接画即可，无需 y 轴翻转**；
 * - 页面 /Rotate（0/90/180/270）由阅读器（pdf.js / Chrome / Acrobat）在显示时统一施加，
 *   矩形随文本一起旋转、天然对齐——pdf-lib 对旋转页不做隐藏补偿（已实测：同一组
 *   drawRectangle 参数在四个旋转档下写出的内容流算子完全一致），因此导出侧无需
 *   按 page.getSize() 再换算（M2-计划风险 4 的「统一换算」由此收敛为零换算）；
 * - 同一条高亮的多个矩形按数组顺序叠加，与查看器覆盖层的呈现一致。
 *
 * 模块边界：pdf-lib 只允许出现在 src/core/document（技术方案 4.3 规则 1），
 * 本文件不入 core/document/index.ts 桶导出，消费方直接 from "../core/document/highlightExport"。
 */

/** 导出高亮的不透明度（与查看器覆盖层 HIGHLIGHT_VIEW_ALPHA 同值：Chrome/Acrobat 双端
 * 目检与屏幕呈现一致，验收 M2-3 的口径）。 */
export const HIGHLIGHT_EXPORT_OPACITY = 0.35;

/** 高亮色解析失败时的兜底色（与查看器色板默认黄一致，保证导出不丢高亮）。 */
const FALLBACK_COLOR = "#ffe066";

/** 另存副本的结局：成功（含新路径）/ 用户在对话框取消 / 失败（中文可读原因）。 */
export type SaveCopyResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };
function failed(message: string): SaveCopyResult {
  return { status: "failed", message };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `#RRGGBB` → pdf-lib 的 0–1 归一 RGB；格式非法返回 null。 */
function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** 副本建议文件名：`报告.pdf` → `报告_高亮副本.pdf`。 */
function suggestCopyName(fileName: string | null): string {
  const base = (fileName ?? "文档").replace(/\.pdf$/i, "");
  return `${base}_高亮副本.pdf`;
}

/** Windows 磁盘路径等同判定：大小写不敏感、正反斜杠归一（防保存对话框选回原文件）。
 *  M3 起导出（pageOrganizeExport）复用，故导出。 */
export function sameDiskPath(a: string, b: string): boolean {
  const normalize = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "\\").toLowerCase();
  return normalize(a) === normalize(b);
}

/**
 * 读原文件字节：主路径 asset 协议（零拷贝流式，与 openDocument.loadFromUrl 同源），
 * 失败自动兜底 plugin-fs.readFile（同 openDocument.loadFromBytes；capabilities 已授
 * fs:allow-read-file + "**" scope）。只读，不构成对原文件的任何写入。
 * M3 起导出（pageOrganizeExport）复用，故导出。
 */
export async function readSourceBytes(path: string): Promise<Uint8Array> {
  try {
    const response = await fetch(convertFileSrc(path));
    if (!response.ok) throw new Error(`asset 协议返回 HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (assetError) {
    console.warn("asset 协议读取原文件失败，转 plugin-fs 兜底：", assetError);
    return readFile(path);
  }
}

/**
 * 把激活标签的全部高亮写入副本并另存（保存对话框选路径 → plugin-fs 写文件）。
 * 不抛出：一切失败都折算成 `{ status: "failed", message }`，由调用方（浮动条）呈现。
 */
export async function saveHighlightCopy(): Promise<SaveCopyResult> {
  const tab = activeTabOf(useDocumentStore.getState());
  if (tab.status !== "ready" || !tab.document || !tab.sourcePath) {
    return failed("当前没有可导出的文档会话。");
  }
  if (tab.highlights.length === 0) {
    return failed("还没有任何高亮：先选中文本添加高亮，再另存副本。");
  }

  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(tab.sourcePath);
  } catch (error) {
    return failed(`读取原文件失败：${describeError(error)}`);
  }

  let pdf: PDFDocument;
  try {
    // updateMetadata:false —— 不注入 Producer/ModDate，副本除高亮外尽量贴原文件。
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    return failed(`解析原文件失败（加密或非常规 PDF）：${describeError(error)}`);
  }

  // 逐条落笔：见文件头「坐标换算」——用户空间直接画，无 y 翻转、无旋转补偿。
  const pageCount = pdf.getPageCount();
  const fallback = parseHexColor(FALLBACK_COLOR);
  for (const highlight of tab.highlights) {
    if (highlight.pageNumber < 1 || highlight.pageNumber > pageCount) continue; // 理论不可达，防御即可
    const page = pdf.getPage(highlight.pageNumber - 1);
    const color = parseHexColor(highlight.color) ?? fallback;
    if (!color) continue;
    for (const rect of highlight.rects) {
      if (!(rect.width > 0 && rect.height > 0)) continue; // 退化矩形不落笔
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        color: rgb(color.r, color.g, color.b),
        opacity: HIGHLIGHT_EXPORT_OPACITY,
        borderWidth: 0, // 只要色块不要描边（pdf-lib 默认即 0，显式写出以防版本行为漂移）
      });
    }
  }

  let output: Uint8Array;
  try {
    output = await pdf.save();
  } catch (error) {
    return failed(`生成副本失败：${describeError(error)}`);
  }

  let target: string | null;
  try {
    target = await saveFileDialog({
      defaultPath: suggestCopyName(tab.fileName),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  } catch (error) {
    return failed(`另存对话框调用失败：${describeError(error)}`);
  }
  if (!target) return { status: "cancelled" };
  if (sameDiskPath(target, tab.sourcePath)) {
    return failed("目标路径与原文件相同：为保护原文件，请换一个文件名或目录再保存。");
  }

  try {
    await writeFile(target, output);
  } catch (error) {
    return failed(`写入文件失败：${describeError(error)}`);
  }
  return { status: "saved", path: target };
}

/** 在系统资源管理器中显示已保存的副本（opener:default 已含 reveal-item-in-dir 权限）。 */
export async function revealSavedCopy(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (error) {
    console.warn("打开所在目录失败：", error);
  }
}
