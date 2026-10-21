// 单个编辑对象的覆盖层视图与指针交互（M5，模块 8）：
// - 文本对象：白底遮盖矩形 + 浏览器字体实时预览新文本（所见即所得）；
// - 图片对象：objectUrl 预览 + 八手柄（四角等比、四边单轴，验收 M5-2）；
// - 拖拽移动 / 手柄缩放走 core editStore 的 beginStep → liveUpdate → endStep
//   三段式（一次拖动 = 一步撤销单元）；指针几何在**页内 CSS 空间**采集，
//   经 editModel 的同源换算落到用户空间（含旋转页的 y 翻转）。
//
// 本模块零 pdfjs-dist / pdf-lib import（技术方案 4.3 规则 1）。
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  cssPointToUser,
  cssRectToUserRect,
  editFontSpec,
  userRectToCssRect,
  TEXT_LINE_HEIGHT,
  type EditObject,
  type EditTransform,
} from "../../core/document";
import { useEditStore } from "../../core/document";

interface EditObjectViewProps {
  tabId: string;
  object: EditObject;
  /** scale=1 基准 viewport 变换；未就绪时对象不渲染。 */
  transform: EditTransform | null;
  /** 与画布同源的封顶缩放（capScaleForRaster 的结果）。 */
  cssScale: number;
  selected: boolean;
  onSelect: (id: string) => void;
  /** 覆盖层容器 ref：指针坐标换算的参照系。 */
  overlayRef: React.RefObject<HTMLDivElement | null>;
}

/** 图片缩放手柄：四角等比缩放（保持当前宽高比），四边单轴。 */
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function handleClass(handle: Handle): string {
  return `edit-handle h-${handle}`;
}

export function EditObjectView({
  tabId,
  object,
  transform,
  cssScale,
  selected,
  onSelect,
  overlayRef,
}: EditObjectViewProps) {
  const store = useEditStore.getState; // 指针交互均为事件回调，非渲染期读取
  // 图片预览 URL（objectUrl 由会话图片表管理；文本对象恒 undefined）。
  const imageUrl = useEditStore((s) =>
    object.kind === "image" ? s.sessions[tabId]?.images[object.srcId]?.objectUrl : undefined,
  );
  // 拖拽会话（移动）：起点用户空间点 + 对象起始位置。
  const moveRef = useRef<{ userX: number; userY: number; coverX: number; coverY: number } | null>(null);
  // 缩放会话：起始 CSS 矩形 + 指针起点 + 等比（仅角手柄）。
  const resizeRef = useRef<{
    handle: Handle;
    startCss: { left: number; top: number; width: number; height: number };
    startX: number;
    startY: number;
    proportional: boolean;
  } | null>(null);

  if (!transform) return null;

  /** 相对覆盖层左上角的页内 CSS 坐标。 */
  const localCssPoint = (clientX: number, clientY: number): [number, number] | null => {
    const overlay = overlayRef.current;
    if (!overlay) return null;
    const box = overlay.getBoundingClientRect();
    return [clientX - box.left, clientY - box.top];
  };

  const userDeltaOf = (event: ReactPointerEvent): { dx: number; dy: number } | null => {
    const session = moveRef.current;
    if (!session) return null;
    const css = localCssPoint(event.clientX, event.clientY);
    if (!css) return null;
    const user = cssPointToUser(css[0], css[1], transform, cssScale);
    if (!user) return null;
    return { dx: user[0] - session.userX, dy: user[1] - session.userY };
  };

  /** 移动（文本对象移动遮盖矩形，图片对象移动放置矩形）。 */
  const startMove = (event: ReactPointerEvent) => {
    event.stopPropagation();
    onSelect(object.id);
    const css = localCssPoint(event.clientX, event.clientY);
    if (!css) return;
    const user = cssPointToUser(css[0], css[1], transform, cssScale);
    if (!user) return;
    const base =
      object.kind === "text"
        ? { coverX: object.cover.x, coverY: object.cover.y }
        : { coverX: object.x, coverY: object.y };
    moveRef.current = { userX: user[0], userY: user[1], coverX: base.coverX, coverY: base.coverY };
    store().beginStep(tabId);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onMovePointerMove = (event: ReactPointerEvent) => {
    const delta = userDeltaOf(event);
    if (!delta) return;
    const session = moveRef.current!;
    store().liveUpdate(tabId, (objects) =>
      objects.map((o) => {
        if (o.id !== object.id) return o;
        if (o.kind === "text") {
          return { ...o, cover: { ...o.cover, x: session.coverX + delta.dx, y: session.coverY + delta.dy } };
        }
        return { ...o, x: session.coverX + delta.dx, y: session.coverY + delta.dy };
      }),
    );
  };
  const endMove = (event: ReactPointerEvent) => {
    if (!moveRef.current) return;
    moveRef.current = null;
    store().endStep(tabId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /** 缩放（图片对象）：手柄几何在 CSS 空间计算，落笔前整块换算回用户空间。 */
  const startResize = (event: ReactPointerEvent, handle: Handle) => {
    event.stopPropagation();
    onSelect(object.id);
    if (object.kind !== "image") return;
    const css = userRectToCssRect(object, transform, cssScale);
    resizeRef.current = {
      handle,
      startCss: { left: css.left, top: css.top, width: css.width, height: css.height },
      startX: event.clientX,
      startY: event.clientY,
      proportional: handle.length === 2,
    };
    store().beginStep(tabId);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizePointerMove = (event: ReactPointerEvent) => {
    const session = resizeRef.current;
    if (!session) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    const { left, top, width, height } = session.startCss;
    let next = { left, top, width, height };
    const handle = session.handle;
    const horizontal = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
    const vertical = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
    if (session.proportional) {
      // 角手柄：等比——以宽为主导（宽高比取自拖拽起始尺寸），锚定对角。
      const ratio = height > 0 ? width / height : 1;
      const w = Math.max(8, width + dx * horizontal);
      const h = w / ratio;
      next = {
        left: horizontal >= 0 ? left : left + width - w,
        top: vertical >= 0 ? top : top + height - h,
        width: w,
        height: h,
      };
    } else {
      // 边手柄：单轴自由缩放。
      const w = Math.max(8, width + dx * horizontal);
      const h = Math.max(8, height + dy * vertical);
      next = {
        left: horizontal >= 0 ? left : left + width - w,
        top: vertical >= 0 ? top : top + height - h,
        width: horizontal !== 0 ? w : width,
        height: vertical !== 0 ? h : height,
      };
    }
    const userRect = cssRectToUserRect(next, transform, cssScale);
    if (!userRect) return;
    store().liveUpdate(tabId, (objects) =>
      objects.map((o) => (o.id === object.id && o.kind === "image" ? { ...o, ...userRect } : o)),
    );
  };
  const endResize = (event: ReactPointerEvent) => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    store().endStep(tabId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (object.kind === "text") {
    const text = object;
    const css = userRectToCssRect(text.cover, transform, cssScale);
    const font = editFontSpec(text.fontFamily);
    return (
      <div
        className={selected ? "edit-object edit-text selected" : "edit-object edit-text"}
        style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
        title="拖动移动；双击可在右侧修改内容"
        onPointerDown={startMove}
        onPointerMove={onMovePointerMove}
        onPointerUp={endMove}
        onPointerCancel={endMove}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <span
          className="edit-text-content"
          style={{
            fontFamily: font.cssFamily,
            fontSize: text.fontSize * cssScale,
            lineHeight: TEXT_LINE_HEIGHT,
            fontWeight: text.bold ? 700 : 400,
            fontStyle: text.italic ? "italic" : "normal",
            color: text.color,
          }}
        >
          {text.text.split("\n").map((line, i) => (
            <span key={i} className="edit-text-line">
              {line.length > 0 ? line : "\u200b"}
            </span>
          ))}
        </span>
      </div>
    );
  }

  const image = object;
  const css = userRectToCssRect(image, transform, cssScale);
  return (
    <div
      className={selected ? "edit-object edit-image selected" : "edit-object edit-image"}
      style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
      title="拖动移动；角手柄等比缩放，边手柄单轴缩放"
      onPointerDown={startMove}
      onPointerMove={onMovePointerMove}
      onPointerUp={endMove}
      onPointerCancel={endMove}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {imageUrl ? (
        <img className="edit-image-bitmap" src={imageUrl} alt="" draggable={false} />
      ) : (
        <div className="edit-image-missing">图片资源已失效</div>
      )}
      {selected &&
        HANDLES.map((handle) => (
          <span
            key={handle}
            className={handleClass(handle)}
            onPointerDown={(event) => startResize(event, handle)}
            onPointerMove={onResizePointerMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            role="presentation"
          />
        ))}
    </div>
  );
}
