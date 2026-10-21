import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { initPdfjs, pdfjsLib, createDocumentWorker, InvalidPDFException, PasswordException } from "./pdfjs";
import { readSourceBytes, sameDiskPath } from "./highlightExport";

/**
 * 格式转换共享地基（M6，模块 5）：
 * - 独立 pdf.js 装载 {@link withStandalonePdf}——转换用的文档**不进标签会话**
 *   （store 是查看器的多标签模型），走「读字节双路径 + 专属 worker + 用后即毁」
 *   的独立生命周期，装载与回收手法与 openDocument 同源（worker 必须先
 *   task.destroy() 落地再 terminate port，防泄漏线程，见 openDocument 注释）；
 * - 转换执行控制 {@link ConvertControl}（阶段进度 + 取消轮询，与 M4 的
 *   MergeSplitRunControl 同构）与用户取消 {@link ConvertCancelled}；
 * - .docx 产物落盘 {@link saveConvertedDocx}（保存对话框写副本，铁律 3）。
 *
 * 模块边界：pdfjs-dist 只允许在 src/core/document（技术方案 4.3 规则 1）；
 * 本文件不入 core/document/index.ts 桶导出，消费方直接 from（M4 同款约定）。
 */

/** 用户取消（ConvertControl.isCancelled 置位后在检查点抛出；工具层折算回 WizardCancelled）。 */
export class ConvertCancelled extends Error {
  constructor() {
    super("已取消");
    this.name = "ConvertCancelled";
  }
}

/** 转换执行控制：阶段性进度（0–1 或未知 null）+ 取消轮询。 */
export interface ConvertControl {
  onStage: (message: string, ratio: number | null) => void;
  isCancelled: () => boolean;
}

/** 在转换的页级循环安全点检查取消。 */
export function throwIfCancelled(control: ConvertControl): void {
  if (control.isCancelled()) throw new ConvertCancelled();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 装载一份独立于标签会话的 pdf.js 文档并执行 `run`，结束后（无论成败）销毁
 * 文档与专属 worker。加密/损坏折算成中文可读错误抛出（不区分工具用途，
 * 文案统一说「转换」）。字节经 readSourceBytes 双路径读取（asset → plugin-fs）。
 */
export async function withStandalonePdf<T>(
  path: string,
  fileName: string,
  run: (doc: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  initPdfjs();
  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(path);
  } catch (error) {
    throw new Error(`读取「${fileName}」失败：${describeError(error)}`);
  }
  const worker = createDocumentWorker();
  // port 引用创建后立即取走（destroy 后取不到，见 openDocument 的 LoadEntry 注释）。
  const port = worker.port;
  const task = pdfjsLib.getDocument({ data: bytes, worker });
  // 统一回收：先 task.destroy() 落地（终止 worker 侧解析），再 terminate 线程。
  const release = () => {
    try {
      worker.destroy();
      port?.terminate();
    } catch (error) {
      console.warn("回收转换用 pdf.js worker 失败：", error);
    }
  };
  let doc: PDFDocumentProxy | null = null;
  try {
    doc = await task.promise;
  } catch (error) {
    void task.destroy().then(release, release);
    if (error instanceof PasswordException) {
      throw new Error(`「${fileName}」已加密：暂不支持转换受密码保护的 PDF。`);
    }
    if (error instanceof InvalidPDFException) {
      throw new Error(`「${fileName}」已损坏或不是有效的 PDF 文档。`);
    }
    throw new Error(`装载「${fileName}」失败：${describeError(error)}`);
  }
  try {
    return await run(doc);
  } finally {
    void task.destroy().then(release, release);
  }
}

/**
 * 把转换产物写入用户选定的新文件（保存对话框 → 拒绝与源文件同路径 → 写入）。
 * 与 mergeSplitExport.saveMergedPdf 同一套「副本铁律」流程，滤器与默认名
 * 由调用方给定（.docx / .pdf 各用各的）。
 */
export async function saveConvertedFile(params: {
  bytes: Uint8Array;
  sourcePaths: readonly string[];
  defaultName: string;
  filterName: string;
  extensions: string[];
}): Promise<{ status: "saved"; path: string } | { status: "cancelled" } | { status: "failed"; message: string }> {
  let target: string | null;
  try {
    target = await saveFileDialog({
      defaultPath: params.defaultName,
      filters: [{ name: params.filterName, extensions: params.extensions }],
    });
  } catch (error) {
    return { status: "failed", message: `另存对话框调用失败：${describeError(error)}` };
  }
  if (!target) return { status: "cancelled" };
  const clash = params.sourcePaths.find((source) => sameDiskPath(target as string, source));
  if (clash) {
    return {
      status: "failed",
      message: "目标路径与源文件相同：为保护原文件，请换一个文件名或目录再保存。",
    };
  }
  try {
    await writeFile(target, params.bytes);
  } catch (error) {
    return { status: "failed", message: `写入文件失败：${describeError(error)}` };
  }
  return { status: "saved", path: target };
}
