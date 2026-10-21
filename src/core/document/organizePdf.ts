import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, PDFString, PDFHexString, degrees } from "pdf-lib";
import type { PDFObject } from "pdf-lib";

/**
 * 页面组织的纯 pdf-lib 变换层（M3，模块 5）：把「页序 + 旋转增量」落到一份
 * pdf-lib 文档对象上。只依赖 pdf-lib、不碰 Tauri/文件系统——
 * 导出落地（读原文件 → 对话框 → 写副本）在 pageOrganizeExport.ts，
 * 本文件因此可在 Node 下直接做真实回归（重排/旋转/书签清理是本里程碑核心风险）。
 *
 * 变换策略（为什么在原文档上重排页树而不是 create+copyPages）：
 * copyPages 到新文档会丢书签/Names/OpenAction 等目录级结构，而书签目标是对页
 * **对象**的引用（非页号）——直接重写页树叶子的顺序，引用原样有效，书签天然
 * 跟随页序（验收 M3-4「页序/朝向/书签导航均正确」）。指向被删页的书签悬空，
 * 由 {@link pruneOrphanBookmarks} 摘除（子书签提升保留）。
 */

/** 规范化旋转角到 0/90/180/270。 */
export function normalizeAngle(angle: number): 0 | 90 | 180 | 270 {
  return ((((angle % 360) + 360) % 360) as 0 | 90 | 180 | 270);
}

/**
 * 把组织结果落到内存中的文档：旋转（写 /Rotate）→ 页序与删除（重写页树叶子）→
 * 悬空书签清理。仅操作传入的 pdf-lib 文档对象，不触碰文件系统。
 * `order` 必须是 [0, 页数) 的无重子集（ensureSession 保证），否则抛错。
 */
export function applyOrganization(
  pdf: PDFDocument,
  order: readonly number[],
  rotationDelta: Readonly<Record<number, number>>,
): void {
  const pages = pdf.getPages();
  const inRange = order.every((src) => Number.isInteger(src) && src >= 0 && src < pages.length);
  if (!inRange || new Set(order).size !== order.length) {
    throw new Error("组织状态与文档页数不一致");
  }

  // 1) 旋转：按源索引写 /Rotate（在页树重排前完成——按源索引寻址与树序无关）。
  for (const [key, delta] of Object.entries(rotationDelta)) {
    const page = pages[Number(key)];
    if (page && delta) {
      page.setRotation(degrees(normalizeAngle(page.getRotation().angle + delta)));
    }
  }

  // 2) 页序与删除：全部摘出叶子（prune=false 保留中间树节点），再按 order 插回。
  //    refs 在摘除前取好；insertLeafNode 返回实际落入的父树节点，同步改叶子的
  //    /Parent（与官方 insertPage 的两步一致；不经过 PDFDocument.insertPage 是为
  //    绕开其页缓存并按源索引批量落位）。
  const refs = pages.map((page) => page.ref);
  const tree = pdf.catalog.Pages();
  for (let i = refs.length - 1; i >= 0; i -= 1) tree.removeLeafNode(i, false);
  order.forEach((sourceIndex, position) => {
    const ref = refs[sourceIndex];
    if (!ref) throw new Error("页树引用缺失，无法重排"); // inRange 已校验，防御即可
    // insertLeafNode 返回 undefined = 落入根 Pages 节点自身；此时叶子 /Parent
    // 应指根 Pages（catalog /Pages 条目的 ref，正常文档皆为 indirect 引用）。
    const rootPagesRef = entryOf(pdf.catalog, "Pages");
    const parentRef = tree.insertLeafNode(ref, position) ?? (rootPagesRef instanceof PDFRef ? rootPagesRef : undefined);
    if (parentRef) pages[sourceIndex].node.setParent(parentRef);
  });

  // 3) 悬空书签清理：指向被删页的书签摘除（子书签提升）。
  const keptKeys = new Set(order.map((sourceIndex) => refKey(refs[sourceIndex])));
  pruneOrphanBookmarks(pdf, keptKeys);
}

// ===== 悬空书签清理（PDF 32000-1 12.3.3） =====

/**
 * 以下低层辅助自 M4 起导出供本目录 mergeSplit.ts 复用（读顶级书签走同一套
 * dest 解析，不复制实现）；仍不入 core/document/index.ts 桶导出（pdf-lib 符号）。
 */

/** PDFRef 的稳定键（objectNumber:generation）。 */
export function refKey(ref: PDFRef): string {
  return `${ref.objectNumber}:${ref.generationNumber}`;
}

/** 字典条目读取（PDFName.of 一次封装）。 */
export function entryOf(dict: PDFDict, name: string): PDFObject | undefined {
  return dict.get(PDFName.of(name));
}

/** 写字典条目（undefined = 删除）。 */
function setEntry(dict: PDFDict, name: string, value: PDFObject | undefined): void {
  if (value === undefined) dict.delete(PDFName.of(name));
  else dict.set(PDFName.of(name), value);
}

/** 解析条目值：引用则解引用，直接对象原样返回。 */
export function resolve(pdf: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? pdf.context.lookup(value) : value;
}

/** 命名目标的键文本（PDFString/PDFHexString → 解码字符串；其余 null）。 */
function destNameText(value: PDFObject | undefined): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return null;
}

/** 书签显式目标数组（含命名目标查表）；非页跳转目标返回 null（不可判定/无目标）。 */
function explicitDestOf(dest: PDFObject | undefined, namedDests: Map<string, PDFArray>): PDFArray | null {
  if (!dest) return null;
  if (dest instanceof PDFArray) return dest;
  const name = destNameText(dest);
  if (name !== null) return namedDests.get(name) ?? null;
  return null;
}

/** 收集 /Names → /Dests 名字树的 name → dest 数组映射（递归 Kids，带防御上限）。 */
export function collectNamedDests(pdf: PDFDocument, destsRoot: PDFDict): Map<string, PDFArray> {
  const map = new Map<string, PDFArray>();
  const visit = (node: PDFDict, depth: number): void => {
    if (depth > 32 || map.size > 5000) return; // 防御：异常名字树直接截断
    const names = entryOf(node, "Names");
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = destNameText(names.get(i));
        const value = names.get(i + 1);
        if (key !== null && value instanceof PDFArray) map.set(key, value);
      }
    }
    const kids = entryOf(node, "Kids");
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i += 1) {
        const kid = resolve(pdf, kids.get(i));
        if (kid instanceof PDFDict) visit(kid, depth + 1);
      }
    }
  };
  visit(destsRoot, 0);
  return map;
}

/**
 * 摘除指向已删除页的书签：
 * - 沿 /First→/Next 逐级重建链表：悬空书签（显式或命名 dest 落在删除集）摘除，
 *   其**子书签提升**顶替到原位置（保内容，不做无效导航）；外链 URI/Launch、
 *   无法判定目标的一律保留；
 * - /Prev /Next /First /Last 全量重写；/Parent 复制同链现存的原值（不构造新引用）；
 * - /Count 按「原展开状态 × 剩余可见后代数」重算（正=展开、负=折叠、无子=删条目）。
 * 返回摘除的书签数。
 */
export function pruneOrphanBookmarks(pdf: PDFDocument, keptKeys: Set<string>): number {
  const outlines = resolve(pdf, entryOf(pdf.catalog, "Outlines"));
  if (!(outlines instanceof PDFDict)) return 0;

  const namedDests = (() => {
    const names = resolve(pdf, entryOf(pdf.catalog, "Names"));
    if (names instanceof PDFDict) {
      const dests = resolve(pdf, entryOf(names, "Dests"));
      if (dests instanceof PDFDict) return collectNamedDests(pdf, dests);
    }
    return new Map<string, PDFArray>();
  })();

  /** 书签是否悬空（目标页被删）。 */
  const isOrphan = (item: PDFDict): boolean => {
    const key = destPageKey(pdf, item, namedDests);
    return key !== null && !keptKeys.has(key);
  };

  interface ChainItem {
    /** 条目原值（可能是 PDFRef 或直接对象）：写兄弟链 /First /Last /Parent 时原样回写。 */
    raw: PDFObject;
    dict: PDFDict;
  }

  /** 读一条子链（沿 /Next），带防环节点上限。 */
  const readChain = (parent: PDFDict): ChainItem[] => {
    const items: ChainItem[] = [];
    let cursorRaw = entryOf(parent, "First");
    let guard = 0;
    while (cursorRaw !== undefined && guard < 10000) {
      guard += 1;
      const dict = resolve(pdf, cursorRaw);
      if (!(dict instanceof PDFDict)) break;
      items.push({ raw: cursorRaw, dict });
      cursorRaw = entryOf(dict, "Next");
    }
    return items;
  };

  /** 链上兄弟的 /Parent 原值（提升的子书签要改指它；取链首的原值最稳）。 */
  const parentValueOfChain = (chain: ChainItem[]): PDFObject | undefined =>
    chain.length > 0 ? entryOf(chain[0].dict, "Parent") : undefined;

  let removed = 0;

  /**
   * 处理 parent 的子链：先递归处理每个 item 自己的子链，再决定保留/摘除
   * （悬空者以其处理后的子链内联顶替），最后重写兄弟关系与 parent 的
   * First/Last/Count。返回处理后的链（供上层内联顶替）。
   * 深度超过 64 层的病态树不再摘除（防御栈溢出，书签原样保留）。
   */
  const processChain = (parent: PDFDict, depth: number): ChainItem[] => {
    const chain = readChain(parent);
    if (chain.length === 0 || depth > 64) return chain;
    const siblingParent = parentValueOfChain(chain);
    const kept: ChainItem[] = [];

    for (const item of chain) {
      const liftedChildren = processChain(item.dict, depth + 1);
      if (isOrphan(item.dict)) {
        removed += 1;
        // 悬空书签摘除；其子书签提升顶替（/Parent 改指被摘除者所在链的父级）。
        for (const child of liftedChildren) {
          setEntry(child.dict, "Parent", siblingParent ?? item.raw);
        }
        kept.push(...liftedChildren);
      } else {
        // 保留节点：把处理后的子链写回 First/Last/Count。
        if (liftedChildren.length === 0) {
          setEntry(item.dict, "First", undefined);
          setEntry(item.dict, "Last", undefined);
          setEntry(item.dict, "Count", undefined);
        } else {
          setEntry(item.dict, "First", liftedChildren[0].raw);
          setEntry(item.dict, "Last", liftedChildren[liftedChildren.length - 1].raw);
          setEntry(item.dict, "Count", recount(item.dict, liftedChildren, pdf));
        }
        kept.push(item);
      }
    }

    // 重写兄弟链（Prev/Next）与 parent 的 First/Last。
    for (let i = 0; i < kept.length; i += 1) {
      setEntry(kept[i].dict, "Prev", i > 0 ? kept[i - 1].raw : undefined);
      setEntry(kept[i].dict, "Next", i < kept.length - 1 ? kept[i + 1].raw : undefined);
    }
    // 链上无保留条目（全部悬空且无提升的子书签）：摘掉 parent 的 First/Last，
    // 与「保留节点无子时删 First/Last/Count」同语义；parent 自身去留（悬空摘除
    // 或降为叶子）由上层按同一规则决定，outline 根则由下方 Count 处理兜底。
    setEntry(parent, "First", kept.length > 0 ? kept[0].raw : undefined);
    setEntry(parent, "Last", kept.length > 0 ? kept[kept.length - 1].raw : undefined);
    return kept;
  };

  const topKept = processChain(outlines, 0);
  // outline root 的 /Count = 顶层剩余书签数（正数 = 初始展开语义，对阅读器足够）。
  if (topKept.length > 0) setEntry(outlines, "Count", PDFNumber.of(topKept.length));
  else setEntry(outlines, "Count", undefined);
  return removed;
}

/** 书签的目标页键（显式 dest 或命名 dest 的第一个元素）；无页目标返回 null。 */
export function destPageKey(pdf: PDFDocument, item: PDFDict, namedDests: Map<string, PDFArray>): string | null {
  const dest = entryOf(item, "Dest");
  if (dest !== undefined) {
    const explicit = explicitDestOf(resolve(pdf, dest), namedDests);
    return firstRefKey(explicit);
  }
  const action = resolve(pdf, entryOf(item, "A"));
  if (action instanceof PDFDict) {
    const type = resolve(pdf, entryOf(action, "S"));
    if (type instanceof PDFName && type.asString() === "/GoTo") {
      const explicit = explicitDestOf(resolve(pdf, entryOf(action, "D")), namedDests);
      return firstRefKey(explicit);
    }
  }
  return null;
}

/** 显式目标数组的第一个元素若为页引用则返回其键。 */
function firstRefKey(dest: PDFArray | null): string | null {
  if (!dest || dest.size() === 0) return null;
  const first = dest.get(0);
  return first instanceof PDFRef ? refKey(first) : null;
}

/** 按剩余子链重算书签 /Count：保留原展开（正）/折叠（负）语义。 */
function recount(item: PDFDict, children: { dict: PDFDict }[], pdf: PDFDocument): PDFObject {
  // 可见后代数：每个直接子节点自身 1 + 其展开（Count>0）时的后代数。
  let visible = 0;
  for (const child of children) {
    visible += 1;
    const childCountEntry = resolve(pdf, entryOf(child.dict, "Count"));
    const childCount = childCountEntry instanceof PDFNumber ? childCountEntry.asNumber() : 0;
    if (childCount > 0) visible += childCount;
  }
  const original = resolve(pdf, entryOf(item, "Count"));
  const originalCount = original instanceof PDFNumber ? original.asNumber() : 0;
  return PDFNumber.of(originalCount >= 0 ? visible : -visible);
}
