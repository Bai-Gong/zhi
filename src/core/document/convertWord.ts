import { Document, Packer, Paragraph, TextRun } from "docx";
import * as mammoth from "mammoth";
import { readSourceBytes } from "./highlightExport";
import { baseNameOf } from "./mergeSplit";
import {
  saveConvertedFile,
  throwIfCancelled,
  withStandalonePdf,
  type ConvertControl,
} from "./convertCommon";
import { buildLines, groupParagraphs, type TextLine } from "./convertLayout";
import { paginateWordHtml, type WordPdfPaper } from "./wordPagination";

/**
 * PDF ⇄ Word 转换层（M6，模块 5；里程碑 M6-3/M6-4）：
 * - PDF→Word：pdf.js 逐页抽文本项（str+矩阵）→ 按「同一基线聚行、行距聚段」
 *   重建阅读顺序段落 → docx 包生成 .docx（每 PDF 页前插分页符）。表格在文本
 *   层没有结构信息，按行降级为文本（内容不丢，验收 M6-3 的口径）；
 * - Word→PDF：mammoth 转 HTML → wordPagination 分页成册（复杂版式由 mammoth
 *   丢弃并在结果中计数提示「基础版式转换」）。
 *
 * 模块边界：docx / mammoth（重库）与 pdfjs-dist 只在 src/core/document；
 * 本文件不入桶导出，消费方直接 from。
 */

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ===== PDF → Word =====

/** PDF→Word 执行结果。 */
export interface PdfToWordResult {
  bytes: Uint8Array;
  /** 重建的段落数。 */
  paragraphCount: number;
  pageCount: number;
  /** 未提取到文本的页数（可能含扫描页，结果页提示）。 */
  emptyPages: number;
}

/**
 * PDF→Word 执行（验收 M6-3）：逐页抽文本 → 行/段重建 → docx 落段。
 * `pageBreaks` 开启时每个 PDF 页的首段带 pageBreakBefore（页对应关系可核；
 * 关闭则正文连排）。整册无文本（纯扫描件）直接失败并说明需 OCR（后置能力）。
 * 取消在页间安全点生效。
 */
export async function runPdfToWord(
  file: { path: string; fileName: string },
  options: { pageBreaks: boolean },
  control: ConvertControl,
): Promise<PdfToWordResult> {
  return withStandalonePdf(file.path, file.fileName, async (doc) => {
    const pageParagraphs: TextLine[][][] = [];
    let totalChars = 0;
    let emptyPages = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      throwIfCancelled(control);
      control.onStage(
        `正在提取文本…（${pageNumber}/${doc.numPages}）`,
        doc.numPages > 0 ? (pageNumber - 1) / doc.numPages : null,
      );
      const page = await doc.getPage(pageNumber);
      let lines: TextLine[] = [];
      try {
        const content = await page.getTextContent();
        lines = buildLines(content.items);
      } catch (error) {
        // 单页失败按空页落空，不拖垮整册（与 textIndex 同口径）。
        console.warn(`第 ${pageNumber} 页文本提取失败：`, error);
      }
      page.cleanup();
      const paragraphs = groupParagraphs(lines);
      if (paragraphs.length === 0) emptyPages += 1;
      totalChars += paragraphs.reduce((sum, p) => sum + p.reduce((s, l) => s + l.text.length, 0), 0);
      pageParagraphs.push(paragraphs);
    }
    if (totalChars === 0) {
      throw new Error(
        "该 PDF 没有可提取的文本（可能是扫描图片型文档）：需要 OCR 才能转 Word，OCR 属后置能力，暂不支持。",
      );
    }

    control.onStage("正在生成 Word 文档…", 0.95);
    const children: Paragraph[] = [];
    let paragraphCount = 0;
    pageParagraphs.forEach((paragraphs, pageIndex) => {
      paragraphs.forEach((paragraph, index) => {
        paragraphCount += 1;
        children.push(
          new Paragraph({
            pageBreakBefore: options.pageBreaks && pageIndex > 0 && index === 0,
            children: paragraph.map(
              (line, lineIndex) =>
                new TextRun({
                  text: line.text,
                  // docx 字号单位是半磅（half-point）。
                  size: Math.max(12, Math.round(line.fontSize * 2)),
                  break: lineIndex === 0 ? undefined : 1,
                }),
            ),
          }),
        );
      });
    });
    const document = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(document);
    control.onStage("转换完成。", 1);
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      paragraphCount,
      pageCount: doc.numPages,
      emptyPages,
    };
  });
}

/** .docx 产物的保存对话框默认名：`报告.docx` → `报告.docx`（同名时由用户改）。 */
export function suggestDocxName(fileName: string): string {
  return `${baseNameOf(fileName)}.docx`;
}

/** .docx 产物落盘（保存对话框 + 副本铁律，见 convertCommon.saveConvertedFile）。 */
export async function saveConvertedDocx(
  bytes: Uint8Array,
  sourcePaths: readonly string[],
  defaultName: string,
): Promise<{ status: "saved"; path: string } | { status: "cancelled" } | { status: "failed"; message: string }> {
  return saveConvertedFile({
    bytes,
    sourcePaths,
    defaultName,
    filterName: "Word 文档",
    extensions: ["docx"],
  });
}

// ===== Word → PDF =====

/** 向导文件步的 Word 元信息（.docx 无固定页数概念，numPages 占位 1，页数由转换分页决定）。 */
export interface DocxFileSummary {
  path: string;
  fileName: string;
  numPages: 1;
}

/**
 * 解析一个 .docx（转换向导的 inspect）：ZIP 魔数（PK）粗校验 + 扩展名口径。
 * 深度解析留给 mammoth（执行步），此处只拦截明显不是 docx 的文件。
 */
export async function inspectDocxFile(path: string): Promise<DocxFileSummary> {
  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(path);
  } catch (error) {
    throw new Error(`读取文件失败：${describeError(error)}`);
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("不是有效的 Word 文档（.docx）：旧版 .doc 格式不支持，请在 Word 中另存为 .docx。");
  }
  return { path, fileName: path.split(/[\\/]/).pop() || path, numPages: 1 };
}

/** Word→PDF 执行结果。 */
export interface WordToPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  /** mammoth 报告的不支持内容条数（>0 时结果页提示「部分复杂版式已降级」）。 */
  ignoredCount: number;
}

/** Word→PDF 执行（验收 M6-4）：mammoth → 分页 DOM → 截图 → pdf-lib 成册。 */
export async function runWordToPdf(
  file: { path: string; fileName: string },
  options: { paper: WordPdfPaper; marginPt: number },
  control: ConvertControl,
): Promise<WordToPdfResult> {
  control.onStage("正在读取并解析 Word 文档…", null);
  let bytes: Uint8Array;
  try {
    bytes = await readSourceBytes(file.path);
  } catch (error) {
    throw new Error(`读取「${file.fileName}」失败：${describeError(error)}`);
  }
  // mammoth 需要 ArrayBuffer；bytes.slice() 复制一份（原视图可能被复用）。
  let html: string;
  let ignoredCount = 0;
  try {
    const copy = bytes.slice();
    const result = await mammoth.convertToHtml({ arrayBuffer: copy.buffer });
    html = result.value;
    ignoredCount = result.messages.length;
  } catch (error) {
    throw new Error(
      `解析 Word 文档失败：${describeError(error)}（仅支持 .docx；文件可能已损坏或是旧版 .doc）`,
    );
  }
  if (html.replace(/<[^>]+>/g, "").trim().length === 0 && !html.includes("<img")) {
    throw new Error("该 Word 文档没有可转换的内容。");
  }
  const { bytes: pdfBytes, pageCount } = await paginateWordHtml(html, options, control, ignoredCount);
  return { bytes: pdfBytes, pageCount, ignoredCount };
}
