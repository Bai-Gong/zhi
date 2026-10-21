import { mmToPt } from "../../../core/document/convertImages";
import {
  inspectDocxFile,
  runWordToPdf,
  type DocxFileSummary,
} from "../../../core/document/convertWord";
import { saveMergedPdf } from "../../../core/document/mergeSplitExport";
import { baseNameOf } from "../../../core/document/mergeSplit";
import { ConvertCancelled } from "../../../core/document/convertCommon";
import {
  WizardCancelled,
  type WizardConfigPanelProps,
  type WizardToolDefinition,
} from "../../../shell/wizard/types";
import type { WordPdfPaper } from "../../../core/document/wordPagination";

/**
 * 「Word 转 PDF」向导工具定义（M6，features/tools）：.docx → PDF 的基础版式
 * 转换（验收 M6-4——标题/正文/图片/简单表格保留、中文字体经系统字体截图
 * 不缺字；复杂版式降级并在产品内**明确提示「基础版式转换」**——本文件
 * description、配置面板说明与结果页三处都带该提示）。链路与落盘在 core 的
 * convertWord/wordPagination（mammoth → 分页 DOM → html2canvas-pro → pdf-lib）。
 */

/** 边距预设（毫米）——对齐 Word 的常用档。 */
const MARGIN_PRESETS: { id: string; label: string; mm: number }[] = [
  { id: "narrow", label: "窄（1.27 厘米）", mm: 12.7 },
  { id: "normal", label: "适中（1.91 厘米）", mm: 19.1 },
  { id: "wide", label: "标准（2.54 厘米）", mm: 25.4 },
];

export interface WordToPdfConfig {
  paper: WordPdfPaper;
  marginPreset: string;
}

function WordToPdfPanel({ files, config, onChange }: WizardConfigPanelProps<WordToPdfConfig, DocxFileSummary>) {
  const file = files[0];
  if (!file) return <p className="tool-panel-lead">请先选择文件。</p>;
  const preset = MARGIN_PRESETS.find((item) => item.id === config.marginPreset) ?? MARGIN_PRESETS[1];
  return (
    <div className="tool-panel">
      <p className="tool-panel-lead">
        「{file.fileName}」将转换为 PDF。Word 文档没有固定页数，实际页数由转换时的分页决定
        （文件步骤显示的「共 1 页」只是占位）。
      </p>
      <p className="tool-note invalid" role="note">
        基础版式转换：保留标题、正文、图片与简单表格；艺术字、文本框等复杂版式会降级或省略。
      </p>
      <div className="tool-field">
        <span>纸张：</span>
        <div className="tool-modes" role="radiogroup" aria-label="纸张大小">
          {(
            [
              { id: "a4", label: "A4" },
              { id: "letter", label: "Letter" },
            ] as const
          ).map((paper) => (
            <label key={paper.id} className={"tool-mode" + (config.paper === paper.id ? " active" : "")}>
              <input
                type="radio"
                name="w2p-paper"
                checked={config.paper === paper.id}
                onChange={() => onChange({ ...config, paper: paper.id })}
              />
              <span className="tool-mode-label">{paper.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="tool-field">
        <span>页边距：</span>
        <div className="tool-modes" role="radiogroup" aria-label="页边距">
          {MARGIN_PRESETS.map((item) => (
            <label key={item.id} className={"tool-mode" + (config.marginPreset === item.id ? " active" : "")}>
              <input
                type="radio"
                name="w2p-margin"
                checked={config.marginPreset === item.id}
                onChange={() => onChange({ ...config, marginPreset: item.id })}
              />
              <span className="tool-mode-label">{item.label}</span>
            </label>
          ))}
        </div>
      </div>
      <p className="tool-note">当前选择：{config.paper === "a4" ? "A4" : "Letter"} 纸，四边距 {preset.mm} 毫米。</p>
    </div>
  );
}

export const wordToPdfTool: WizardToolDefinition<WordToPdfConfig, DocxFileSummary> = {
  id: "word-to-pdf",
  title: "Word 转 PDF",
  description: "把 Word 文档（.docx）转换为 PDF——基础版式转换：标题/正文/图片/简单表格保留。",
  files: {
    multiple: false,
    minCount: 1,
    filters: [{ name: "Word 文档", extensions: ["docx"] }],
    inspect: inspectDocxFile,
  },
  config: {
    initial: () => ({ paper: "a4", marginPreset: "normal" }),
    panel: WordToPdfPanel,
  },
  run: async ({ files, config, onProgress, cancelToken }) => {
    const file = files[0];
    const preset = MARGIN_PRESETS.find((item) => item.id === config.marginPreset) ?? MARGIN_PRESETS[1];
    try {
      const result = await runWordToPdf(
        { path: file.path, fileName: file.fileName },
        { paper: config.paper, marginPt: mmToPt(preset.mm) },
        {
          onStage: (message, ratio) => onProgress({ message, ratio }),
          isCancelled: () => cancelToken.isCancelled(),
        },
      );
      const details = [
        { name: `${baseNameOf(file.fileName)}.pdf`, note: `共 ${result.pageCount} 页（分页由转换决定）` },
      ];
      if (result.ignoredCount > 0) {
        details.push({
          name: "降级提示",
          note: `${result.ignoredCount} 处内容无法完整还原（如特殊样式/文本框），已按基础版式降级`,
        });
      }
      return {
        headline: `转换完成（基础版式）：共 ${result.pageCount} 页`,
        details,
        save: async () => {
          const outcome = await saveMergedPdf(result.bytes, [file.path], `${baseNameOf(file.fileName)}.pdf`);
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
