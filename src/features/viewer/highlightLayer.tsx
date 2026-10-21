// 高亮覆盖层与「另存副本」浮动条（M2-3 / M2-计划 D5 的查看层）。
// 覆盖层矩形与画布/文本层同一 viewport 语义定位（技术方案 5.2 第 8 条、风险 6
// 「同源」原则）：坐标换算只依赖两样东西——core 的 getPage 取回的 scale=1 基准
// viewport 变换，与 renderQueue 同源的 capScaleForRaster 封顶缩放，不另立坐标系。
// 本模块零 pdfjs-dist / pdf-lib import（4.3 规则 1），换算公式与 pdf.js
// Util.applyTransform / applyInverseTransform 逐项一致（已用 node 脚本对
// 0/90/180/270 四个旋转档实测零误差）。
import { useState, type ReactNode, type RefObject } from "react";
import { FolderOpen, Highlighter, X } from "lucide-react";
import { useDocumentStore, activeTabOf, type Highlight, type HighlightRect } from "../../core/document";
import { saveHighlightCopy, revealSavedCopy } from "../../core/document/highlightExport";
import "./highlightLayer.css";

/**
 * 高亮色板（≥3 色，验收 M2-3）。这是**内容语义色**而非 UI 主题色：必须与导出到
 * 副本的颜色逐字节一致，且不随深色主题翻转，故不走 theme CSS 变量、以常量落码；
 * 约定 `#RRGGBB`（store.Highlight.color 的既定格式，导出侧按此解析）。
 */
export const HIGHLIGHT_COLORS = [
  { value: "#ffe066", label: "黄色" },
  { value: "#8ce99a", label: "绿色" },
  { value: "#74c0fc", label: "蓝色" },
  { value: "#ffa8a8", label: "红色" },
] as const;

/** 覆盖层不透明度（与 highlightExport.HIGHLIGHT_EXPORT_OPACITY 同值：屏幕呈现与
 * 导出副本目检一致）。 */
const HIGHLIGHT_VIEW_ALPHA = 0.35;
/** 选中态强调（仅查看态；导出仍用上面的值）。 */
const HIGHLIGHT_SELECTED_ALPHA = 0.5;

/** pdf.js viewport 变换 [a, b, c, d, e, f]（scale=1 基准；行向量约定
 * x' = a·x + c·y + e，y' = b·x + d·y + f）。 */
export type ViewportTransform = readonly [number, number, number, number, number, number];

/** 页内 CSS 像素矩形（相对页项左上角，与覆盖层/操作条同一参照系）。 */
export interface LayerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 行向量仿射正变换（公式同 pdf.js Util.applyTransform）；s 为整体缩放因子。 */
function applyTransform(t: ViewportTransform, s: number, x: number, y: number): [number, number] {
  return [t[0] * s * x + t[2] * s * y + t[4] * s, t[1] * s * x + t[3] * s * y + t[5] * s];
}

/** 仿射逆变换（公式同 pdf.js Util.applyInverseTransform）；奇异（det≈0）返回 null。 */
function invertTransform(t: ViewportTransform): ViewportTransform | null {
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

function applyInverse(inv: ViewportTransform, x: number, y: number): [number, number] {
  return [x * inv[0] + y * inv[2] + inv[4], x * inv[1] + y * inv[3] + inv[5]];
}

/**
 * 用户空间矩形 → 页内 CSS 像素矩形（覆盖层定位的唯一换算入口）。
 * 为什么可直接乘 cssScale：pdf.js 的 viewport(s).transform 逐项等于
 * s × viewport(1).transform（线性缩放，四个旋转档实测零误差），所以缓存 scale=1
 * 基准变换后，任意缩放都能同步换算——一次完成缩放、y 轴翻转与页面旋转，
 * 等价于官方 convertToViewportRectangle（v6 已移除该方法，语义由本函数承接，
 * 见 store.HighlightRect 的换算约定）。两角变换后取 min/max 归一四角。
 */
export function userRectToLayerRect(
  rect: HighlightRect,
  transform: ViewportTransform,
  cssScale: number,
): LayerRect {
  const [x1, y1] = applyTransform(transform, cssScale, rect.x, rect.y);
  const [x2, y2] = applyTransform(transform, cssScale, rect.x + rect.width, rect.y + rect.height);
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * 页内 CSS 像素矩形（文本选区行块）→ 用户空间矩形（D5 中间层，入 store）。
 * ÷cssScale 回到基准 viewport 坐标，再逆变换回用户空间（y 翻转与页面旋转在此
 * 消化）；宽或高不足 0.5pt 的碎片视为亚像素噪声丢弃。
 */
export function cssPxRectToUserSpace(
  rect: LayerRect,
  transform: ViewportTransform,
  cssScale: number,
): HighlightRect | null {
  const inv = invertTransform(transform);
  if (!inv || cssScale <= 0) return null;
  const [x1, y1] = applyInverse(inv, rect.left / cssScale, rect.top / cssScale);
  const [x2, y2] = applyInverse(inv, (rect.left + rect.width) / cssScale, (rect.top + rect.height) / cssScale);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (!(width > 0.5 && height > 0.5)) return null;
  return { x, y, width, height };
}

/** `#RRGGBB` → rgba() 屏幕色；非法色兜底默认黄（与导出侧兜底一致）。 */
function hexToCssRgba(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return `rgba(255, 224, 102, ${alpha})`;
  const n = Number.parseInt(match[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

interface HighlightOverlayProps {
  /** 本页高亮（父组件已按页码过滤）。 */
  highlights: Highlight[];
  /** scale=1 基准 viewport 变换；未就绪时不渲染矩形（宁可晚一拍，不错位）。 */
  transform: ViewportTransform | null;
  /** 与画布同源的封顶缩放（capScaleForRaster(pageSize, store.scale)）。 */
  cssScale: number;
  /** 当前选中的高亮 id（本页态，由 PageCanvas 持有）。 */
  selectedId: string | null;
  onHighlightClick: (id: string) => void;
  /** 容器 ref：PageCanvas 用它判定「点击落在本页高亮内」以维持选中态。 */
  layerRef?: RefObject<HTMLDivElement | null>;
}

/**
 * 高亮覆盖层：绝对定位铺满页项（inset:0），与画布同 viewport 对齐；
 * 容器不接鼠标（空白处不拦文本选区），只有矩形本身可点（选中→换色/删除）。
 */
export function HighlightOverlay({
  highlights,
  transform,
  cssScale,
  selectedId,
  onHighlightClick,
  layerRef,
}: HighlightOverlayProps): ReactNode {
  return (
    <div ref={layerRef} className="highlight-layer">
      {transform
        ? highlights.flatMap((highlight) =>
            highlight.rects.map((rect, index) => {
              const box = userRectToLayerRect(rect, transform, cssScale);
              const selected = highlight.id === selectedId;
              return (
                <div
                  key={`${highlight.id}:${index}`}
                  className={selected ? "highlight-rect selected" : "highlight-rect"}
                  style={{
                    left: `${box.left}px`,
                    top: `${box.top}px`,
                    width: `${box.width}px`,
                    height: `${box.height}px`,
                    background: hexToCssRgba(highlight.color, selected ? HIGHLIGHT_SELECTED_ALPHA : HIGHLIGHT_VIEW_ALPHA),
                  }}
                  title="点击选中高亮"
                  onClick={(event) => {
                    event.stopPropagation();
                    onHighlightClick(highlight.id);
                  }}
                />
              );
            }),
          )
        : null}
    </div>
  );
}

type SavePillState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved"; path: string }
  | { phase: "failed"; message: string };

/** 取路径最后一段做展示（Windows 正反斜杠都认）。 */
function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 「另存副本」浮动条（T6 的查看器入口；本任务拥有的组件，不进 ViewerToolbar）。
 * 固定在窗口右下角；由「当前页」的 PageCanvas 挂载（全局仅一份，见 PageCanvas）。
 * 成功后给出「打开所在目录」（plugin-opener，权限已授）；失败给出中文原因。
 */
export function HighlightSaveButton(): ReactNode {
  const count = useDocumentStore((s) => activeTabOf(s).highlights.length);
  const [state, setState] = useState<SavePillState>({ phase: "idle" });

  const run = async () => {
    setState({ phase: "saving" });
    const result = await saveHighlightCopy();
    if (result.status === "saved") setState({ phase: "saved", path: result.path });
    else if (result.status === "failed") setState({ phase: "failed", message: result.message });
    else setState({ phase: "idle" }); // 用户在对话框取消：静默回待命
  };

  if (count === 0 && state.phase === "idle") return null;

  return (
    <div className="hl-save-pill" role="status">
      {state.phase === "idle" && (
        <button type="button" className="hl-save-trigger" onClick={() => void run()}>
          <Highlighter size={14} aria-hidden />
          另存副本（{count} 处高亮）
        </button>
      )}
      {state.phase === "saving" && <span className="hl-save-msg">正在生成高亮副本…</span>}
      {state.phase === "saved" && (
        <>
          <span className="hl-save-msg" title={state.path}>
            副本已保存：{baseNameOf(state.path)}
          </span>
          <button type="button" className="hl-save-secondary" onClick={() => void revealSavedCopy(state.path)}>
            <FolderOpen size={13} aria-hidden />
            打开所在目录
          </button>
          <button type="button" className="hl-save-secondary" onClick={() => setState({ phase: "idle" })}>
            关闭
          </button>
        </>
      )}
      {state.phase === "failed" && (
        <>
          <span className="hl-save-msg err" title={state.message}>
            {state.message}
          </span>
          <button type="button" className="hl-save-secondary" onClick={() => setState({ phase: "idle" })}>
            <X size={13} aria-hidden />
            关闭
          </button>
        </>
      )}
    </div>
  );
}
