import { inflateRaw, listZipEntries, type ZipEntryInfo } from "./docxPageSetup";

/**
 * Word→PDF 的 .docx 预处理（零第三方依赖）：在喂给 mammoth 之前修正两类
 * mammoth 无能力处理、且直接损害转换正确性的内容——
 *
 * 1. **OMML 公式（m:oMath）线性化为文本 run**：mammoth 对公式元素只报
 *    「unrecognised element ignored」，公式内容整块丢失（理科试卷转换后
 *    题干残缺）。这里把公式递归展开成线性文本——分数 (分子)/(分母)、上下标
 *    e^sup / e_sub、根号 √(…)、n 元算子按 m:chr 取符号——以 w:r 文本 run
 *    原位替换。「基础版式转换」定位内的诚实降级：内容不丢，不追求排版还原。
 * 2. **页边装饰性锚定浮动图形剥离**：密封线、页眉贴图等以浮动图形锚定，
 *    mammoth 会把它们拉平成正文流里的内联 <img> 且保持原始尺寸——窄长的
 *    密封线图高≈整页，每页凭空多出一整页高度，页数成倍膨胀、版面错乱。
 *    只剥离「装饰性」锚定对象：behindDoc=1（水印/衬底）或 wp:extent 高度
 *    超过约半页（页边长条）——正常尺寸的浮动配图（如正文照片）保留，
 *    mammoth 会把它内联到锚点段落，位置语义可接受。
 *
 * 实现：解出 word/document.xml → 前缀探测（命名空间前缀由文档自声明，
 * 不能写死 m:/w:/wp:）→ 字符串/树级变换 → 重打包 ZIP。其余条目（媒体/
 * 样式/关系）按原始压缩字节原样复制，不重压缩。任何环节失败都返回原始
 * 字节（best-effort，绝不阻断转换）。
 *
 * 模块边界：本文件只做字节→字节的重写，不碰 DOM/重库；不入桶导出，消费方直接 from。
 */

/** 预处理结果。 */
export interface DocxPreprocessResult {
  /** 重打包后的 .docx 字节（失败时原样返回输入）。 */
  bytes: Uint8Array;
  /** 线性化的公式数量。 */
  mathLinearized: number;
  /** 剥离的锚定浮动图形数量。 */
  floatsStripped: number;
}

// ===== XML 工具 =====

/** XML 实体解码（数值与命名）。 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** XML 实体编码（w:t 文本）。 */
function encodeXmlEntities(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 极小 XML 子树（OMML 片段专用：良好、无注释/CDATA/处理指令）。 */
interface XNode {
  /** 本地名（已去命名空间前缀）。 */
  tag: string;
  attrs: Record<string, string>;
  children: (XNode | string)[];
}

const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

/** 解析一段良好 XML 片段为子节点树（文本节点保留原文，取用时再解码）。 */
function parseXmlFragment(fragment: string): XNode {
  const root: XNode = { tag: "", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  const tagRe = /<(\/)?([\w.-]+(?::[\w.-]+)?)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/)?>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(fragment)) !== null) {
    if (match.index > cursor) {
      stack[0]!.children.push(fragment.slice(cursor, match.index));
    }
    const [, closing, rawTag, attrText, selfClosing] = match;
    const localName = rawTag!.includes(":") ? rawTag!.slice(rawTag!.indexOf(":") + 1) : rawTag!;
    if (closing) {
      if (stack.length > 1) stack.shift();
    } else {
      const attrs: Record<string, string> = {};
      let attrMatch: RegExpExecArray | null;
      ATTR_RE.lastIndex = 0;
      while ((attrMatch = ATTR_RE.exec(attrText ?? "")) !== null) {
        attrs[attrMatch[1]!] = decodeXmlEntities(attrMatch[2]!);
      }
      const node: XNode = { tag: localName, attrs, children: [] };
      stack[0]!.children.push(node);
      if (!selfClosing) stack.unshift(node);
    }
    cursor = tagRe.lastIndex;
  }
  if (cursor < fragment.length) stack[0]!.children.push(fragment.slice(cursor));
  return root;
}

/** 取节点下首个指定本地名的子节点。 */
function childByTag(node: XNode, tag: string): XNode | undefined {
  return node.children.find((c): c is XNode => typeof c !== "string" && c.tag === tag);
}

/** 单字符不加括号，多字符加圆括号（线性化可读性）。 */
function wrapMath(text: string): string {
  return text.length <= 1 ? text : `(${text})`;
}

/** OMML 节点 → 线性文本（未知节点递归拼接子级；*Pr 属性节点无文本自然为空）。 */
function linearizeMathNode(node: XNode): string {
  const inner = (): string =>
    node.children
      .map((c) => (typeof c === "string" ? decodeXmlEntities(c) : linearizeMathNode(c)))
      .join("");
  switch (node.tag) {
    case "t":
      return inner();
    case "f": {
      const num = childByTag(node, "num");
      const den = childByTag(node, "den");
      return `${wrapMath(num ? linearizeMathNode(num) : "")}/${wrapMath(den ? linearizeMathNode(den) : "")}`;
    }
    case "sSup": {
      const base = childByTag(node, "e");
      const sup = childByTag(node, "sup");
      return `${wrapMath(base ? linearizeMathNode(base) : "")}^${wrapMath(sup ? linearizeMathNode(sup) : "")}`;
    }
    case "sSub": {
      const base = childByTag(node, "e");
      const sub = childByTag(node, "sub");
      return `${wrapMath(base ? linearizeMathNode(base) : "")}_${wrapMath(sub ? linearizeMathNode(sub) : "")}`;
    }
    case "sSubSup": {
      const base = childByTag(node, "e");
      const sub = childByTag(node, "sub");
      const sup = childByTag(node, "sup");
      return `${wrapMath(base ? linearizeMathNode(base) : "")}_${wrapMath(sub ? linearizeMathNode(sub) : "")}^${wrapMath(
        sup ? linearizeMathNode(sup) : "",
      )}`;
    }
    case "rad": {
      const deg = childByTag(node, "deg");
      const body = childByTag(node, "e");
      const bodyText = body ? linearizeMathNode(body) : "";
      const degText = deg ? linearizeMathNode(deg) : "";
      return `${degText}√${wrapMath(bodyText)}`;
    }
    case "d":
      return `(${inner()})`;
    case "nary": {
      const naryPr = childByTag(node, "naryPr");
      const chrNode = naryPr ? childByTag(naryPr, "chr") : undefined;
      const symbol = chrNode?.attrs["m:val"] ?? chrNode?.attrs["val"] ?? "∫";
      return `${symbol}${inner()}`;
    }
    default:
      return inner();
  }
}

// ===== ZIP 重打包 =====

/** CRC32（ZIP 标准多项式）。 */
function crc32Of(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]!) & 0xff]!;
  }
  return (c ^ -1) >>> 0;
}
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** 尝试用 CompressionStream 压缩（deflate-raw）；环境不支持或失败返回 null。 */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

/** 小端写 u16/u32。 */
function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}
function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * 重打包 ZIP：除 word/document.xml 替换为新字节（优先 deflate，失败 store）
 * 外，其余条目按原始压缩字节与方法原样复制（不重压缩、CRC 沿用中央目录）。
 */
async function repackZip(source: Uint8Array, entries: ZipEntryInfo[], newDocumentXml: Uint8Array): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: { name: string; method: number; crc: number; compressedSize: number; uncompressedSize: number; offset: number }[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array) => {
    parts.push(chunk);
    offset += chunk.length;
  };
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    let data: Uint8Array;
    let method: number;
    let crc: number;
    let uncompressedSize: number;
    if (entry.name === "word/document.xml") {
      const compressed = await deflateRaw(newDocumentXml);
      data = compressed ?? newDocumentXml;
      method = compressed ? 8 : 0;
      crc = crc32Of(newDocumentXml);
      uncompressedSize = newDocumentXml.length;
    } else {
      data = source.subarray(entry.start, entry.start + entry.compressedSize);
      method = entry.method;
      crc = entry.crc32;
      uncompressedSize = entry.uncompressedSize;
    }
    const local = new Uint8Array(30 + nameBytes.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 6, 0);
    writeU16(local, 8, method);
    writeU16(local, 10, 0);
    writeU16(local, 12, 0);
    writeU32(local, 14, crc);
    writeU32(local, 18, data.length);
    writeU32(local, 22, uncompressedSize);
    writeU16(local, 26, nameBytes.length);
    writeU16(local, 28, 0);
    local.set(nameBytes, 30);
    central.push({ name: entry.name, method, crc, compressedSize: data.length, uncompressedSize, offset });
    push(local);
    push(data);
  }
  const centralStart = offset;
  for (const record of central) {
    const nameBytes = new TextEncoder().encode(record.name);
    const head = new Uint8Array(46 + nameBytes.length);
    writeU32(head, 0, 0x02014b50);
    writeU16(head, 4, 20);
    writeU16(head, 6, 20);
    writeU16(head, 8, 0);
    writeU16(head, 10, record.method);
    writeU16(head, 12, 0);
    writeU16(head, 14, 0);
    writeU32(head, 16, record.crc);
    writeU32(head, 20, record.compressedSize);
    writeU32(head, 24, record.uncompressedSize);
    writeU16(head, 28, nameBytes.length);
    writeU16(head, 30, 0);
    writeU16(head, 32, 0);
    writeU16(head, 34, 0);
    writeU16(head, 36, 0);
    writeU32(head, 38, 0);
    writeU32(head, 42, record.offset);
    head.set(nameBytes, 46);
    push(head);
  }
  const eocd = new Uint8Array(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 8, central.length);
  writeU16(eocd, 10, central.length);
  writeU32(eocd, 12, offset - centralStart);
  writeU32(eocd, 16, centralStart);
  push(eocd);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** 从根元素命名空间声明探测指定 URI 的前缀（探测不到返回默认值）。 */
function detectPrefix(xml: string, nsUri: string, fallback: string): string {
  const head = xml.slice(0, 4000);
  const match = new RegExp(`xmlns:([\\w.-]+)="${nsUri}"`).exec(head);
  return match?.[1] ?? fallback;
}

/**
 * 预处理 .docx 字节（best-effort）：公式线性化 + 浮动图形剥离 + 重打包。
 * 任何失败都原样返回输入字节，绝不抛出（转换链路不因此中断）。
 */
export async function preprocessDocxForMammoth(source: Uint8Array): Promise<DocxPreprocessResult> {
  try {
    const entries = listZipEntries(source);
    const docEntry = entries.find((e) => e.name === "word/document.xml");
    if (!docEntry) return { bytes: source, mathLinearized: 0, floatsStripped: 0 };
    const slice = source.subarray(docEntry.start, docEntry.start + docEntry.compressedSize);
    const raw = docEntry.method === 0 ? slice : docEntry.method === 8 ? await inflateRaw(slice) : null;
    if (!raw) return { bytes: source, mathLinearized: 0, floatsStripped: 0 };
    let xml = new TextDecoder().decode(raw);

    // 命名空间前缀由文档自声明，不能写死。
    const w = detectPrefix(xml, "http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w");
    const m = detectPrefix(xml, "http://schemas.openxmlformats.org/officeDocument/2006/math", "m");
    const wp = detectPrefix(xml, "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "wp");

    // 1) OMML 公式 → 线性文本 run（oMath 不自嵌套，非贪婪匹配安全）。
    let mathLinearized = 0;
    xml = xml.replace(new RegExp(`<${m}:oMath(?:\\s[^>]*)?>([\\s\\S]*?)</${m}:oMath>`, "g"), (_all, inner: string) => {
      mathLinearized += 1;
      const text = linearizeMathNode(parseXmlFragment(inner as string));
      return `<${w}:r><${w}:t xml:space="preserve">${encodeXmlEntities(text)}</${w}:t></${w}:r>`;
    });
    // oMathPara（公式段落壳）mammoth 同样不识别，会连内部替换产物一起丢弃，剥壳。
    xml = xml.replace(new RegExp(`</?${m}:oMathPara(?:\\s[^>]*)?>`, "g"), "");

/** 装饰性判定阈值：EMU（914400/英寸）。约 5,000,000 EMU ≈ 13.9cm ≈ 半页高。 */
const DECORATIVE_HEIGHT_EMU = 5_000_000;

    // 2) 装饰性锚定浮动图形剥离：behindDoc（水印/衬底）或高过约半页的
    //    长条（密封线/页眉贴图）——mammoth 原样内联它们会撑爆分页；
    //    正常尺寸浮动配图与 wp:inline（正文内联图）不受影响。
    let floatsStripped = 0;
    const anchorOpenRe = new RegExp(`<${wp}:anchor[^>]*>`);
    const extentCyRe = /cy="(\d+)"/;
    xml = xml.replace(new RegExp(`<${w}:drawing>[\\s\\S]*?</${w}:drawing>`, "g"), (block: string) => {
      const anchorTag = anchorOpenRe.exec(block)?.[0];
      if (anchorTag === undefined) return block; // 无锚定（wp:inline），保留
      const behind = anchorTag.includes('behindDoc="1"');
      const cy = Number(extentCyRe.exec(block)?.[1] ?? 0);
      if (!behind && cy < DECORATIVE_HEIGHT_EMU) return block; // 正常尺寸浮动配图，保留
      floatsStripped += 1;
      return "";
    });

    if (mathLinearized === 0 && floatsStripped === 0) {
      return { bytes: source, mathLinearized, floatsStripped };
    }
    const bytes = await repackZip(source, entries, new TextEncoder().encode(xml));
    return { bytes, mathLinearized, floatsStripped };
  } catch {
    return { bytes: source, mathLinearized: 0, floatsStripped: 0 };
  }
}
