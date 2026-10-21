// 选中对象的属性面板（M5 验收 3：随选中对象联动，修改即时预览）：
// - 文本对象：内容（多行）、字体族、粗/斜、字号、颜色、位置与遮盖矩形（pt），
//   以及导出形态的诚实提示（矢量可复制 / 位图不可复制——依赖冻结下无中文字体嵌入）；
// - 图片对象：位置与宽高（pt）、替换图片、删除；
// - 无选中：操作引导。
// 一步撤销的语义：多行文本输入以「聚焦→失焦」为一step（beginStep/live/endStep 三段式），
// 其余控件每次离散修改即一步（editStore.step）。
import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { ImagePlus, Trash2 } from "lucide-react";
import {
  EDIT_FONTS,
  isVectorText,
  roundPt,
  useEditStore,
  type EditObject,
  type ImageEditObject,
  type TextEditObject,
} from "../../core/document";

/** 颜色板（黑 + 常用三原色；自定义色走 input[type=color]）。 */
const TEXT_COLORS = ["#000000", "#c92a2a", "#1864ab", "#2b8a3e"] as const;

interface PropertiesPanelProps {
  tabId: string;
  /** 当前选中的对象；null = 无选中。 */
  object: EditObject | null;
  /** 面板内删除/替换后由 EditPage 清理选中态。 */
  onDeleted: () => void;
  /** 操作失败提示（替换图片读文件失败等）。 */
  onError: (message: string) => void;
}

/** 数字输入：本地草稿 + blur/Enter 提交（一次提交 = 一步撤销）。 */
function NumberField({
  label,
  value,
  onCommit,
  min,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (next: number) => void;
  min?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState(String(roundPt(value)));
  useEffect(() => {
    setDraft(String(roundPt(value)));
  }, [value]);
  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed) && parsed !== value) {
      onCommit(min !== undefined ? Math.max(min, parsed) : parsed);
    } else {
      setDraft(String(roundPt(value)));
    }
  };
  return (
    <label className="edit-prop-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
}

export function PropertiesPanel({ tabId, object, onDeleted, onError }: PropertiesPanelProps) {
  const store = useEditStore.getState;

  if (!object) {
    return (
      <aside className="edit-props" aria-label="属性面板">
        <p className="edit-props-title">属性</p>
        <p className="edit-props-hint">双击页面上的文字进入编辑；点击已插入的对象可调整位置与样式。</p>
        <p className="edit-props-hint">也可以在上方工具栏插入文本框或图片。</p>
      </aside>
    );
  }

  /** 通用：patch 当前选中对象（一步）。 */
  const patchObject = (patch: Partial<TextEditObject> | Partial<ImageEditObject>) => {
    store().step(tabId, (objects) =>
      objects.map((o) => (o.id === object.id ? ({ ...o, ...patch } as EditObject) : o)),
    );
  };
  const removeObject = () => {
    store().step(tabId, (objects) => objects.filter((o) => o.id !== object.id));
    onDeleted();
  };

  if (object.kind === "text") {
    const text = object;
    const vector = isVectorText(text.text);
    return (
      <aside className="edit-props" aria-label="属性面板">
        <p className="edit-props-title">文本属性</p>
        <label className="edit-prop-field column">
          <span>内容（可多行）</span>
          <textarea
            rows={3}
            value={text.text}
            onFocus={() => store().beginStep(tabId)}
            onChange={(e) =>
              store().liveUpdate(tabId, (objects) =>
                objects.map((o) => (o.id === text.id && o.kind === "text" ? { ...o, text: e.target.value } : o)),
              )
            }
            onBlur={() => store().endStep(tabId)}
          />
        </label>
        <div className="edit-prop-row">
          <label className="edit-prop-field grow">
            <span>字体</span>
            <select
              value={text.fontFamily}
              onChange={(e) => patchObject({ fontFamily: e.target.value as TextEditObject["fontFamily"] })}
            >
              {EDIT_FONTS.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            label="字号(pt)"
            value={text.fontSize}
            min={4}
            onCommit={(next) => patchObject({ fontSize: roundPt(next) })}
          />
        </div>
        <div className="edit-prop-row">
          <button
            type="button"
            className={text.bold ? "edit-toggle on" : "edit-toggle"}
            aria-pressed={text.bold}
            onClick={() => patchObject({ bold: !text.bold })}
          >
            粗体
          </button>
          <button
            type="button"
            className={text.italic ? "edit-toggle on" : "edit-toggle"}
            aria-pressed={text.italic}
            onClick={() => patchObject({ italic: !text.italic })}
          >
            斜体
          </button>
          <div className="edit-colors">
            {TEXT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={text.color.toLowerCase() === color ? "edit-color-swatch selected" : "edit-color-swatch"}
                style={{ background: color }}
                aria-label={`文字颜色 ${color}`}
                onClick={() => patchObject({ color })}
              />
            ))}
            <input
              type="color"
              aria-label="自定义文字颜色"
              value={/^#[0-9a-f]{6}$/i.test(text.color) ? text.color : "#000000"}
              onChange={(e) => patchObject({ color: e.target.value })}
            />
          </div>
        </div>
        <p className="edit-props-group">遮盖矩形与位置（pt，原点在页面左下角）</p>
        <div className="edit-prop-row">
          <NumberField label="X" value={text.cover.x} onCommit={(next) => patchObject({ cover: { ...text.cover, x: roundPt(next) } })} />
          <NumberField label="Y" value={text.cover.y} onCommit={(next) => patchObject({ cover: { ...text.cover, y: roundPt(next) } })} />
        </div>
        <div className="edit-prop-row">
          <NumberField label="宽" value={text.cover.width} min={2} onCommit={(next) => patchObject({ cover: { ...text.cover, width: roundPt(next) } })} />
          <NumberField label="高" value={text.cover.height} min={2} onCommit={(next) => patchObject({ cover: { ...text.cover, height: roundPt(next) } })} />
        </div>
        <p className={vector ? "edit-export-note vector" : "edit-export-note bitmap"}>
          {vector
            ? "导出形态：矢量文本——副本中可再次选中复制。"
            : "含中文等字符：当前版本无法嵌入中文字体，导出时将转为高清位图（清晰可读，但不可再选中复制）。"}
        </p>
        <button type="button" className="edit-danger" onClick={removeObject}>
          <Trash2 size={14} aria-hidden />
          删除该文本补丁
        </button>
      </aside>
    );
  }

  const image = object;
  const replaceImage = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg"] },
        ],
      });
      if (typeof picked !== "string") return; // 取消
      const raw = await readFile(picked);
      const format = /\.jpe?g$/i.test(picked) ? "jpg" : "png";
      const srcId = store().putImage(tabId, raw, format as "png" | "jpg");
      patchObject({ srcId });
    } catch (error) {
      onError(`替换图片失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <aside className="edit-props" aria-label="属性面板">
      <p className="edit-props-title">图片属性</p>
      <p className="edit-props-group">位置与大小（pt）</p>
      <div className="edit-prop-row">
        <NumberField label="X" value={image.x} onCommit={(next) => patchObject({ x: roundPt(next) })} />
        <NumberField label="Y" value={image.y} onCommit={(next) => patchObject({ y: roundPt(next) })} />
      </div>
      <div className="edit-prop-row">
        <NumberField label="宽" value={image.width} min={4} onCommit={(next) => patchObject({ width: roundPt(next) })} />
        <NumberField label="高" value={image.height} min={4} onCommit={(next) => patchObject({ height: roundPt(next) })} />
      </div>
      <p className="edit-props-hint">拖动图片可移动；选中后四角手柄等比缩放，四边手柄单轴调整。</p>
      <button type="button" className="edit-secondary" onClick={() => void replaceImage()}>
        <ImagePlus size={14} aria-hidden />
        替换图片（png/jpg）
      </button>
      <button type="button" className="edit-danger" onClick={removeObject}>
        <Trash2 size={14} aria-hidden />
        删除该图片
      </button>
    </aside>
  );
}
