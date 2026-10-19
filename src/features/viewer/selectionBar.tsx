// 文本选区 / 选中高亮的浮动操作条（M2-3）：颜色选择（≥3 色）+ 删除（编辑态）。
// 定位在选区首行矩形的上方（贴顶时翻到下方），随页滚动；锚定矩形与坐标换算全部
// 由 PageCanvas 供给（页内 CSS px，同一 viewport 参照系），本组件只做呈现与操作。
import type { ReactNode, RefObject } from "react";
import { Trash2, X } from "lucide-react";
import { HIGHLIGHT_COLORS, type LayerRect } from "./highlightLayer";

/** 操作条与锚定矩形的间距（页内 px）。 */
const BAR_MARGIN = 8;
/** 翻转判定用的操作条高度估计值（实际高度约 34px，宁略大勿翻进页外）。 */
const BAR_HEIGHT_ESTIMATE = 40;
/** 水平夹取半宽（操作条按内容约 160px 宽估算，防在窄页上越出页缘）。 */
const BAR_CLAMP_HALF_WIDTH = 84;

interface SelectionBarProps {
  /** create=文本选区新建高亮；edit=选中已有高亮（换色/删除）。 */
  mode: "create" | "edit";
  /** 锚定矩形（页内 CSS px）：create 用选区首行块，edit 用高亮首个矩形。 */
  anchor: LayerRect;
  /** 页面显示宽度（px），用于水平夹取；缺省不夹取。 */
  pageWidth?: number;
  /** 编辑态当前色（色板高亮指示）。 */
  currentColor?: string;
  onPickColor: (color: string) => void;
  /** 仅编辑态：删除该高亮。 */
  onDelete?: () => void;
  onDismiss: () => void;
  /** 根节点 ref：PageCanvas 用它判定「点击落在操作条内」不收起两态。 */
  ref?: RefObject<HTMLDivElement | null>;
}

/**
 * 浮动操作条。根节点 onMouseDown preventDefault：点击色板/按钮不让焦点移走、
 * 不折叠原生文本选区（否则 create 流程在点按瞬间就丢选区）。
 */
export function SelectionBar({
  mode,
  anchor,
  pageWidth,
  currentColor,
  onPickColor,
  onDelete,
  onDismiss,
  ref,
}: SelectionBarProps): ReactNode {
  // 锚点上方放不下（选区贴近页顶）时翻到下方，避免条被上一页盖住或出页裁掉。
  const below = anchor.top < BAR_HEIGHT_ESTIMATE + BAR_MARGIN;
  const centerX = pageWidth
    ? Math.min(Math.max(anchor.left + anchor.width / 2, BAR_CLAMP_HALF_WIDTH), Math.max(pageWidth - BAR_CLAMP_HALF_WIDTH, BAR_CLAMP_HALF_WIDTH))
    : anchor.left + anchor.width / 2;

  return (
    <div
      ref={ref}
      className={below ? "hl-selection-bar below" : "hl-selection-bar"}
      style={{ left: `${centerX}px`, top: below ? `${anchor.top + anchor.height + BAR_MARGIN}px` : `${anchor.top - BAR_MARGIN}px` }}
      role="toolbar"
      aria-label={mode === "create" ? "新建高亮" : "高亮操作"}
      onMouseDown={(event) => event.preventDefault()}
    >
      {mode === "edit" && <span className="hl-bar-tag">高亮</span>}
      {HIGHLIGHT_COLORS.map((color) => (
        <button
          key={color.value}
          type="button"
          className={currentColor === color.value ? "hl-swatch active" : "hl-swatch"}
          style={{ background: color.value }}
          title={mode === "create" ? `以${color.label}高亮` : `改为${color.label}`}
          aria-label={mode === "create" ? `以${color.label}高亮` : `改为${color.label}`}
          onClick={() => onPickColor(color.value)}
        />
      ))}
      {mode === "edit" && (
        <button type="button" className="hl-bar-button" title="删除高亮" aria-label="删除高亮" onClick={onDelete}>
          <Trash2 size={14} aria-hidden />
        </button>
      )}
      <button type="button" className="hl-bar-button" title="收起" aria-label="收起" onClick={onDismiss}>
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
