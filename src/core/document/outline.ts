import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OutlineNode } from "./store";

/**
 * 书签树解析（技术方案 5.1 第 4 条）：读取 getOutline() 并把每个书签的
 * 目标解析为 1 起页码，产出纯数据树。侧栏模块只消费 OutlineNode[]，
 * 不接触 pdfjs-dist 类型（4.3 规则 1）。
 */

/** pdf.js 大纲条目的最小结构（types 里 items 为 elided any，这里按实际字段收窄）。 */
interface RawOutlineItem {
  title: string;
  dest: string | Array<unknown> | null;
  url: string | null;
  items?: RawOutlineItem[];
}

/** 防御性上限：异常深的书签树直接截断，避免栈溢出/长时间阻塞。 */
const MAX_DEPTH = 64;
const MAX_NODES = 5000;

/** 把单个目标（命名目标或显式目标数组）解析为 1 起页码；不可解析返回 null。 */
async function resolveDestPage(doc: PDFDocumentProxy, dest: string | Array<unknown> | null): Promise<number | null> {
  if (dest === null) return null;
  let explicit: Array<unknown> | null;
  if (typeof dest === "string") {
    try {
      explicit = await doc.getDestination(dest);
    } catch {
      return null;
    }
  } else {
    explicit = dest;
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const ref = explicit[0];
  if (typeof ref !== "object" || ref === null) return null;
  try {
    const index = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return index + 1;
  } catch {
    return null;
  }
}

async function walk(
  doc: PDFDocumentProxy,
  items: RawOutlineItem[] | undefined,
  depth: number,
  counter: { count: number },
): Promise<OutlineNode[]> {
  if (!items || depth > MAX_DEPTH) return [];
  const nodes: OutlineNode[] = [];
  for (const item of items) {
    if (counter.count >= MAX_NODES) break;
    counter.count += 1;
    nodes.push({
      title: item.title || "（无标题书签）",
      pageNumber: await resolveDestPage(doc, item.dest),
      url: item.url ?? null,
      children: await walk(doc, item.items, depth + 1, counter),
    });
  }
  return nodes;
}

/** 解析整棵书签树；无书签或解析异常返回空数组（不抛出，装载数据不因书签缺失而失败）。 */
export async function readOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  try {
    const raw = await doc.getOutline();
    if (!Array.isArray(raw) || raw.length === 0) return [];
    return await walk(doc, raw as RawOutlineItem[], 1, { count: 0 });
  } catch {
    return [];
  }
}
