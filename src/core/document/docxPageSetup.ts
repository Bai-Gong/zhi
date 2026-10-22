/**
 * .docx 自带页面设置解析（Word→PDF「设置一致」的依据）：
 * ZIP 中央目录定位 word/document.xml → 解压 → 取最后一处 w:sectPr 的
 * w:pgSz（纸型）与 w:pgMar（四边距），单位从 1/20 pt（dxa）换算成 pt。
 *
 * 零第三方依赖：ZIP 只读中央目录条目与局部头偏移，deflate 用运行时原生
 * DecompressionStream('deflate-raw')（WebView2/Chromium 与 Node ≥18 均内置）。
 * 任一环节缺失/异常一律返回 null——调用方兜底 A4 标准边距，不阻断转换。
 *
 * 模块边界：本文件只做字节→纯数据的解析，不碰 DOM/重库；不入桶导出，消费方直接 from。
 */

/** 文档页面设置（pt）：纸型宽高 + 四边距。 */
export interface DocxPageSetup {
  widthPt: number;
  heightPt: number;
  topPt: number;
  rightPt: number;
  bottomPt: number;
  leftPt: number;
}

/** 解析失败的兜底值：A4 + Word 中文版常规边距（上下 2.54cm、左右 3.17cm）。 */
export const FALLBACK_DOCX_PAGE_SETUP: DocxPageSetup = {
  widthPt: 595.28,
  heightPt: 841.89,
  topPt: 72,
  rightPt: 90,
  bottomPt: 72,
  leftPt: 90,
};

/** dxa（1/20 pt）→ pt，保留两位小数抹掉整数除法噪声。 */
function dxaToPt(dxa: number): number {
  return Math.round((dxa / 20) * 100) / 100;
}

/** 小端读 u16/u32。 */
function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/**
 * 在 ZIP 中央目录里找指定条目，返回其压缩数据区间与方法。
 * 只支持常规 32 位偏移（ZIP64 的 0xFFFFFFFF 哨兵直接判失败——docx 远小于 4GB）。
 */
function locateZipEntry(
  bytes: Uint8Array,
  wantedName: string,
): { start: number; compressedSize: number; method: number } | null {
  // EOCD（0x06054b50）自尾部倒扫：固定 22 字节 + 最多 64KB 注释
  const eocdMin = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= eocdMin; i -= 1) {
    if (readU32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = readU16(bytes, eocd + 10);
  let cursor = readU32(bytes, eocd + 16);
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > bytes.length || readU32(bytes, cursor) !== 0x02014b50) return null;
    const method = readU16(bytes, cursor + 10);
    const compressedSize = readU32(bytes, cursor + 20);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const localOffset = readU32(bytes, cursor + 42);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === wantedName) {
      // 局部头（0x04034b50）：名字/附加段长度与中央目录记录可能不同，须按局部头重读
      if (localOffset + 30 > bytes.length || readU32(bytes, localOffset) !== 0x04034b50) return null;
      const localNameLength = readU16(bytes, localOffset + 26);
      const localExtraLength = readU16(bytes, localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      return { start, compressedSize, method };
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function readZipText(bytes: Uint8Array, name: string): Promise<string | null> {
  const entry = locateZipEntry(bytes, name);
  if (!entry) return null;
  const slice = bytes.subarray(entry.start, entry.start + entry.compressedSize);
  const raw = entry.method === 0 ? slice : entry.method === 8 ? await inflateRaw(slice) : null;
  if (!raw) return null;
  return new TextDecoder().decode(raw);
}

/** 在标签字符串里取属性值（整数）。 */
function intAttr(tag: string, attr: string): number | null {
  const match = new RegExp(`${attr}\\s*=\\s*"(-?\\d+)"`).exec(tag);
  return match ? Number(match[1]) : null;
}

/**
 * 从 document.xml 文本提取页面设置：取**最后一处** w:sectPr（正文末尾的最终节；
 * 单节文档即唯一一处，多节文档以末节为准——分节各异时逐节还原属后置能力）。
 */
export function pageSetupFromDocumentXml(xml: string): DocxPageSetup | null {
  const sectMatches = [...xml.matchAll(/<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>/g)];
  const sect = sectMatches.length > 0 ? sectMatches[sectMatches.length - 1]![0] : null;
  if (!sect) return null;
  const pgSz = /<w:pgSz(?:\s[^>]*)?\/?>/.exec(sect)?.[0];
  const pgMar = /<w:pgMar(?:\s[^>]*)?\/?>/.exec(sect)?.[0];
  if (!pgSz || !pgMar) return null;
  const width = intAttr(pgSz, "w:w");
  const height = intAttr(pgSz, "w:h");
  const top = intAttr(pgMar, "w:top");
  const right = intAttr(pgMar, "w:right");
  const bottom = intAttr(pgMar, "w:bottom");
  const left = intAttr(pgMar, "w:left");
  if (width === null || height === null || top === null || right === null || bottom === null || left === null) {
    return null;
  }
  const setup: DocxPageSetup = {
    widthPt: dxaToPt(width),
    heightPt: dxaToPt(height),
    topPt: Math.max(0, dxaToPt(top)),
    rightPt: Math.max(0, dxaToPt(right)),
    bottomPt: Math.max(0, dxaToPt(bottom)),
    leftPt: Math.max(0, dxaToPt(left)),
  };
  // 合理性护栏：纸型应落在名信片到 A0 之间，且边距不能吃掉整个版心。
  if (setup.widthPt < 100 || setup.widthPt > 3400 || setup.heightPt < 100 || setup.heightPt > 3400) return null;
  if (setup.widthPt - setup.leftPt - setup.rightPt < 50 || setup.heightPt - setup.topPt - setup.bottomPt < 50) {
    return null;
  }
  return setup;
}

/**
 * 从 .docx 字节解析文档页面设置；任何环节失败返回 null（调用方兜底）。
 * 多节文档取末节；Word 的横向页在 pgSz 里直接写横向宽高，无需再看 orient。
 */
export async function parseDocxPageSetup(bytes: Uint8Array): Promise<DocxPageSetup | null> {
  try {
    const xml = await readZipText(bytes, "word/document.xml");
    if (!xml) return null;
    return pageSetupFromDocumentXml(xml);
  } catch {
    return null;
  }
}
