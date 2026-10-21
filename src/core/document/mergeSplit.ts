import {
  PDFArray,
  PDFDocument,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from "pdf-lib";
import {
  collectNamedDests,
  destPageKey,
  entryOf,
  refKey,
  resolve,
} from "./organizePdf";

/**
 * 合并拆分的纯 pdf-lib 变换层（M4，模块 5）：页码范围解析、拆分分段规划
 * （每 N 页 / 按顶级书签 / 按页码范围）、多文档合并（copyPages）、给输出文档
 * 挂顶级书签（手工构建 /Outlines，手法与 organizePdf 同源）。只依赖 pdf-lib、
 * 不碰 Tauri/文件系统——读原文件与落盘在 mergeSplitExport.ts，本文件因此可在
 * Node 下直接做真实回归（与 M3 的 organizePdf.ts 同款约定）。
 *
 * 模块边界：pdf-lib 只允许出现在 src/core/document（技术方案 4.3 规则 1），
 * 本文件不入 core/document/index.ts 桶导出，消费方直接 from。
 */

/** 用户取消（TaskControl.isCancelled 置位后在检查点抛出）。 */
export class MergeSplitCancelled extends Error {
  constructor() {
    super("已取消");
    this.name = "MergeSplitCancelled";
  }
}

/** 执行控制：进度（done/total 按页计）与取消轮询。 */
export interface TaskControl {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

/** 顶级书签（拆分「按书签」模式的定界依据；pageIndex 为 0 起，null=无页目标）。 */
export interface TopBookmark {
  title: string;
  pageIndex: number | null;
}

/** 拆分计划的一段：要拷贝的页（0 起，顺序即输出页序）+ 建议文件名。 */
export interface SplitSegment {
  indices: number[];
  fileName: string;
}

/** 合并的一个源文档条目：文档对象 + 要选取的页（0 起，顺序即输出页序）。 */
export interface MergeEntry {
  doc: PDFDocument;
  indices: number[];
}

/** 检查点：先查取消再报进度（保证取消后不再产出结果）。 */
function checkpoint(control: TaskControl, done: number, total: number): void {
  if (control.isCancelled?.()) throw new MergeSplitCancelled();
  control.onProgress?.(done, total);
}

// ===== 页码范围解析（验收 M4-2：「1-3,5,8」） =====

/** 范围解析结局：成功给 0 起页索引（按输入顺序，允许重复）；失败给中文原因。 */
export type PageRangesResult = { indices: number[] } | { error: string };

/**
 * 解析页码范围串：`1-3,5,8` → [0,1,2,4,7]（0 起）。
 * 宽容清洗：忽略空格、全角逗号/连字符按半角处理；页码 1 起。
 * 语义：按输入顺序、不去重（同一页写两次即拷两次）。
 */
export function parsePageRanges(input: string, numPages: number): PageRangesResult {
  const cleaned = input
    .replace(/[\uFF0C\u3001]/g, ",") // 全角逗号、顿号
    .replace(/[\uFF0D\u2013\u2014\u2212]/g, "-") // 全角连字符、en/em dash、减号
    .replace(/\s+/g, "")
    .trim();
  if (cleaned === "") return { error: "页码范围不能为空。" };
  const indices: number[] = [];
  const parts = cleaned.split(",");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) {
      return { error: `第 ${i + 1} 段「${part}」无法识别：请用页码或「起-止」格式，如 1-3,5。` };
    }
    const from = Number.parseInt(match[1], 10);
    const to = match[2] !== undefined ? Number.parseInt(match[2], 10) : from;
    if (from < 1 || to < 1) {
      return { error: `第 ${i + 1} 段页码从 1 开始（收到 ${part}）。` };
    }
    if (to < from) {
      return { error: `第 ${i + 1} 段「${part}」起页大于止页，请写小页码在前。` };
    }
    if (to > numPages) {
      return { error: `第 ${i + 1} 段止页 ${to} 超出文档范围（共 ${numPages} 页）。` };
    }
    for (let page = from; page <= to; page += 1) indices.push(page - 1);
  }
  return { indices };
}

/** 全部页索引（0 起，自然序）——范围留空 = 取整本。 */
export function allPageIndices(numPages: number): number[] {
  return Array.from({ length: numPages }, (_, i) => i);
}

// ===== 拆分分段规划 =====

/** 清理书签标题为可安全文件名：去 Windows 非法字符与控制符、折叠空白、截断。 */
export function sanitizeFileTitle(title: string, maxLen = 40): string | null {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- Windows 文件名禁控制字符
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (cleaned === "") return null;
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen);
}

/** 去掉扩展名的基础名（`报告.pdf` → `报告`；路径兜底）。 */
export function baseNameOf(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? fileName;
  return name.replace(/\.pdf$/i, "") || "文档";
}

/** 「每 N 页」分段（验收 M4-3）：`原名_1.pdf`…，末段可短于 N。 */
export function planEveryNSegments(numPages: number, everyN: number, baseName: string): SplitSegment[] {
  const n = Math.max(1, Math.floor(everyN));
  const segments: SplitSegment[] = [];
  for (let start = 0, seq = 1; start < numPages; start += n, seq += 1) {
    const end = Math.min(start + n, numPages);
    segments.push({
      indices: Array.from({ length: end - start }, (_, i) => start + i),
      fileName: `${baseName}_${seq}.pdf`,
    });
  }
  return segments;
}

/** 「按页码范围」分段：每个已解析段（一段的 indices）一个文件，`原名_1.pdf`…。 */
export function planRangeSegments(parsedSegments: readonly number[][], baseName: string): SplitSegment[] {
  return parsedSegments.map((indices, i) => ({ indices, fileName: `${baseName}_${i + 1}.pdf` }));
}

/** 「按顶级书签」分段结果：段 + 因空段/无页目标被跳过的书签标题（UI 提示用）。 */
export interface BookmarkPlan {
  segments: SplitSegment[];
  skipped: string[];
  /** 第一个有效书签之前的页数（不属于任何段，UI 提示「不导出」）。 */
  leadingPages: number;
}

/**
 * 「按顶级书签」分段（验收 M4-3）：每个顶级书签一段，范围 = 该书签目标页
 * → 下一个顶级书签目标页（末段到文档末尾）。命名 `原名_序号_书签名.pdf`
 * （标题清理后为空则退化为 `原名_序号.pdf`）。空段（相邻书签同页/乱序）
 * 与无页目标的书签跳过并计入 skipped；第一个书签之前的页面不导出。
 */
export function planBookmarkSegments(
  bookmarks: readonly TopBookmark[],
  numPages: number,
  baseName: string,
): BookmarkPlan {
  const skipped: string[] = [];
  // 收集时收窄为「有页目标」的锚点（push 后类型上仍是 null 联合，故显式重建）。
  const anchors: { title: string; pageIndex: number }[] = [];
  for (const mark of bookmarks) {
    if (mark.pageIndex === null) {
      skipped.push(mark.title);
      continue;
    }
    anchors.push({ title: mark.title, pageIndex: mark.pageIndex });
  }
  const leadingPages = anchors.length > 0 ? anchors[0].pageIndex : numPages;
  const segments: SplitSegment[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const start = anchors[i].pageIndex;
    const endExclusive = i + 1 < anchors.length ? anchors[i + 1].pageIndex : numPages;
    if (endExclusive <= start) {
      skipped.push(anchors[i].title);
      continue;
    }
    const seq = segments.length + 1;
    const title = sanitizeFileTitle(anchors[i].title);
    segments.push({
      indices: Array.from({ length: endExclusive - start }, (_, k) => start + k),
      fileName: title ? `${baseName}_${seq}_${title}.pdf` : `${baseName}_${seq}.pdf`,
    });
  }
  return { segments, skipped, leadingPages };
}

// ===== 合并与拆分（copyPages） =====

/**
 * 多文档合并（验收 M4-1/M4-2）：`PDFDocument.create` + 逐源文档一次
 * `copyPages`（indices 顺序即新文档页序）。**每源文档只调一次 copyPages**：
 * pdf-lib 每次调用独立走一个对象拷贝器，同源共享对象（字体/XObject）只在
 * 同一次调用内去重——逐页调用会把共享资源重复拷贝、输出成倍膨胀。
 * 进度按页累计、取消在源文档间检查点生效。
 */
export async function mergeToDocument(
  entries: readonly MergeEntry[],
  control: TaskControl,
): Promise<PDFDocument> {
  const out = await PDFDocument.create();
  const total = entries.reduce((sum, entry) => sum + entry.indices.length, 0);
  let done = 0;
  for (const entry of entries) {
    checkpoint(control, done, total);
    const copied = await out.copyPages(entry.doc, entry.indices);
    for (const page of copied) out.addPage(page);
    done += entry.indices.length;
    checkpoint(control, done, total);
  }
  return out;
}

/** 按分段拆分：每段 `PDFDocument.create` + `copyPages`（段内共享对象只拷一份）。 */
export async function splitToDocuments(
  source: PDFDocument,
  segments: readonly SplitSegment[],
  control: TaskControl,
): Promise<PDFDocument[]> {
  if (segments.length === 0) throw new Error("拆分计划为空：没有可拆分的段。");
  const total = segments.reduce((sum, seg) => sum + seg.indices.length, 0);
  let done = 0;
  const parts: PDFDocument[] = [];
  for (const segment of segments) {
    checkpoint(control, done, total);
    const part = await PDFDocument.create();
    const copied = await part.copyPages(source, segment.indices);
    for (const page of copied) part.addPage(page);
    parts.push(part);
    done += segment.indices.length;
    checkpoint(control, done, total);
  }
  return parts;
}

// ===== 输出文档的顶级书签（合并「按文件」降级策略，验收 M4-1） =====

/**
 * 给输出文档挂一列顶级书签（PDF 32000-1 12.3.2）：每条 `{标题, 页}` 一项，
 * /Dest 用 `[pageRef /Fit]`。pdf-lib 无 outline 高层 API，手工构建字典树
 * （与 organizePdf.pruneOrphanBookmarks 同一层的低层手法）。
 * pageIndex 越界的条目跳过（防御）；已有 /Outlines 时整体替换（输出文档
 * 均为本模块 create 的新文档，正常不会带）。
 */
export function attachTopLevelBookmarks(
  pdf: PDFDocument,
  items: readonly { title: string; pageIndex: number }[],
): void {
  const pages = pdf.getPages();
  const valid = items.filter((item) => item.pageIndex >= 0 && item.pageIndex < pages.length);
  if (valid.length === 0) return;
  const ctx = pdf.context;
  const outlinesRef = ctx.nextRef();
  const itemRefs = valid.map(() => ctx.nextRef());
  valid.forEach((item, i) => {
    const dict = PDFDict.withContext(ctx);
    dict.set(PDFName.of("Title"), PDFHexString.fromText(item.title));
    dict.set(PDFName.of("Parent"), outlinesRef);
    if (i > 0) dict.set(PDFName.of("Prev"), itemRefs[i - 1]);
    if (i < valid.length - 1) dict.set(PDFName.of("Next"), itemRefs[i + 1]);
    dict.set(PDFName.of("Dest"), ctx.obj([pages[item.pageIndex].ref, PDFName.of("Fit")]));
    ctx.assign(itemRefs[i], dict);
  });
  const outlines = PDFDict.withContext(ctx);
  outlines.set(PDFName.of("Type"), PDFName.of("Outlines"));
  outlines.set(PDFName.of("First"), itemRefs[0]);
  outlines.set(PDFName.of("Last"), itemRefs[valid.length - 1]);
  outlines.set(PDFName.of("Count"), PDFNumber.of(valid.length));
  ctx.assign(outlinesRef, outlines);
  pdf.catalog.set(PDFName.of("Outlines"), outlinesRef);
}

// ===== 顶级书签读取（拆分「按书签」的定界数据） =====

/**
 * 读文档的顶级书签（沿 /Outlines /First→/Next 链）：标题 + 目标页索引。
 * 目标解析复用 organizePdf 的 dest 逻辑（显式/命名 dest，与 M3 悬空书签
 * 判定同一套代码）；外链/无目标返回 pageIndex=null（由分段规划跳过）。
 */
export function readTopBookmarks(doc: PDFDocument): TopBookmark[] {
  const outlines = resolve(doc, entryOf(doc.catalog, "Outlines"));
  if (!(outlines instanceof PDFDict)) return [];
  const namedDests = (() => {
    const names = resolve(doc, entryOf(doc.catalog, "Names"));
    if (names instanceof PDFDict) {
      const dests = resolve(doc, entryOf(names, "Dests"));
      if (dests instanceof PDFDict) return collectNamedDests(doc, dests);
    }
    return new Map<string, PDFArray>();
  })();
  const pageIndexOf = new Map<string, number>();
  doc.getPages().forEach((page, index) => pageIndexOf.set(refKey(page.ref), index));

  const result: TopBookmark[] = [];
  let cursor = entryOf(outlines, "First");
  let guard = 0;
  while (cursor !== undefined && guard < 10000) {
    guard += 1;
    const dict = resolve(doc, cursor);
    if (!(dict instanceof PDFDict)) break;
    const titleValue = resolve(doc, entryOf(dict, "Title"));
    const title =
      titleValue instanceof PDFString || titleValue instanceof PDFHexString
        ? titleValue.decodeText() || "（无标题书签）"
        : "（无标题书签）";
    const key = destPageKey(doc, dict, namedDests);
    result.push({ title, pageIndex: key !== null ? pageIndexOf.get(key) ?? null : null });
    cursor = entryOf(dict, "Next");
  }
  return result;
}
