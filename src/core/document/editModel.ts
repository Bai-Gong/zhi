import { Encodings } from "@pdf-lib/standard-fonts";
import type { HighlightRect } from "./store";
import type { SearchTextItem } from "./textIndex";

/**
 * 基础编辑（M5）的内存对象模型与坐标换算——「覆盖补丁」模式的中间层
 * （里程碑 M5 技术要点的诚实定位：无重排引擎，原文以无衬底矩形遮盖，
 * 新内容叠加其上）。
 *
 * 坐标约定与 store.HighlightRect 完全一致：**PDF 用户空间，单位 pt，原点
 * 左下、y 向上，未做 /Rotate 归一**。编辑覆盖层（屏幕 CSS 像素）与 pdf-lib
 * 导出共用本文件的同源换算（技术方案 5.2 第 8 条「同 viewport」原则的编辑版）：
 * - 覆盖层：`userRectToCssRect` / `userPointToCss`，输入 scale=1 基准 viewport
 *   变换（`getViewport({ scale: 1 }).transform`）与封顶 cssScale，
 *   缩放、y 翻转、页面旋转一次换算到位；
 * - 导出：pdf-lib 同为用户空间且 y 同向，直接落笔；/Rotate 由阅读器统一施加，
 *   补丁随原文一起旋转、天然对齐（与 highlightExport 的零换算结论同源）。
 *
 * 模块边界：本文件不 import pdfjs-dist / pdf-lib 运行时（@pdf-lib/standard-fonts
 * 是 pdf-lib 1.17.1 的冻结传递依赖，锁文件内版本恒定），可被 features 层直接消费。
 */

// ===== 字体（诚实降级：pdf-lib 1.17.1 运行时不带 fontkit，无法嵌入自定义字体） =====

/** 编辑文本可选字体族（PDF 标准 14 字体的三族；中文支持见 {@link isVectorText}）。 */
export type EditFontId = "helvetica" | "times" | "courier";

export interface EditFontSpec {
  id: EditFontId;
  label: string;
  /** 浏览器预览用的 CSS 字体栈（与对应标准字体形近）。 */
  cssFamily: string;
}

/** 字体族清单（属性面板下拉与导出共用，勿各自另立）。 */
export const EDIT_FONTS: readonly EditFontSpec[] = [
  { id: "helvetica", label: "Helvetica（无衬线）", cssFamily: '"Helvetica Neue", Helvetica, Arial, "Microsoft YaHei", sans-serif' },
  { id: "times", label: "Times（衬线）", cssFamily: '"Times New Roman", Times, "SimSun", serif' },
  { id: "courier", label: "Courier（等宽）", cssFamily: '"Courier New", Courier, monospace' },
];

export function editFontSpec(id: EditFontId): EditFontSpec {
  return EDIT_FONTS.find((f) => f.id === id) ?? EDIT_FONTS[0];
}

/** 多行行距（em 倍数）：覆盖层预览 line-height 与导出落笔共用，两侧不得各自另立。 */
export const TEXT_LINE_HEIGHT = 1.25;

/**
 * 文本是否可作为**矢量文本**导出（pdf-lib 标准字体 + WinAnsi 编码）：
 * 逐码点查 pdf-lib 内置的 WinAnsi 编码表。中文/日文/韩文等均不可编码——
 * 这些文本将降级为高清位图嵌入（可读、无缺字，但导出后**不可再选中复制**，
 * UI 侧须明示，见里程碑 M5 验收 1 的降级说明）。
 */
export function isVectorText(text: string): boolean {
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint === 10) continue; // 换行：排版控制符，不参与编码
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(codePoint)) return false;
  }
  return true;
}

// ===== 编辑对象（纯数据；图片字节归 editStore 的会话图片表，对象只持引用） =====

/** 编辑文本对象：遮盖矩形（盖住原文）+ 新文本属性。 */
export interface TextEditObject {
  kind: "text";
  id: string;
  /** 1 起页码。 */
  pageNumber: number;
  /** 遮盖矩形（用户空间 pt，无衬底白色填充）。 */
  cover: HighlightRect;
  /** 新文本内容（允许 \n 多行）。 */
  text: string;
  /** 字号（pt）。 */
  fontSize: number;
  fontFamily: EditFontId;
  bold: boolean;
  italic: boolean;
  /** `#RRGGBB`（与 Highlight.color 同约定：覆盖层直接用，导出侧解析）。 */
  color: string;
}

/** 编辑图片对象：用户空间放置矩形（x/y 为左下角），位图经会话图片表引用。 */
export interface ImageEditObject {
  kind: "image";
  id: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 会话图片表（editStore.session.images）的键；替换图片 = 换引用。 */
  srcId: string;
}

export type EditObject = TextEditObject | ImageEditObject;

/** 会话图片资产：原始字节（导出用）+ objectUrl（覆盖层预览用）。 */
export interface EditImageAsset {
  bytes: Uint8Array;
  format: "png" | "jpg";
  objectUrl: string;
}

// ===== 坐标换算（用户空间 ⇄ 页内 CSS 像素；公式同 pdf.js Util.applyTransform） =====

/** pdf.js viewport 变换 [a,b,c,d,e,f]（scale=1 基准；行向量约定
 *  x' = a·x + c·y + e，y' = b·x + d·y + f）。与 viewer/highlightLayer 同构，
 *  编辑层不得跨模块 import viewer，故在此独立声明。 */
export type EditTransform = readonly [number, number, number, number, number, number];

/** 行向量仿射正变换（s = 封顶 cssScale，一次性完成缩放/翻转/旋转）。 */
function apply(t: EditTransform, s: number, x: number, y: number): [number, number] {
  return [t[0] * s * x + t[2] * s * y + t[4] * s, t[1] * s * x + t[3] * s * y + t[5] * s];
}

/** 仿射逆变换；奇异（det≈0，理论不可达）返回 null。 */
function invert(t: EditTransform): EditTransform | null {
  const det = t[0] * t[3] - t[1] * t[2];
  if (Math.abs(det) < 1e-9) return null;
  return [
    t[3] / det,
    -t[1] / det,
    -t[2] / det,
    t[0] / det,
    (t[2] * t[5] - t[4] * t[3]) / det,
    (t[4] * t[1] - t[5] * t[0]) / det,
  ];
}

/** 用户空间点 → 页内 CSS 像素点（覆盖层定位）。 */
export function userPointToCss(x: number, y: number, transform: EditTransform, cssScale: number): [number, number] {
  return apply(transform, cssScale, x, y);
}

/** 页内 CSS 像素点 → 用户空间点（双击命中、拖拽增量换算）。 */
export function cssPointToUser(cssX: number, cssY: number, transform: EditTransform, cssScale: number): [number, number] | null {
  const inv = invert(transform);
  if (!inv || cssScale <= 0) return null;
  return [
    (cssX / cssScale) * inv[0] + (cssY / cssScale) * inv[2] + inv[4],
    (cssX / cssScale) * inv[1] + (cssY / cssScale) * inv[3] + inv[5],
  ];
}

/** 页内 CSS 像素矩形（相对页项左上角）。 */
export interface EditCssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 用户空间矩形 → 页内 CSS 像素矩形（两角变换后取 min/max 归一四角）。 */
export function userRectToCssRect(rect: HighlightRect, transform: EditTransform, cssScale: number): EditCssRect {
  const [x1, y1] = apply(transform, cssScale, rect.x, rect.y);
  const [x2, y2] = apply(transform, cssScale, rect.x + rect.width, rect.y + rect.height);
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  return { left, top, width: right - left, height: bottom - top };
}

/** 页内 CSS 像素矩形 → 用户空间矩形（两角逆变换后取 min/max；缩放手柄在视觉
 *  空间算出新 AABB 后经此写回对象；奇异变换返回 null）。 */
export function cssRectToUserRect(rect: EditCssRect, transform: EditTransform, cssScale: number): HighlightRect | null {
  const p1 = cssPointToUser(rect.left, rect.top, transform, cssScale);
  const p2 = cssPointToUser(rect.left + rect.width, rect.top + rect.height, transform, cssScale);
  if (!p1 || !p2) return null;
  const x = Math.min(p1[0], p2[0]);
  const y = Math.min(p1[1], p2[1]);
  return { x, y, width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]) };
}

// ===== 双击命中：文本项 → 遮盖矩形 =====

/** 命中盒的升/降部占比（与 textIndex 搜索矩形同款近似：0.8/0.25 略放大）。 */
const HIT_ASCENT_RATIO = 0.8;
const HIT_DESCENT_RATIO = 0.25;
/** 命中盒外扩（pt）：盖住抗锯齿边缘，避免原字形残影。 */
export const COVER_PADDING = 1;

/**
 * 文本项整串的包围盒（用户空间 AABB）。与 textIndex.subItemRect 的整串版本
 * 同一套矩阵数学（该函数私有，编辑命中独立实现；两处比例常量保持同值）。
 * 无几何（空串/零尺寸）返回 null。
 */
export function textItemRect(item: SearchTextItem): HighlightRect | null {
  const length = item.str.length;
  if (length === 0 || !(item.width > 0)) return null;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform;
  const advance = Math.hypot(a, b);
  if (!(advance > 0)) return null;
  const dirX = a / advance;
  const dirY = b / advance;
  const fontHeight = Math.hypot(c, d);
  if (!(fontHeight > 0)) return null;
  const upX = c / fontHeight;
  const upY = d / fontHeight;
  const ex = e + dirX * item.width;
  const ey = f + dirY * item.width;
  const descent = fontHeight * HIT_DESCENT_RATIO;
  const ascent = fontHeight * HIT_ASCENT_RATIO;
  const x1 = Math.min(e, ex) + Math.min(upX * descent, -upX * ascent);
  const x2 = Math.max(e, ex) + Math.max(upX * descent, -upX * ascent);
  const y1 = Math.min(f, ey) + Math.min(upY * descent, -upY * ascent);
  const y2 = Math.max(f, ey) + Math.max(upY * descent, -upY * ascent);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** 点是否落在矩形内（含 {@link COVER_PADDING} 容差）。 */
function rectContains(rect: HighlightRect, x: number, y: number): boolean {
  return (
    x >= rect.x - COVER_PADDING &&
    x <= rect.x + rect.width + COVER_PADDING &&
    y >= rect.y - COVER_PADDING &&
    y <= rect.y + rect.height + COVER_PADDING
  );
}

/**
 * 双击命中测试：用户空间点 → 覆盖它的最小文本项（重叠行取面积最小者，
 * 双击目标通常是视觉上最贴近的一行）。返回遮盖矩形（已外扩）与原文本、
 * 估算字号；未命中返回 null。
 */
export function hitTextItem(
  items: readonly SearchTextItem[],
  x: number,
  y: number,
): { cover: HighlightRect; text: string; fontSize: number } | null {
  let best: { rect: HighlightRect; item: SearchTextItem } | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const rect = textItemRect(item);
    if (!rect || !(rect.width > 0 && rect.height > 0)) continue;
    if (!rectContains(rect, x, y)) continue;
    const area = rect.width * rect.height;
    if (area < bestArea) {
      bestArea = area;
      best = { rect, item };
    }
  }
  if (!best) return null;
  const { rect, item } = best;
  const [a = 0, b = 0, c = 0, d = 0] = item.transform;
  const fontSize = Math.hypot(c, d) || Math.hypot(a, b) || 12;
  const clean = item.str.replace(/\s+$/, "");
  if (clean.length === 0) return null;
  return {
    cover: {
      x: rect.x - COVER_PADDING,
      y: rect.y - COVER_PADDING,
      width: rect.width + COVER_PADDING * 2,
      height: rect.height + COVER_PADDING * 2,
    },
    text: clean,
    fontSize: Math.round(fontSize * 10) / 10,
  };
}

/** 编辑对象 id：uuid 优先（Tauri WebView2 安全上下文），退化为时间戳+序号。 */
let editSequence = 0;
export function makeEditObjectId(): string {
  editSequence += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `edit-${Date.now().toString(36)}-${editSequence}`;
}

/** 位置数字输入的夹取：pt 精度三位小数，负值合法（对象可部分移出页面）。 */
export function roundPt(value: number): number {
  return Math.round(value * 1000) / 1000;
}
