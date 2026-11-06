export type DocumentFormat = "pdf" | "docx" | "xlsx" | "csv" | "pptx";
export type OfficeFormat = Exclude<DocumentFormat, "pdf">;
export const DOCUMENT_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx", "csv"];
export const MAX_OFFICE_BYTES = 64 * 1024 * 1024;

export function documentFormatOf(path: string): DocumentFormat | null {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  return DOCUMENT_EXTENSIONS.includes(ext ?? "") ? ext as DocumentFormat : null;
}

export function isSupportedDocument(path: string): boolean {
  return documentFormatOf(path) !== null;
}

/** Validate before decompression: encrypted, ZIP64, oversized and malformed packages fail explicitly. */
export function validateOfficeBytes(bytes: Uint8Array, format: OfficeFormat): void {
  if (!bytes.length) throw new Error("文件为空，无法预览。");
  if (bytes.length > MAX_OFFICE_BYTES) throw new Error("文件超过 64 MB，暂不支持预览，请拆分后重试。");
  if (format === "csv") {
    if (bytes.includes(0)) throw new Error("CSV 包含二进制内容；请使用 UTF-8 或 GB18030 文本文件。");
    return;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) {
    throw new Error("不是有效的 Office 文档，可能已加密、损坏或扩展名与内容不符。");
  }
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) {
      eocd = i; break;
    }
  }
  if (eocd < 0) throw new Error("Office 文档包目录损坏。");
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const directoryEnd = cursor + view.getUint32(eocd + 12, true);
  if (count > 10000 || directoryEnd > eocd || view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    throw new Error("文档包过大或采用不支持的分卷格式。");
  }
  let total = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Office 文档包目录损坏。");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const packed = view.getUint32(cursor + 20, true);
    const unpacked = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const next = cursor + 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    if ((flags & 1) || ![0, 8].includes(method)) throw new Error("暂不支持加密或特殊压缩的 Office 文档。");
    total += unpacked;
    if (total > 256 * 1024 * 1024 || unpacked > 64 * 1024 * 1024) throw new Error("文档解压后过大，请拆分后重试。");
    if (next > directoryEnd || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error("Office 文档数据损坏。");
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (dataStart + packed > cursor) throw new Error("Office 文档数据长度异常。");
    names.add(new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
    cursor = next;
  }
  const required = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[format];
  if (cursor !== directoryEnd || !names.has("[Content_Types].xml") || !names.has(required)) {
    throw new Error(`文件内容不是有效的 ${format.toUpperCase()} 文档。`);
  }
}

