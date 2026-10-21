/**
 * 格式转换的纯布局算法（M6，模块 5）：零运行时依赖（不 import 任何库与
 * Tauri/pdf.js），只做「PDF 文本项 → 行 → 段落」与「分页切点规划」两件事，
 * 输入输出均为纯数据。抽成独立文件的目的是可在 Node 下直接做真实代码的
 * 边界验证（与 mergeSplit.ts「纯变换层可在 Node 回归」同款约定）。
 */

// ===== PDF 文本项 → 行 → 段落（PDF→Word 链路） =====

/** pdf.js 文本项的最小结构收窄（与 textIndex.ts 同款守卫）。 */
export function isRawTextItem(raw: unknown): raw is { str: string; transform: number[]; width: number } {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.str === "string" &&
    typeof r.width === "number" &&
    Array.isArray(r.transform) &&
    r.transform.length >= 6 &&
    r.transform.every((n) => typeof n === "number")
  );
}

/** 一个待聚行的文本片段（用户空间坐标：x/y 为基线起点）。 */
export interface TextPiece {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

/** 聚合后的文本行。 */
export interface TextLine {
  text: string;
  y: number;
  fontSize: number;
}

/** 文本矩阵 → 字号（pt）：竖向缩放为主、横向兜底。 */
export function fontSizeOf(transform: number[]): number {
  const vertical = Math.hypot(transform[2], transform[3]);
  if (vertical > 0.1) return vertical;
  return Math.hypot(transform[0], transform[1]) || 12;
}

/**
 * 一页的文本项 → 行（按基线 y 聚类，簇内按 x 排序）：
 * - 同行判定容差 max(1.5pt, 0.5×字号)——上下标与中西混排都能归行；
 * - 行内拼接按「间隙 > 0.3×字号 补一个空格」近似（中西文均适用：
 *   CJK 字距远小于字高不会误补，表格列间距会补空格分隔内容）。
 */
export function buildLines(items: ReadonlyArray<unknown>): TextLine[] {
  const pieces: TextPiece[] = [];
  for (const raw of items) {
    if (!isRawTextItem(raw)) continue; // marked content 等无 str 项
    if (raw.str.trim().length === 0) continue;
    pieces.push({
      text: raw.str,
      x: raw.transform[4],
      y: raw.transform[5],
      width: raw.width,
      fontSize: fontSizeOf(raw.transform),
    });
  }
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const clusters: { y: number; fontSize: number; pieces: TextPiece[] }[] = [];
  for (const piece of pieces) {
    const current = clusters[clusters.length - 1];
    if (
      current &&
      Math.abs(piece.y - current.y) <= Math.max(1.5, Math.max(piece.fontSize, current.fontSize) * 0.5)
    ) {
      current.pieces.push(piece);
      current.fontSize = Math.max(current.fontSize, piece.fontSize);
    } else {
      clusters.push({ y: piece.y, fontSize: piece.fontSize, pieces: [piece] });
    }
  }
  return clusters.map((cluster) => {
    const sorted = [...cluster.pieces].sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd: number | null = null;
    let prevSize = 12;
    for (const piece of sorted) {
      if (prevEnd !== null) {
        const gap = piece.x - prevEnd;
        if (gap > Math.max(1, prevSize * 0.3) && !text.endsWith(" ") && !piece.text.startsWith(" ")) {
          text += " ";
        }
      }
      text += piece.text;
      prevEnd = piece.x + piece.width;
      prevSize = piece.fontSize;
    }
    return {
      text: text.replace(/\s+/g, " ").trim(),
      y: cluster.y,
      fontSize: cluster.fontSize,
    };
  });
}

/**
 * 行 → 段落（自适应行距基准）：
 * - 与前一行同段的判据（满足其一）：紧邻（间距 ≤ 1.6×字号，覆盖单倍行距）；
 *   与本段既有行距一致（±35%，覆盖 1.5 倍行距、公文 28 磅固定行距等匀排）；
 *   段内第二行尚无基准时放宽到 2.4×字号；
 * - 字号突变（大小比 < 0.8，如标题对正文）直接分段；
 * - 行距匀排且段间无额外空距的文档，段界在几何上本就不可分（并入前段，
 *   属「按阅读顺序重建」的既定有损口径）。
 */
export function groupParagraphs(lines: readonly TextLine[]): TextLine[][] {
  const paragraphs: TextLine[][] = [];
  let runningGap: number | null = null;
  for (const line of lines) {
    if (line.text.length === 0) continue;
    const paragraph = paragraphs[paragraphs.length - 1];
    let joined = false;
    if (paragraph) {
      const previous = paragraph[paragraph.length - 1];
      const gap = previous.y - line.y;
      const font = Math.max(previous.fontSize, line.fontSize);
      const minor = Math.min(previous.fontSize, line.fontSize);
      if (minor < font * 0.8) {
        joined = false; // 标题/正文等字号断层
      } else if (gap <= font * 1.6) {
        joined = true;
      } else if (runningGap !== null && Math.abs(gap - runningGap) <= Math.max(2, runningGap * 0.35)) {
        joined = true;
      } else if (runningGap === null && gap <= font * 2.4) {
        joined = true;
      }
      if (joined) {
        paragraph.push(line);
        runningGap = gap; // 每并入一行都刷新行距基准（匀排文档的段界靠它识别）
        continue;
      }
    }
    paragraphs.push([line]);
    runningGap = null;
  }
  return paragraphs;
}

// ===== 分页切点规划（Word→PDF 链路） =====

/** 一个不可切割的布局盒（文本行 / 图片 / 分隔线），坐标相对排版容器顶。 */
export interface AtomicBox {
  top: number;
  bottom: number;
}

/** 小于该高度（px）的页放弃吸附改硬切：保证大盒（大图/长表）不产生近空页。 */
export const MIN_SLICE_PX = 60;

/** 末尾不足该高度的碎片段视为排版余量，由调用方并入上一页。 */
export const TAIL_EPSILON_PX = 4;

/**
 * 规划分页切点（0 起的切开位置数组，末尾以 totalHeight 收口由调用方补）：
 * 每 pageContentH 一个候选切点；若切点切进任何原子盒（跨盒即切字），把切点
 * 上移到该盒顶（吸附到行首）；吸附后不足 MIN_SLICE_PX 说明有整页高的大盒，
 * 退化为硬切（内容仍连续保留在相邻页）。y 每轮至少前进 MIN_SLICE_PX，必终止。
 */
export function planBoundaries(
  totalHeight: number,
  pageContentH: number,
  boxes: readonly AtomicBox[],
): number[] {
  const boundaries: number[] = [];
  let y = 0;
  while (y + pageContentH < totalHeight - TAIL_EPSILON_PX) {
    const candidate = y + pageContentH;
    let cut = candidate;
    for (const box of boxes) {
      if (box.top >= candidate) break; // 已排序，后面不会再跨
      if (box.bottom > candidate && box.top > y) {
        cut = Math.min(cut, box.top);
      }
    }
    if (cut - y < MIN_SLICE_PX) cut = candidate; // 大盒硬切
    boundaries.push(cut);
    y = cut;
  }
  return boundaries;
}
