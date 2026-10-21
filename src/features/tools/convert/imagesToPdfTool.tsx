import {
  inspectImageFile,
  runImagesToPdf,
  type ImageFileSummary,
  type ImagePageSize,
} from "../../../core/document/convertImages";
import { saveMergedPdf } from "../../../core/document/mergeSplitExport";
import { ConvertCancelled } from "../../../core/document/convertCommon";
import {
  WizardCancelled,
  type WizardConfigPanelProps,
  type WizardToolDefinition,
} from "../../../shell/wizard/types";

/**
 * 「图片转 PDF」向导工具定义（M6，features/tools）：多张 PNG/JPG 按列表顺序
 * 合成 PDF（验收 M6-2——顺序用向导框架自带的 ↑/↓ 调整），页面大小可选
 * 「适应图片」或固定纸型（A4/Letter 含横版），固定纸型下边距（mm）可调。
 * 嵌入与落盘全部在 core 的 convertImages / mergeSplitExport，本文件只组装配置。
 */

export interface ImagesToPdfConfig {
  pageSize: ImagePageSize;
  /** 固定纸型的四边距（mm）；适应图片时忽略。 */
  marginMm: number;
}

type PageSizeChoice = "fit" | "a4" | "a4-landscape" | "letter";

const CHOICES: { id: PageSizeChoice; label: string; hint: string }[] = [
  { id: "fit", label: "适应图片", hint: "页面=图片大小，无边距" },
  { id: "a4", label: "A4 竖版", hint: "图片等比居中" },
  { id: "a4-landscape", label: "A4 横版", hint: "横图合适" },
  { id: "letter", label: "Letter", hint: "信纸尺寸" },
];

function pageSizeOfChoice(choice: PageSizeChoice): ImagePageSize {
  if (choice === "fit") return { kind: "fit" };
  if (choice === "a4") return { kind: "fixed", paper: "a4", landscape: false };
  if (choice === "a4-landscape") return { kind: "fixed", paper: "a4", landscape: true };
  return { kind: "fixed", paper: "letter", landscape: false };
}

function choiceOfPageSize(size: ImagePageSize): PageSizeChoice {
  if (size.kind === "fit") return "fit";
  if (size.paper === "a4") return size.landscape ? "a4-landscape" : "a4";
  return "letter";
}

function ImagesToPdfPanel({ files, config, onChange }: WizardConfigPanelProps<ImagesToPdfConfig, ImageFileSummary>) {
  if (files.length === 0) return <p className="tool-panel-lead">请先选择图片。</p>;
  const choice = choiceOfPageSize(config.pageSize);
  return (
    <div className="tool-panel">
      <p className="tool-panel-lead">
        已选 {files.length} 张图片（列表顺序即页面顺序，用 ↑ / ↓ 调整）。
        {(() => {
          const first = files[0];
          const rest = files.slice(0, 3).map((f) => `${f.width}×${f.height}`);
          return ` 前几张尺寸：${rest.join("、")}${files.length > 3 ? "…" : ""}（首张 ${first.fileName}）。`;
        })()}
      </p>
      <div className="tool-field">
        <span>页面大小：</span>
        <div className="tool-modes" role="radiogroup" aria-label="页面大小">
          {CHOICES.map((item) => (
            <label key={item.id} className={"tool-mode" + (choice === item.id ? " active" : "")}>
              <input
                type="radio"
                name="page-size"
                checked={choice === item.id}
                onChange={() => onChange({ ...config, pageSize: pageSizeOfChoice(item.id) })}
              />
              <span className="tool-mode-label">{item.label}</span>
              <span className="tool-mode-hint">{item.hint}</span>
            </label>
          ))}
        </div>
      </div>
      {config.pageSize.kind === "fixed" && (
        <div className="tool-field">
          <label htmlFor="img2pdf-margin">页边距（毫米，0–50）：</label>
          <input
            id="img2pdf-margin"
            type="number"
            min={0}
            max={50}
            step={1}
            className="tool-row-input narrow"
            value={Number.isNaN(config.marginMm) ? "" : config.marginMm}
            onChange={(event) => onChange({ ...config, marginMm: event.target.valueAsNumber })}
          />
        </div>
      )}
      <p className="tool-note">
        {config.pageSize.kind === "fit"
          ? "适应图片：每页与图片同大（1 像素 = 0.75 磅，即 96 dpi 观感），无边距。"
          : `固定纸型：图片等比缩放并居中于边距内框，当前边距 ${Number.isNaN(config.marginMm) ? "—" : config.marginMm} 毫米。`}
      </p>
    </div>
  );
}

export const imagesToPdfTool: WizardToolDefinition<ImagesToPdfConfig, ImageFileSummary> = {
  id: "images-to-pdf",
  title: "图片转 PDF",
  description: "把多张 PNG/JPG 图片按顺序合成一个 PDF，可设页面大小与边距。",
  files: {
    multiple: true,
    minCount: 1,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }],
    inspect: inspectImageFile,
  },
  config: {
    initial: () => ({ pageSize: { kind: "fit" }, marginMm: 10 }),
    panel: ImagesToPdfPanel,
    validate: (files, config) => {
      if (files.length === 0) return "请先选择至少一张图片。";
      if (config.pageSize.kind === "fixed") {
        if (!Number.isFinite(config.marginMm) || config.marginMm < 0 || config.marginMm > 50) {
          return "页边距请填 0–50 之间的数（毫米）。";
        }
      }
      return null;
    },
  },
  run: async ({ files, config, onProgress, cancelToken }) => {
    try {
      const result = await runImagesToPdf(
        files.map((file) => ({ path: file.path, fileName: file.fileName })),
        { pageSize: config.pageSize, marginMm: config.pageSize.kind === "fixed" ? config.marginMm : 0 },
        {
          onStage: (message, ratio) => onProgress({ message, ratio }),
          isCancelled: () => cancelToken.isCancelled(),
        },
      );
      return {
        headline: `合成完成：${files.length} 张图片 → 共 ${result.pageCount} 页`,
        details: files.slice(0, 8).map((file, index) => ({
          name: file.fileName,
          note: `第 ${index + 1} 页（${file.width}×${file.height} 像素）`,
        })),
        save: async () => {
          const outcome = await saveMergedPdf(
            result.bytes,
            files.map((file) => file.path),
            "图片合集.pdf",
          );
          if (outcome.status === "saved") return { status: "saved" as const, paths: [outcome.path] };
          if (outcome.status === "cancelled") return { status: "cancelled" as const };
          return { status: "failed" as const, message: outcome.message };
        },
      };
    } catch (error) {
      if (error instanceof ConvertCancelled) throw new WizardCancelled();
      throw error;
    }
  },
};
