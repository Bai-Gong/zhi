import { readSourceBytes } from "./highlightExport";
import { throwIfCancelled, type ConvertControl } from "./convertCommon";

import { documentFormatOf, validateOfficeBytes } from "./officeValidation";
export * from "./officeValidation";

export interface OfficeConversionOptions {
  encoding?: "utf-8" | "gb18030";
  sheetNames?: string[];
  includeHidden?: boolean;
}

export interface OfficeConversionResult {
  bytes: Uint8Array;
  pageCount: number;
  warnings: string[];
}

/** Every format shares the same local conversion entry point; no converted file is persisted automatically. */
export async function convertOfficeDocument(
  file: { path: string; fileName: string },
  control: ConvertControl,
  options: OfficeConversionOptions = {},
): Promise<OfficeConversionResult> {
  const format = documentFormatOf(file.path);
  if (!format || format === "pdf") throw new Error("不支持的 Office 文件格式。");
  throwIfCancelled(control);
  control.onStage("正在检查文档…", null);
  validateOfficeBytes(await readSourceBytes(file.path), format);
  throwIfCancelled(control);
  let result: OfficeConversionResult;
  if (format === "docx") {
    const { runWordToPdf } = await import("./convertWord");
    const word = await runWordToPdf(file, control);
    const warnings: string[] = [];
    if (word.ignoredCount) warnings.push(`有 ${word.ignoredCount} 项复杂内容或版式已降级。`);
    if (word.mathLinearized) warnings.push(`${word.mathLinearized} 处公式以文本形式保留。`);
    if (word.floatsStripped) warnings.push(`${word.floatsStripped} 个页边装饰对象未保留。`);
    result = { bytes: word.bytes, pageCount: word.pageCount, warnings };
  } else if (format === "pptx") {
    const { runPresentationToPdf } = await import("./convertPresentation");
    result = await runPresentationToPdf(file, { includeHidden: options.includeHidden ?? false }, control);
  } else {
    const { runSpreadsheetToPdf } = await import("./convertSpreadsheet");
    result = await runSpreadsheetToPdf(file, { encoding: options.encoding ?? "utf-8", sheetNames: options.sheetNames }, control);
  }
  throwIfCancelled(control);
  return { ...result, warnings: ["基础版式预览：复杂排版可能降级，导出 PDF 为图片页面，暂不支持文字搜索或选择。", ...result.warnings] };
}
