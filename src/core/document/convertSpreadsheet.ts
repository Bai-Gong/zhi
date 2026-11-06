import * as XLSX from "xlsx";
import { validateOfficeBytes } from "./officeValidation";
import html2canvas from "html2canvas-pro";
import { PDFDocument } from "pdf-lib";
import { readSourceBytes } from "./highlightExport";
import { throwIfCancelled, type ConvertControl } from "./convertCommon";

export interface SpreadsheetOptions { sheetNames?: string[]; encoding?: "utf-8" | "gb18030" }
export interface SpreadsheetFileSummary {
  path: string; fileName: string; numPages: 0;
  sheets: { name: string; hidden: boolean }[];
}
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CELLS = 100_000;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;

export function parseSpreadsheet(bytes: Uint8Array, fileName: string, encoding: SpreadsheetOptions["encoding"] = "utf-8"): XLSX.WorkBook {
  if (bytes.length > MAX_BYTES) throw new Error("表格超过 32 MB，暂不能预览，请拆分后重试。");
  const csv = /\.csv$/i.test(fileName);
  if (!csv && !/\.xlsx$/i.test(fileName)) throw new Error("仅支持 .xlsx 和 .csv 表格。");
  if (!csv && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new Error("不是有效的 XLSX 文件，或文件已加密。");
  validateOfficeBytes(bytes, csv ? "csv" : "xlsx");
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(csv ? new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, "") : bytes,
      { type: csv ? "string" : "array", cellFormula: true, cellStyles: true, cellNF: true, raw: csv, sheetRows: MAX_ROWS + 1 });
  } catch { throw new Error("表格解析失败：文件可能损坏、加密或格式不正确。"); }
  if (!book.SheetNames.length) throw new Error("表格没有工作表。");
  let cells = 0;
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if ((sheet["!merges"]?.length ?? 0) > 1000) throw new Error("合并单元格过多，请拆分工作表后重试。");
    const ref = sheet["!fullref"] ?? sheet["!ref"];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    const rows = range.e.r - range.s.r + 1, cols = range.e.c - range.s.c + 1;
    cells += rows * cols;
    if (rows > MAX_ROWS || cols > MAX_COLUMNS || cells > MAX_CELLS) throw new Error("表格范围过大：最多支持 1 万行、256 列、合计 10 万单元格，请拆分后重试。");
  }
  return book;
}

export async function inspectSpreadsheetFile(path: string): Promise<SpreadsheetFileSummary> {
  const fileName = path.split(/[\\/]/).pop() || path;
  const book = parseSpreadsheet(await readSourceBytes(path), fileName);
  return { path, fileName, numPages: 0, sheets: book.SheetNames.map((name, i) => ({ name, hidden: !!book.Workbook?.Sheets?.[i]?.Hidden })) };
}

/** Keep vertically merged cells together. Oversized groups are scaled down as a whole. */
export function spreadsheetRowGroups(start: number, end: number, merges: readonly XLSX.Range[]): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = [];
  let row = start;
  while (row <= end) {
    let last = row;
    for (let r = row; r <= last; r++) {
      for (const merge of merges) if (merge.s.r <= r && merge.e.r >= r) last = Math.min(end, Math.max(last, merge.e.r));
    }
    groups.push({ start: row, end: last });
    row = last + 1;
  }
  return groups;
}

function makeTable(sheet: XLSX.WorkSheet, warnings: Set<string>): HTMLTableElement {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const table = document.createElement("table");
  table.style.cssText = "border-collapse:collapse;table-layout:fixed;font:12px Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#111;background:white;";
  const cols = document.createElement("colgroup");
  let width = 0;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const spec = sheet["!cols"]?.[c];
    const w = Math.min(600, Math.max(24, spec?.wpx ?? ((spec?.wch ?? spec?.width ?? 10) * 7 + 5)));
    const col = document.createElement("col"); col.style.width = `${w}px`; cols.append(col); width += w;
  }
  table.style.width = `${width}px`; table.append(cols);
  const merges = (sheet["!merges"] || []).filter(m => m.s.r >= range.s.r && m.e.r <= range.e.r && m.s.c >= range.s.c && m.e.c <= range.e.c);
  const covered = new Set<string>();
  const origins = new Map<string, XLSX.Range>();
  for (const merge of merges) {
    origins.set(`${merge.s.r},${merge.s.c}`, merge);
    for (let r = merge.s.r; r <= merge.e.r; r++) for (let c = merge.s.c; c <= merge.e.c; c++) {
      if (r !== merge.s.r || c !== merge.s.c) covered.add(`${r},${c}`);
    }
  }
  const body = document.createElement("tbody"); table.append(body);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const tr = document.createElement("tr");
    const rowHeight = sheet["!rows"]?.[r];
    if (rowHeight?.hpx || rowHeight?.hpt) tr.style.height = `${rowHeight.hpx ?? (rowHeight.hpt! * 4 / 3)}px`;
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const td = document.createElement("td");
      td.style.cssText = "border:1px solid #b8b8b8;padding:4px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;box-sizing:border-box;";
      const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      if (cell?.f && cell.v == null) { td.textContent = `=${cell.f}`; warnings.add("部分公式没有缓存结果，已显示公式文本；纸不会重新计算公式。"); }
      else td.textContent = cell ? XLSX.utils.format_cell(cell) : "";
      if (cell?.f) warnings.add("公式显示文件保存时的缓存结果，不重新计算。");
      if (cell?.t === "n") td.style.textAlign = "right";
      const merge = origins.get(`${r},${c}`);
      if (merge) { td.rowSpan = merge.e.r - merge.s.r + 1; td.colSpan = merge.e.c - merge.s.c + 1; }
      tr.append(td);
    }
    body.append(tr);
  }
  return table;
}

export async function runSpreadsheetToPdf(file: { path: string; fileName: string }, options: SpreadsheetOptions, control: ConvertControl): Promise<{ bytes: Uint8Array; pageCount: number; warnings: string[] }> {
  throwIfCancelled(control);
  control.onStage("正在读取表格…", null);
  const book = parseSpreadsheet(await readSourceBytes(file.path), file.fileName, options.encoding);
  throwIfCancelled(control);
  const names = options.sheetNames === undefined
    ? book.SheetNames.filter((_, i) => !book.Workbook?.Sheets?.[i]?.Hidden)
    : book.SheetNames.filter(name => options.sheetNames!.includes(name));
  if (options.sheetNames?.some(n => !book.SheetNames.includes(n))) throw new Error("所选工作表已不存在，请重新选择文件。");
  if (!names.length) throw new Error("请选择至少一个工作表。");
  if (names.some(n => !book.SheetNames.includes(n))) throw new Error("所选工作表已不存在，请重新选择文件。");
  const warnings = new Set<string>(["基础表格版式：字体、颜色及复杂样式可能变化；图表、绘图和外部数据不会加载。"]);
  const pdf = await PDFDocument.create();
  const pageW = 841.89, pageH = 595.28, margin = 28, contentW = pageW - margin * 2, contentH = pageH - margin * 2 - 24;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;z-index:-9999;pointer-events:none;background:white;color:#111;width:max-content;";
  document.body.append(host);
  try {
    for (let s = 0; s < names.length; s++) {
      throwIfCancelled(control);
      const name = names[s], sheet = book.Sheets[name];
      const table = makeTable(sheet, warnings); host.replaceChildren(table);
      const heading = document.createElement("canvas");
      heading.width = Math.ceil(contentW * 2); heading.height = 40;
      const headingContext = heading.getContext("2d");
      if (!headingContext) throw new Error("无法创建表格标题画布。");
      headingContext.scale(2, 2); headingContext.fillStyle = "#fff"; headingContext.fillRect(0, 0, contentW, 20);
      headingContext.fillStyle = "#333"; headingContext.font = "12px Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      headingContext.fillText(name, 0, 14, contentW);
      const headingBlob = await new Promise<Blob>((resolve, reject) => heading.toBlob(b => b ? resolve(b) : reject(new Error("表格标题生成失败。")), "image/png"));
      const headingImage = await pdf.embedPng(new Uint8Array(await headingBlob.arrayBuffer()));
      heading.width = 0; heading.height = 0;
      await document.fonts.ready;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const rect = table.getBoundingClientRect();
      const rows = Array.from(table.rows).map(row => { const r = row.getBoundingClientRect(); return { top: r.top - rect.top, bottom: r.bottom - rect.top }; });
      const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
      const groups = spreadsheetRowGroups(range.s.r, range.e.r, sheet["!merges"] || []);
      const scale = Math.min(1, contentW / rect.width);
      if (scale < 0.5) warnings.add("工作表列数较多，已缩放至一页宽，文字可能较小。");
      const slices: { top: number; bottom: number }[] = [];
      for (const group of groups) {
        const top = rows[group.start - range.s.r].top, bottom = rows[group.end - range.s.r].bottom;
        const prev = slices[slices.length - 1];
        if (prev && (bottom - prev.top) * scale <= contentH) prev.bottom = bottom;
        else slices.push({ top, bottom });
      }
      for (let i = 0; i < slices.length; i++) {
        throwIfCancelled(control);
        if (pdf.getPageCount() >= 500) throw new Error("转换超过 500 页，请减少工作表或拆分文件。");
        const slice = slices[i], height = slice.bottom - slice.top;
        const outputScale = Math.min(scale, contentH / height);
        if (outputScale < scale) warnings.add("超高行或跨行合并区域已整体缩小，以避免分页裁切内容。");
        control.onStage(`正在生成「${name}」第 ${i + 1}/${slices.length} 页…`, (s + i / slices.length) / names.length);
        const canvas = await html2canvas(table, { x: 0, y: slice.top, width: Math.ceil(rect.width), height: Math.ceil(height), scale: Math.min(2, 2 * outputScale), backgroundColor: "#fff", logging: false });
        throwIfCancelled(control);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("表格页面生成失败。")), "image/png"));
        const image = await pdf.embedPng(new Uint8Array(await blob.arrayBuffer()));
        const page = pdf.addPage([pageW, pageH]);
        page.drawImage(headingImage, { x: margin, y: pageH - margin - 20, width: contentW, height: 20 });
        page.drawImage(image, { x: margin, y: pageH - margin - 24 - height * outputScale, width: rect.width * outputScale, height: height * outputScale });
        canvas.width = 0; canvas.height = 0;
      }
    }
    throwIfCancelled(control);
    const bytes = await pdf.save();
    control.onStage("表格转换完成。", 1);
    return { bytes, pageCount: pdf.getPageCount(), warnings: [...warnings] };
  } finally { host.remove(); }
}
