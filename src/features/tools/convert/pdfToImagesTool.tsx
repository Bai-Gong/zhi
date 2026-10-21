import {
  allPageIndices,
  baseNameOf,
  parsePageRanges,
  type PageRangesResult,
} from "../../../core/document/mergeSplit";
import {
  exportImageFiles,
  inspectPdfForImages,
  runPdfToImages,
  type ImageExportDpi,
  type ImageExportFormat,
  type PdfForImagesSummary,
} from "../../../core/document/convertImages";
import { ConvertCancelled } from "../../../core/document/convertCommon";
import {
  WizardCancelled,
  type WizardConfigPanelProps,
  type WizardToolDefinition,
  type WizardOutputItem,
} from "../../../shell/wizard/types";

/**
 * 「PDF 转图片」向导工具定义（M6，features/tools）：png/jpg 两格式 × 96/192 dpi
 * 两档（验收 M6-1），可选页码范围，文件名 `原名_页码.扩展名`，批量导出经
 * 执行步进度与取消、导出步选目录写入。渲染与落盘全部在 core 的
 * convertImages（经 renderQueue 出图，技术方案 4.3 规则 1），本文件只组装
 * 配置、校验、进度文案与结果清单。
 */

export interface PdfToImagesConfig {
  format: ImageExportFormat;
  dpi: ImageExportDpi;
  /** 页码范围输入（空 = 全部页）。 */
  rangesText: string;
}

function planPages(file: PdfForImagesSummary, config: PdfToImagesConfig): PageRangesResult {
  const text = config.rangesText.trim();
  if (text === "") return { indices: allPageIndices(file.numPages) };
  return parsePageRanges(text, file.numPages);
}

const FORMATS: { id: ImageExportFormat; label: string; hint: string }[] = [
  { id: "png", label: "PNG", hint: "无损，文字最清晰" },
  { id: "jpg", label: "JPG", hint: "体积更小，照片类合适" },
];

function PdfToImagesPanel({ files, config, onChange }: WizardConfigPanelProps<PdfToImagesConfig, PdfForImagesSummary>) {
  const file = files[0];
  if (!file) return <p className="tool-panel-lead">请先选择文件。</p>;
  const plan = planPages(file, config);
  const count = "error" in plan ? 0 : plan.indices.length;
  const approxW = Math.round((file.pageWidthPt * config.dpi) / 72);
  const approxH = Math.round((file.pageHeightPt * config.dpi) / 72);
  return (
    <div className="tool-panel">
      <p className="tool-panel-lead">
        「{file.fileName}」共 {file.numPages} 页；首页尺寸约 {Math.round(file.pageWidthPt)}×
        {Math.round(file.pageHeightPt)} pt。
      </p>
      <div className="tool-field">
        <span>格式：</span>
        <div className="tool-modes" role="radiogroup" aria-label="图片格式">
          {FORMATS.map((format) => (
            <label key={format.id} className={"tool-mode" + (config.format === format.id ? " active" : "")}>
              <input
                type="radio"
                name="image-format"
                checked={config.format === format.id}
                onChange={() => onChange({ ...config, format: format.id })}
              />
              <span className="tool-mode-label">{format.label}</span>
              <span className="tool-mode-hint">{format.hint}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="tool-field">
        <span>清晰度：</span>
        <div className="tool-modes" role="radiogroup" aria-label="清晰度">
          {([96, 192] as const).map((dpi) => (
            <label key={dpi} className={"tool-mode" + (config.dpi === dpi ? " active" : "")}>
              <input
                type="radio"
                name="image-dpi"
                checked={config.dpi === dpi}
                onChange={() => onChange({ ...config, dpi })}
              />
              <span className="tool-mode-label">{dpi} dpi</span>
              <span className="tool-mode-hint">{dpi === 96 ? "屏幕查看" : "高清打印"}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="tool-field">
        <label htmlFor="pdf2img-ranges">页码范围（留空 = 全部页）：</label>
        <input
          id="pdf2img-ranges"
          type="text"
          className="tool-row-input"
          placeholder="如 1-3,5,8"
          value={config.rangesText}
          onChange={(event) => onChange({ ...config, rangesText: event.target.value })}
        />
      </div>
      {"error" in plan ? (
        <p className="tool-note invalid" role="alert">
          {plan.error}
        </p>
      ) : (
        <p className="tool-note">
          将导出 {count} 页，每页约 {approxW}×{approxH} 像素；文件名为「
          {baseNameOf(file.fileName)}_页码.{config.format}
          」（页码补零对齐，如 _01）。执行后在导出步选择保存目录。
        </p>
      )}
    </div>
  );
}

export const pdfToImagesTool: WizardToolDefinition<PdfToImagesConfig, PdfForImagesSummary> = {
  id: "pdf-to-images",
  title: "PDF 转图片",
  description: "把 PDF 逐页导出为 PNG/JPG 图片（96/192 dpi 可选），文件名带页码。",
  files: {
    multiple: false,
    minCount: 1,
    inspect: inspectPdfForImages,
  },
  config: {
    initial: () => ({ format: "png", dpi: 96, rangesText: "" }),
    panel: PdfToImagesPanel,
    validate: (files, config) => {
      const file = files[0];
      if (!file) return "请先选择文件。";
      const plan = planPages(file, config);
      if ("error" in plan) return plan.error;
      if (plan.indices.length === 0) return "没有选中任何页。";
      return null;
    },
  },
  run: async ({ files, config, onProgress, cancelToken }) => {
    const file = files[0];
    const plan = planPages(file, config);
    if ("error" in plan) throw new Error(plan.error);
    try {
      const result = await runPdfToImages(
        { path: file.path, fileName: file.fileName },
        { format: config.format, dpi: config.dpi, indices: plan.indices },
        {
          onStage: (message, ratio) => onProgress({ message, ratio }),
          isCancelled: () => cancelToken.isCancelled(),
        },
      );
      const details: WizardOutputItem[] = result.items.slice(0, 8).map((item) => ({
        name: item.fileName,
        note: `${item.width}×${item.height} 像素`,
      }));
      if (result.items.length > 8) {
        details.push({ name: "……", note: `共 ${result.items.length} 个文件` });
      }
      if (result.cappedPages > 0) {
        details.push({
          name: "清晰度说明",
          note: `${result.cappedPages} 页超出单边 8192 像素光栅上限，已按上限封顶导出`,
        });
      }
      return {
        headline: `导出完成：共 ${result.items.length} 张${
          config.format === "png" ? "PNG" : "JPG"
        } 图片（${config.dpi} dpi），选择目录后写入。`,
        details,
        save: async () => {
          const outcome = await exportImageFiles(result.items, file.path);
          if (outcome.status === "saved") return { status: "saved" as const, paths: outcome.paths };
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
