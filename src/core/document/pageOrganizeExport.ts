import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { PDFDocument, degrees } from "pdf-lib";
import { useDocumentStore, activeTabOf } from "./store";
import { useOrganizeStore } from "./organizeStore";
import { readSourceBytes, sameDiskPath, type SaveCopyResult } from "./highlightExport";
import { applyOrganization, normalizeAngle } from "./organizePdf";

/**
 * 页面组织「另存副本 / 提取所选页」（M3 验收 3/4/5）的导出落地层：
 * 读原文件字节 → 纯变换层（organizePdf.ts）或 copyPages → 保存对话框写入
 * 用户选定的**新文件**。原文件字节绝不改动（目标与原路径相同时直接拒绝写入）。
 *
 * 两条链路（技术选型见 organizePdf.ts 文件头）：
 * - **另存副本**（整本组织结果）：原文档页树重排 + 旋转 + 悬空书签清理
 *   （书签 /Names /OpenAction 原样保留 → 验收 M3-4 书签导航与中文内容不乱）；
 * - **提取所选页**：`PDFDocument.create` + `copyPages`（里程碑技术要点指定），
 *   不承诺书签（Acrobat 提取页默认同样不带），只保证页数/顺序/朝向（验收 M3-3）。
 *
 * 模块边界：pdf-lib 只允许出现在 src/core/document（技术方案 4.3 规则 1），
 * 本文件不入 core/document/index.ts 桶导出，消费方直接 from（与 highlightExport 同例）。
 */

function failed(message: string): SaveCopyResult {
  return { status: "failed", message };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 副本建议文件名：`报告.pdf` → `报告_整理副本.pdf` / `报告_提取.pdf`。 */
function suggestName(fileName: string | null, suffix: string): string {
  const base = (fileName ?? "文档").replace(/\.pdf$/i, "");
  return `${base}_${suffix}.pdf`;
}

/** 导出前提：激活标签就绪 + 组织会话有效且未过期。 */
function requireExportContext():
  | {
      ok: true;
      sourcePath: string;
      fileName: string;
      order: readonly number[];
      rotationDelta: Readonly<Record<number, number>>;
    }
  | { ok: false; message: string } {
  const tab = activeTabOf(useDocumentStore.getState());
  if (tab.status !== "ready" || !tab.sourcePath) {
    return { ok: false, message: "当前没有可导出的文档会话。" };
  }
  const session = useOrganizeStore.getState().sessions[tab.id];
  if (!session) {
    return { ok: false, message: "组织会话尚未就绪，请重新进入组织页面。" };
  }
  if (session.generation !== tab.loadGeneration) {
    return { ok: false, message: "文档已重新装载，组织状态过期：请重新整理后再导出。" };
  }
  return {
    ok: true,
    sourcePath: tab.sourcePath,
    fileName: tab.fileName ?? "文档",
    order: session.order,
    rotationDelta: session.rotationDelta,
  };
}

/** 保存对话框 + 拒绝写原文件 + 写入；三个结局见 {@link SaveCopyResult}。 */
async function writeCopy(
  output: Uint8Array,
  sourcePath: string,
  fileName: string,
  suffix: string,
): Promise<SaveCopyResult> {
  let target: string | null;
  try {
    target = await saveFileDialog({
      defaultPath: suggestName(fileName, suffix),
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
  return { status: "saved", path: target };
}

// ===== 链路一：另存副本 =====

/** 把组织结果写入原文件的内存副本并另存（验收 M3-4/5）。不抛出。 */
export async function saveOrganizedCopy(): Promise<SaveCopyResult> {
  const ctx = requireExportContext();
  if (!ctx.ok) return failed(ctx.message);
  const { sourcePath, fileName, order, rotationDelta } = ctx;
  if (order.length === 0) {
    return failed("所有页面都已被删除，没有可导出的内容：请先撤销删除或重新打开文档。");
  }

  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(sourcePath);
  } catch (error) {
    return failed(`读取原文件失败：${describeError(error)}`);
  }

  let pdf: PDFDocument;
  let output: Uint8Array;
  try {
    // updateMetadata:false —— 不注入 Producer/ModDate，副本除组织结果外尽量贴原文件。
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    applyOrganization(pdf, order, rotationDelta);
    output = await pdf.save();
  } catch (error) {
    return failed(`生成副本失败：${describeError(error)}`);
  }
  return writeCopy(output, sourcePath, fileName, "整理副本");
}

// ===== 链路二：提取所选页（create + copyPages） =====

/**
 * 把选中的源页提取为新 PDF 并另存（验收 M3-3）：`copyPages` 的 indices 顺序即
 * 新文档页序（组织视图网格所见顺序）；旋转按组织增量叠加写入。
 * `sourceIndices` 传空数组时导出整本（等价于当前页序的另存，不带书签）。
 */
export async function extractPagesToNewPdf(sourceIndices: number[]): Promise<SaveCopyResult> {
  const ctx = requireExportContext();
  if (!ctx.ok) return failed(ctx.message);
  const { sourcePath, fileName, order, rotationDelta } = ctx;
  // 提取选择基于组织后的页序（网格所见即所得）。
  const wanted = new Set(sourceIndices);
  const selected = order.filter((src) => wanted.has(src));
  if (selected.length === 0) {
    return failed("请先选择要提取的页面（点击、Ctrl+点击或框选）。");
  }

  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(sourcePath);
  } catch (error) {
    return failed(`读取原文件失败：${describeError(error)}`);
  }

  let source: PDFDocument;
  let output: PDFDocument;
  try {
    source = await PDFDocument.load(bytes, { updateMetadata: false });
    output = await PDFDocument.create();
  } catch (error) {
    return failed(`解析原文件失败：${describeError(error)}`);
  }

  let out: Uint8Array;
  try {
    const copied = await output.copyPages(source, selected);
    copied.forEach((page, i) => {
      const delta = rotationDelta[selected[i]] ?? 0;
      if (delta) page.setRotation(degrees(normalizeAngle(page.getRotation().angle + delta)));
      output.addPage(page);
    });
    out = await output.save();
  } catch (error) {
    return failed(`提取页面失败：${describeError(error)}`);
  }
  return writeCopy(out, sourcePath, fileName, "提取");
}
