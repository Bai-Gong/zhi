import JSZip from "jszip";
import html2canvas from "html2canvas-pro";
import { PDFDocument } from "pdf-lib";
import { readSourceBytes } from "./highlightExport";
import { validateOfficeBytes } from "./officeValidation";
import { throwIfCancelled, type ConvertControl } from "./convertCommon";

export interface PresentationOptions { includeHidden: boolean }
export interface PresentationFileSummary { path: string; fileName: string; numPages: number; hiddenSlides: number }
interface Relation { path: string; external: boolean; type: string }
interface Slide { path: string; xml: Document; hidden: boolean }
export interface PresentationPackage { zip: JSZip; slides: Slide[]; width: number; height: number }
const MAX_FILE = 64 * 1024 * 1024;
const MAX_UNPACKED = 256 * 1024 * 1024;
const MAX_SLIDES = 300;
const EMU_PER_PX = 9525;
const all = (node: Document | Element, name: string): Element[] => Array.from(node.getElementsByTagNameNS("*", name));
const first = (node: Document | Element | undefined, name: string): Element | undefined => node ? all(node, name)[0] : undefined;
const child = (node: Element | undefined, name: string): Element | undefined => node ? Array.from(node.children).find(e => e.localName === name) : undefined;
const number = (node: Element | undefined, attr: string, fallback = 0): number => {
  const value = Number(node?.getAttribute(attr) ?? fallback);
  return Number.isFinite(value) ? value : fallback;
};
const attrId = (node: Element, local: string): string => Array.from(node.attributes).find(a => a.localName === local && a.prefix !== null)?.value ?? "";
function xml(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("演示文稿包含不支持的 XML 声明。");
  const result = new DOMParser().parseFromString(text, "application/xml");
  if (all(result, "parsererror").length) throw new Error("PPTX 内容已损坏，无法解析。");
  return result;
}
function relativePath(source: string, target: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) return "";
  const parts = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") { if (!parts.length) return ""; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
async function readXml(zip: JSZip, path: string): Promise<Document> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`PPTX 缺少内容：${path}`);
  return xml(await entry.async("string"));
}
async function relationships(zip: JSZip, path: string): Promise<Map<string, Relation>> {
  const parts = path.split("/"); const name = parts.pop();
  const relPath = [...parts, "_rels", `${name}.rels`].join("/");
  if (!zip.file(relPath)) return new Map();
  const doc = await readXml(zip, relPath);
  return new Map(all(doc, "Relationship").map(e => [e.getAttribute("Id") ?? "", {
    path: relativePath(path, e.getAttribute("Target") ?? ""),
    external: e.getAttribute("TargetMode") === "External",
    type: e.getAttribute("Type") ?? "",
  }]));
}

/** Shared package validation for both inspection and conversion; no files are extracted to disk. */
export async function parsePresentationBytes(bytes: Uint8Array): Promise<PresentationPackage> {
  validateOfficeBytes(bytes, "pptx");
  if (bytes.length > MAX_FILE) throw new Error("PPTX 超过 64 MB，暂不支持预览。");
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("不是有效的 PPTX，或文件已加密；请使用未加密的 .pptx 文件。");
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error("PPTX 压缩包已损坏。"); }
  const entries = Object.values(zip.files);
  if (entries.length > 10000) throw new Error("PPTX 内部文件过多，无法安全预览。");
  // JSZip records the central directory's uncompressed lengths before inflation.
  let total = 0;
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (size > 32 * 1024 * 1024 || (total += size) > MAX_UNPACKED) throw new Error("PPTX 解压后内容过大，无法安全预览。");
  }
  if (!zip.file("[Content_Types].xml") || !zip.file("ppt/presentation.xml")) throw new Error("文件内容不是有效的 PPTX 演示文稿。");
  const presentation = await readXml(zip, "ppt/presentation.xml");
  const rels = await relationships(zip, "ppt/presentation.xml");
  const size = first(presentation, "sldSz");
  const width = number(size, "cx", 9144000) / EMU_PER_PX;
  const height = number(size, "cy", 6858000) / EMU_PER_PX;
  if (width < 10 || height < 10 || width > 6000 || height > 6000) throw new Error("幻灯片尺寸超出支持范围。");
  const ids = all(presentation, "sldId");
  if (!ids.length || ids.length > MAX_SLIDES) throw new Error("演示文稿为空或超过 300 页，暂不支持预览。");
  const slides: Slide[] = [];
  for (const id of ids) {
    const relation = rels.get(attrId(id, "id"));
    if (!relation || relation.external || !relation.path) throw new Error("幻灯片引用已损坏。");
    const doc = await readXml(zip, relation.path);
    if (doc.getElementsByTagName("*").length > 100000 || all(doc, "sp").length + all(doc, "pic").length > 2000) throw new Error("单页幻灯片对象过多，请简化后重试。");
    slides.push({ path: relation.path, xml: doc, hidden: ["0", "false"].includes(doc.documentElement.getAttribute("show") ?? "") });
  }
  return { zip, slides, width, height };
}
export async function inspectPresentationFile(path: string): Promise<PresentationFileSummary> {
  const pkg = await parsePresentationBytes(await readSourceBytes(path));
  return { path, fileName: path.split(/[\\/]/).pop() || path, numPages: pkg.slides.length, hiddenSlides: pkg.slides.filter(s => s.hidden).length };
}

const DEFAULT_COLORS: Record<string, string> = { dk1: "000000", lt1: "FFFFFF", dk2: "1F497D", lt2: "EEECE1", accent1: "4F81BD", accent2: "C0504D", accent3: "9BBB59", accent4: "8064A2", accent5: "4BACC6", accent6: "F79646", tx1: "000000", bg1: "FFFFFF", tx2: "1F497D", bg2: "EEECE1" };
function color(node: Element | undefined, theme: Record<string, string>, fallback: string): string {
  const rgb = first(node, "srgbClr")?.getAttribute("val");
  const sys = first(node, "sysClr")?.getAttribute("lastClr");
  const scheme = first(node, "schemeClr")?.getAttribute("val");
  const value = rgb ?? sys ?? (scheme ? theme[scheme] : undefined);
  return value && /^[\da-f]{6}$/i.test(value) ? `#${value}` : fallback;
}
async function linkedXml(zip: JSZip, source: string, suffix: string): Promise<{path: string; xml: Document} | undefined> {
  const rels = await relationships(zip, source);
  const rel = Array.from(rels.values()).find(r => !r.external && r.type.endsWith(`/${suffix}`));
  return rel?.path && zip.file(rel.path) ? { path: rel.path, xml: await readXml(zip, rel.path) } : undefined;
}
function setText(box: HTMLElement, body: Element, theme: Record<string, string>, inheritedBody?: Element): void {
  box.style.overflowWrap = "anywhere";
  const bodyPr = child(body, "bodyPr");
  box.style.padding = `${number(bodyPr, "tIns", 45720) / EMU_PER_PX}px ${number(bodyPr, "rIns", 91440) / EMU_PER_PX}px ${number(bodyPr, "bIns", 45720) / EMU_PER_PX}px ${number(bodyPr, "lIns", 91440) / EMU_PER_PX}px`;
  for (const para of Array.from(body.children).filter(e => e.localName === "p")) {
    const p = document.createElement("div"); p.style.minHeight = "1em";
    const pPr = child(para, "pPr");
    const align = pPr?.getAttribute("algn"); p.style.textAlign = align === "ctr" ? "center" : align === "r" ? "right" : "left";
    const defaultPr = child(pPr, "defRPr") ?? first(body, "defRPr") ?? first(inheritedBody, "defRPr");
    if (child(pPr, "buChar")) p.append(document.createTextNode(`${child(pPr, "buChar")?.getAttribute("char") ?? "•"} `));
    for (const run of Array.from(para.children)) {
      if (run.localName === "br") { p.append(document.createElement("br")); continue; }
      if (run.localName !== "r" && run.localName !== "fld") continue;
      const span = document.createElement("span"); const pr = child(run, "rPr") ?? defaultPr;
      span.textContent = all(run, "t").map(t => t.textContent).join("");
      span.style.fontSize = `${number(pr, "sz", number(defaultPr, "sz", 1800)) / 100 * 4 / 3}px`;
      span.style.fontWeight = pr?.getAttribute("b") === "1" ? "bold" : "normal";
      span.style.fontStyle = pr?.getAttribute("i") === "1" ? "italic" : "normal";
      span.style.color = color(child(pr, "solidFill"), theme, "#000000");
      if (pr?.getAttribute("u") && pr.getAttribute("u") !== "none") span.style.textDecoration = "underline";
      span.style.whiteSpace = "pre-wrap";
      p.append(span);
    }
    box.append(p);
  }
}
async function renderSlide(pkg: PresentationPackage, slide: Slide, warnings: Set<string>, control: ConvertControl): Promise<HTMLElement> {
  const { zip } = pkg;
  const layout = await linkedXml(zip, slide.path, "slideLayout");
  const master = layout ? await linkedXml(zip, layout.path, "slideMaster") : undefined;
  const themeDoc = master ? await linkedXml(zip, master.path, "theme") : undefined;
  const theme = { ...DEFAULT_COLORS };
  const scheme = themeDoc && first(themeDoc.xml, "clrScheme");
  if (scheme) for (const c of Array.from(scheme.children)) theme[c.localName] = color(c, theme, `#${theme[c.localName] ?? "000000"}`).slice(1);
  const map = master && first(master.xml, "clrMap");
  if (map) for (const a of Array.from(map.attributes)) if (theme[a.value]) theme[a.name] = theme[a.value];
  const root = document.createElement("div");
  Object.assign(root.style, { width: `${pkg.width}px`, height: `${pkg.height}px`, position: "relative", overflow: "hidden", fontFamily: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif', boxSizing: "border-box", color: "#000", background: "#fff" });
  const bgOwner = [slide, layout, master].find(owner => owner && first(owner.xml, "bg"));
  const bg = bgOwner && first(bgOwner.xml, "bg");
  root.style.backgroundColor = color(bg, theme, "#fff");
  if (bg && first(bg, "gradFill")) warnings.add("渐变背景按基础颜色显示。");
  const bgBlip = first(bg, "blip");
  if (bgOwner && bgBlip) {
    const bgRels = await relationships(zip, bgOwner.path);
    const rel = bgRels.get(attrId(bgBlip, "embed"));
    const extension = rel?.path.split(".").pop()?.toLowerCase();
    const mime = extension === "png" ? "image/png" : ["jpg", "jpeg"].includes(extension ?? "") ? "image/jpeg" : extension === "gif" ? "image/gif" : undefined;
    const entry = rel && !rel.external && zip.file(rel.path);
    if (mime && entry) {
      const image = new Image(); image.src = `data:${mime};base64,${await entry.async("base64")}`;
      try { await image.decode(); root.style.backgroundImage = `url("${image.src}")`; root.style.backgroundSize = "100% 100%"; }
      catch { warnings.add("背景图片损坏，按基础颜色显示。"); }
    } else warnings.add("外部链接或特殊格式的背景图片未加载。");
  }
  const rels = await relationships(zip, slide.path);
  const tree = first(slide.xml, "spTree");
  if (!tree) throw new Error("幻灯片缺少页面内容。");
  if (all(slide.xml, "timing").length || all(slide.xml, "transition").length) warnings.add("动画与切换效果以静态页面显示。");
  for (const shape of Array.from(tree.children)) {
    throwIfCancelled(control);
    if (["nvGrpSpPr", "grpSpPr"].includes(shape.localName)) continue;
    if (shape.localName === "grpSp") { warnings.add("组合图形暂不支持完整还原。"); continue; }
    const placeholder = first(shape, "ph");
    const inheritedShape = (source: Document | undefined): Element | undefined => {
      if (!placeholder || !source) return undefined;
      const idx = placeholder.getAttribute("idx") ?? "0";
      const type = placeholder.getAttribute("type") ?? "body";
      const candidates = all(source, "sp").filter(candidate => first(candidate, "ph"));
      return candidates.find(candidate => (first(candidate, "ph")?.getAttribute("idx") ?? "0") === idx)
        ?? candidates.find(candidate => (first(candidate, "ph")?.getAttribute("type") ?? "body") === type);
    };
    const layoutShape = inheritedShape(layout?.xml);
    const masterShape = inheritedShape(master?.xml);
    const transform = first(shape, "xfrm") ?? first(layoutShape, "xfrm") ?? first(masterShape, "xfrm");
    const off = first(transform, "off"); const ext = first(transform, "ext");
    if (!off || !ext) { warnings.add("部分继承版式的对象缺少独立位置，未完整还原。"); continue; }
    const box = document.createElement("div");
    Object.assign(box.style, { position: "absolute", left: `${number(off, "x") / EMU_PER_PX}px`, top: `${number(off, "y") / EMU_PER_PX}px`, width: `${number(ext, "cx") / EMU_PER_PX}px`, height: `${number(ext, "cy") / EMU_PER_PX}px`, boxSizing: "border-box", overflow: "hidden" });
    const rotation = number(transform, "rot") / 60000;
    box.style.transform = `rotate(${rotation}deg) scale(${transform?.getAttribute("flipH") === "1" ? -1 : 1}, ${transform?.getAttribute("flipV") === "1" ? -1 : 1})`;
    const props = child(shape, "spPr") ?? child(layoutShape, "spPr") ?? child(masterShape, "spPr");
    if (child(props, "solidFill")) box.style.backgroundColor = color(child(props, "solidFill"), theme, "transparent");
    const line = child(props, "ln");
    if (line && !child(line, "noFill")) box.style.border = `${Math.max(1, number(line, "w", 12700) / EMU_PER_PX)}px solid ${color(line, theme, "#000")}`;
    if (first(props, "custGeom")) warnings.add("自定义路径形状按矩形近似显示。");
    const preset = first(props, "prstGeom")?.getAttribute("prst");
    if (preset === "ellipse") box.style.borderRadius = "50%";
    else if (preset === "roundRect") box.style.borderRadius = "12%";
    else if (preset && !["rect", "line"].includes(preset)) warnings.add("部分特殊形状按矩形近似显示。");
    const body = child(shape, "txBody"); if (body) setText(box, body, theme, child(layoutShape, "txBody") ?? child(masterShape, "txBody"));
    const table = first(shape, "tbl");
    if (table) {
      const element = document.createElement("table"); Object.assign(element.style, { borderCollapse: "collapse", width: "100%", height: "100%", tableLayout: "fixed" });
      const grid = document.createElement("colgroup");
      for (const col of all(table, "gridCol")) { const c = document.createElement("col"); c.style.width = `${number(col, "w") / EMU_PER_PX}px`; grid.append(c); }
      element.append(grid);
      for (const row of Array.from(table.children).filter(e => e.localName === "tr")) {
        const tr = document.createElement("tr"); tr.style.height = `${number(row, "h") / EMU_PER_PX}px`;
        for (const cell of Array.from(row.children).filter(e => e.localName === "tc")) {
          if (cell.getAttribute("hMerge") === "1" || cell.getAttribute("vMerge") === "1") continue;
          const td = document.createElement("td"); td.style.border = "1px solid #888"; td.style.padding = "0";
          td.colSpan = Math.max(1, number(cell, "gridSpan", 1)); td.rowSpan = Math.max(1, number(cell, "rowSpan", 1));
          td.style.background = color(child(child(cell, "tcPr"), "solidFill"), theme, "transparent");
          const text = child(cell, "txBody"); if (text) setText(td, text, theme); tr.append(td);
        }
        element.append(tr);
      }
      box.append(element);
    }
    if (first(shape, "srcRect")) warnings.add("图片裁切按完整图片近似显示。");
    const blips = all(shape, "blip");
    let hasImage = false;
    for (const blip of blips.slice(0, 1)) {
      const rel = rels.get(attrId(blip, "embed"));
      if (!rel || rel.external || !rel.path) { warnings.add("外部链接图片未加载。"); continue; }
      const extension = rel.path.split(".").pop()?.toLowerCase();
      const mime = extension === "png" ? "image/png" : ["jpg", "jpeg"].includes(extension ?? "") ? "image/jpeg" : extension === "gif" ? "image/gif" : undefined;
      const entry = zip.file(rel.path);
      if (!mime || !entry) { warnings.add("部分矢量或特殊格式图片暂不支持显示。"); continue; }
      const image = document.createElement("img"); image.src = `data:${mime};base64,${await entry.async("base64")}`;
      Object.assign(image.style, { width: "100%", height: "100%", objectFit: "fill" });
      try { await image.decode(); box.append(image); hasImage = true; } catch { warnings.add("部分图片损坏，无法显示。"); }
    }
    if (all(shape, "chart").length || all(shape, "relIds").length || all(shape, "videoFile").length || all(shape, "audioFile").length) {
      warnings.add("图表、SmartArt、音视频仅显示可用预览图，未完整还原。");
      if (!hasImage && !body && !table) { box.textContent = "此对象暂不支持预览"; box.style.background = "#f3f4f6"; }
    }
    if (first(shape, "graphicData") && !table && !hasImage && !body && !box.textContent) {
      warnings.add("部分嵌入对象暂不支持预览。"); box.textContent = "此对象暂不支持预览"; box.style.background = "#f3f4f6";
    }
    root.append(box);
  }
  // Master objects and rich style inheritance require a full Office layout engine.
  if (master && all(master.xml, "sp").some(s => !first(s, "ph"))) warnings.add("母版装饰对象和复杂继承样式可能未完整还原。");
  return root;
}
export async function runPresentationToPdf(file: {path: string; fileName: string}, options: PresentationOptions, control: ConvertControl): Promise<{bytes: Uint8Array; pageCount: number; warnings: string[]}> {
  control.onStage("正在读取演示文稿…", null); throwIfCancelled(control);
  const pkg = await parsePresentationBytes(await readSourceBytes(file.path)); throwIfCancelled(control);
  const slides = pkg.slides.filter(s => options.includeHidden || !s.hidden);
  if (!slides.length) throw new Error("没有可显示的幻灯片，请启用包含隐藏页。");
  const warnings = new Set<string>(["基础版式预览：复杂样式可能与原文不同；导出 PDF 为图片页面。"]);
  const pdf = await PDFDocument.create();
  const host = document.createElement("div");
  Object.assign(host.style, { position: "fixed", left: "-10000px", top: "0", pointerEvents: "none" });
  document.body.append(host);
  try {
    for (let i = 0; i < slides.length; i++) {
      throwIfCancelled(control); control.onStage(`正在转换幻灯片 ${i + 1}/${slides.length}…`, i / slides.length);
      const page = await renderSlide(pkg, slides[i], warnings, control); host.replaceChildren(page);
      await document.fonts.ready; throwIfCancelled(control);
      const scale = Math.min(2, 4096 / Math.max(pkg.width, pkg.height));
      const canvas = await html2canvas(page, { scale, backgroundColor: "#fff", logging: false, useCORS: false, allowTaint: false });
      throwIfCancelled(control);
      const png = await pdf.embedPng(canvas.toDataURL("image/png"));
      const output = pdf.addPage([pkg.width * .75, pkg.height * .75]); output.drawImage(png, { x: 0, y: 0, width: pkg.width * .75, height: pkg.height * .75 });
      canvas.width = 0; canvas.height = 0; host.replaceChildren();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throwIfCancelled(control); const bytes = await pdf.save(); throwIfCancelled(control);
    control.onStage("转换完成。", 1); return { bytes, pageCount: slides.length, warnings: [...warnings] };
  } finally { host.remove(); }
}
