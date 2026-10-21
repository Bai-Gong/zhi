import { open as openFileDialog, save as saveFileDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { exists, writeFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { PDFDocument, EncryptedPDFError } from "pdf-lib";
import { readSourceBytes, sameDiskPath, type SaveCopyResult } from "./highlightExport";
import {
  attachTopLevelBookmarks,
  baseNameOf,
  mergeToDocument,
  readTopBookmarks,
  splitToDocuments,
  MergeSplitCancelled,
  type SplitSegment,
  type TopBookmark,
} from "./mergeSplit";

/**
 * 合并拆分的「读文件 → 对话框 → 写副本」落地层（M4，模块 5）：与 M3 的
 * pageOrganizeExport 同一层——纯变换在 mergeSplit.ts，本文件负责触碰文件系统
 * 与系统对话框。写文件只写**用户经对话框选定的新文件/目录**，绝不改动原文件
 * （目标与任一源文件相同时直接拒绝写入，铁律 3）。
 *
 * 模块边界：pdf-lib 只允许出现在 src/core/document（技术方案 4.3 规则 1），
 * 本文件不入 core/document/index.ts 桶导出，消费方直接 from。
 */

/** 向导文件步的元信息（合并/拆分共用：页数 + 顶级书签概要）。 */
export interface PdfFileSummary {
  path: string;
  fileName: string;
  numPages: number;
  /** 顶级书签（0 起页索引）；无书签为空数组——拆分「按书签」据此判定可用性。 */
  topBookmarks: TopBookmark[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * 解析一个 PDF 文件（向导文件步 inspect 与执行前共享的入口）：
 * 读字节（asset 协议 → plugin-fs 兜底，与查看器同一条双路径）→ pdf-lib 装载
 * → 页数与顶级书签。解析后即释放文档对象（执行时另行重读，不跨步骤驻留大内存）。
 * 抛出 = 该文件不可用（中文原因：加密/损坏/读取失败）。
 */
export async function inspectPdfFile(path: string): Promise<PdfFileSummary> {
  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(path);
  } catch (error) {
    throw new Error(`读取文件失败：${describeError(error)}`);
  }
  let doc: PDFDocument;
  try {
    // 不 ignoreEncryption：加密文档的内容流无法解密，copyPages 会拷出密文裸字节，
    // 与其产出损坏副本，不如明确拒绝（与查看器对加密文档的行为一致降级提示）。
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new Error("文件已加密：暂不支持对受密码保护的 PDF 做合并/拆分。");
    }
    throw new Error("文件已损坏或不是有效的 PDF 文档。");
  }
  return {
    path,
    fileName: fileNameOf(path),
    numPages: doc.getPageCount(),
    topBookmarks: readTopBookmarks(doc),
  };
}

// ===== 执行器（读原文件 → 纯变换 → 产出内存字节；features/tools 只组装进度与 UI） =====

/** 执行器的进度与取消通道（阶段消息 + 页级进度；取消经 isCancelled 轮询）。 */
export interface MergeSplitRunControl {
  onStage: (message: string, ratio: number | null) => void;
  onPages: (done: number, total: number) => void;
  isCancelled: () => boolean;
}

/** 读并装载一个源文档（加密/损坏折算成中文可读错误抛出）。 */
async function loadSource(path: string, fileName: string): Promise<PDFDocument> {
  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(path);
  } catch (error) {
    throw new Error(`读取「${fileName}」失败：${describeError(error)}`);
  }
  try {
    // 与 inspectPdfFile 同一口径：不 ignoreEncryption（密文拷贝只会产出损坏副本）。
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new Error(`「${fileName}」已加密：暂不支持对受密码保护的 PDF 做合并/拆分。`);
    }
    if (error instanceof MergeSplitCancelled) throw error;
    throw new Error(`「${fileName}」已损坏或不是有效的 PDF 文档。`);
  }
}

/** 合并的一个源条目（features 组装好页选择后传入）。 */
export interface MergeFileInput {
  path: string;
  fileName: string;
  /** 要选取的页（0 起，顺序即输出页序；空数组 = 无贡献页）。 */
  indices: number[];
}

/** 合并执行结果（字节在内存，落盘由 saveMergedPdf 完成）。 */
export interface MergeRunResult {
  bytes: Uint8Array;
  /** 输出文档总页数。 */
  pageCount: number;
  /** 每个源文件在输出中的页区间（1 起，含端点；顺序即列表顺序）。 */
  perFile: { fileName: string; from: number; to: number }[];
}

/**
 * 合并执行（验收 M4-1/M4-2）：逐文件「读取+装载」（阶段消息）→ copyPages
 * 合并（页级进度、可取消）→ 可选「每源文件一条顶级书签」→ save 产出字节。
 * 逐文件流式装载：读完一个源即只保留拷贝结果，源文档对象可回收，
 * 峰值内存 ≈ 输出对象图 + 当前源（大文件多档合并的关键）。
 */
export async function runMerge(
  files: readonly MergeFileInput[],
  options: { bookmarkPerFile: boolean },
  control: MergeSplitRunControl,
): Promise<MergeRunResult> {
  const total = files.reduce((sum, file) => sum + file.indices.length, 0);
  if (total <= 0) throw new Error("所有文件都没有选中任何页，无法合并。");

  const entries: { doc: PDFDocument; indices: number[] }[] = [];
  let donePages = 0;
  for (const file of files) {
    control.onStage(`正在读取「${file.fileName}」…（${entries.length + 1}/${files.length}）`, null);
    const doc = await loadSource(file.path, file.fileName);
    if (control.isCancelled()) throw new MergeSplitCancelled();
    entries.push({ doc, indices: file.indices });
    donePages += file.indices.length;
    control.onPages(donePages, total);
  }

  control.onStage("正在合并页面…", 0);
  const merged = await mergeToDocument(entries, {
    onProgress: control.onPages,
    isCancelled: control.isCancelled,
  });

  if (options.bookmarkPerFile) {
    attachTopLevelBookmarks(
      merged,
      files.map((file, i) => {
        const start = files.slice(0, i).reduce((sum, f) => sum + f.indices.length, 0);
        return { title: baseNameOf(file.fileName), pageIndex: start };
      }),
    );
  }

  control.onStage("正在生成输出文件…（大文件可能需要数十秒）", null);
  const bytes = await merged.save();
  return {
    bytes,
    pageCount: merged.getPageCount(),
    perFile: files.map((file, i) => {
      const from = files.slice(0, i).reduce((sum, f) => sum + f.indices.length, 0) + 1;
      return { fileName: file.fileName, from, to: from + file.indices.length - 1 };
    }),
  };
}

/** 拆分执行结果：每段一个产物（段序即 items 序，与 segments 一一对应）。 */
export interface SplitRunResult {
  items: { fileName: string; bytes: Uint8Array }[];
}

/** 拆分执行（验收 M4-3）：装载源 → 逐段 copyPages + save（段级阶段消息、页级进度、可取消）。 */
export async function runSplit(
  source: { path: string; fileName: string },
  segments: readonly SplitSegment[],
  control: MergeSplitRunControl,
): Promise<SplitRunResult> {
  if (segments.length === 0) throw new Error("拆分计划为空：请先调整拆分设置。");
  control.onStage(`正在读取「${source.fileName}」…`, null);
  const doc = await loadSource(source.path, source.fileName);
  if (control.isCancelled()) throw new MergeSplitCancelled();

  control.onStage("正在拆分页面…", 0);
  const parts = await splitToDocuments(doc, segments, {
    onProgress: control.onPages,
    isCancelled: control.isCancelled,
  });

  const items: { fileName: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (control.isCancelled()) throw new MergeSplitCancelled();
    control.onStage(`正在生成「${segments[i].fileName}」…（${i + 1}/${parts.length}）`, i / parts.length);
    items.push({ fileName: segments[i].fileName, bytes: await parts[i].save() });
  }
  return { items };
}

// ===== 合并产物落盘（单文件：保存对话框） =====

/**
 * 合并结果写入用户选定的新文件：保存对话框 → 拒绝与任一源文件同路径 → 写入。
 * 结局三态与 SaveCopyResult 同构（paths 单元素）。
 */
export async function saveMergedPdf(
  bytes: Uint8Array,
  sourcePaths: readonly string[],
  defaultName: string,
): Promise<SaveCopyResult> {
  let target: string | null;
  try {
    target = await saveFileDialog({
      defaultPath: defaultName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  } catch (error) {
    return { status: "failed", message: `另存对话框调用失败：${describeError(error)}` };
  }
  if (!target) return { status: "cancelled" };
  const clash = sourcePaths.find((source) => sameDiskPath(target as string, source));
  if (clash) {
    return {
      status: "failed",
      message: "目标路径与源文件相同：为保护原文件，请换一个文件名或目录再保存。",
    };
  }
  try {
    await writeFile(target, bytes);
  } catch (error) {
    return { status: "failed", message: `写入文件失败：${describeError(error)}` };
  }
  return { status: "saved", path: target };
}

// ===== 拆分产物落盘（多文件：选目录 + 逐文件写入） =====

/** 弹「选择目录」对话框（拆分多文件的唯一入口，用户选定后才开始写盘）。 */
export async function pickSplitDirectory(): Promise<string | null> {
  const picked = await openFileDialog({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

/** 一个待写盘的拆分产物。 */
export interface SplitOutputItem {
  fileName: string;
  bytes: Uint8Array;
}

/**
 * 把拆分产物写入用户选定的目录：
 * 选目录 → 已存在同名文件探测（原生 confirm 二次确认覆盖）→ 逐文件写入。
 * 目录内其他文件一概不动；与源文件同路径的输出直接拒绝（理论上不可能出现
 * ——输出名必带 `_序号` 后缀，防御性保留）。
 */
export async function exportSplitFiles(
  items: readonly SplitOutputItem[],
  sourcePath: string,
): Promise<SaveCopyResult & { paths?: string[] }> {
  if (items.length === 0) {
    return { status: "failed", message: "没有可导出的内容：请检查拆分设置。" };
  }
  let directory: string | null;
  try {
    directory = await pickSplitDirectory();
  } catch (error) {
    return { status: "failed", message: `选择目录对话框调用失败：${describeError(error)}` };
  }
  if (!directory) return { status: "cancelled" };

  // 已存在同名文件：交由用户在原生确认框里定夺（覆盖 = 明确的二次授权）。
  const clashes: string[] = [];
  for (const item of items) {
    try {
      if (await exists(await join(directory, item.fileName))) clashes.push(item.fileName);
    } catch {
      // exists 探测失败不阻断：留给写入阶段报真实错误。
    }
  }
  if (clashes.length > 0) {
    let proceed = false;
    try {
      proceed = await confirmDialog(
        clashes.length === 1
          ? `目录中已存在「${clashes[0]}」，覆盖它吗？`
          : `目录中已存在 ${clashes.length} 个同名文件（如「${clashes[0]}」），全部覆盖吗？`,
        { title: "覆盖确认", kind: "warning" },
      );
    } catch {
      proceed = false;
    }
    if (!proceed) return { status: "cancelled" };
  }

  const paths: string[] = [];
  for (const item of items) {
    const target = await join(directory, item.fileName);
    if (sameDiskPath(target, sourcePath)) {
      return {
        status: "failed",
        message: `输出文件与源文件路径相同（${item.fileName}）：为保护原文件已中止，请重试并更换目录。`,
      };
    }
    try {
      await writeFile(target, item.bytes);
      paths.push(target);
    } catch (error) {
      return {
        status: "failed",
        message: `写入「${item.fileName}」失败：${describeError(error)}（已写入 ${paths.length} 个文件）`,
      };
    }
  }
  return { status: "saved", path: paths[0], paths };
}
