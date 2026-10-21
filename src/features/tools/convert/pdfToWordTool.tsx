import { inspectPdfForImages, type PdfForImagesSummary } from "../../../core/document/convertImages";
import {
  runPdfToWord,
  saveConvertedDocx,
  suggestDocxName,
} from "../../../core/document/convertWord";
import { ConvertCancelled } from "../../../core/document/convertCommon";
import {
  WizardCancelled,
  type WizardConfigPanelProps,
  type WizardToolDefinition,
} from "../../../shell/wizard/types";

/**
 * 「PDF 转 Word」向导工具定义（M6，features/tools）：文本型 PDF → .docx，
 * 按阅读顺序重建段落（验收 M6-3——段落数量与顺序正确；表格无结构信息，
 * 降级为文本但内容不丢）。抽取与生成在 core 的 convertWord（pdf.js 文本层
 * + docx 包），本文件只组装配置与提示。inspect 复用出图向导的
 * inspectPdfForImages（同为「页数 + 首页尺寸」的轻解析）。
 */

export interface PdfToWordConfig {
  /** 每个 PDF 页前插入分页符（保留页对应关系）。 */
  pageBreaks: boolean;
}

function PdfToWordPanel({ files, config, onChange }: WizardConfigPanelProps<PdfToWordConfig, PdfForImagesSummary>) {
  const file = files[0];
  if (!file) return <p className="tool-panel-lead">请先选择文件。</p>;
  return (
    <div className="tool-panel">
      <p className="tool-panel-lead">
        「{file.fileName}」共 {file.numPages} 页，将转换为 Word 文档（.docx）。
      </p>
      <label className="tool-check">
        <input
          type="checkbox"
          checked={config.pageBreaks}
          onChange={(event) => onChange({ ...config, pageBreaks: event.target.checked })}
        />
        每个 PDF 页前插入分页符（保持页码对应；取消则正文连排）
      </label>
      <p className="tool-note">
        说明：按阅读顺序重建段落，版式有损——字体、颜色、图片与表格边框不保留；
        表格会降级为按行的文本（内容不丢失）。扫描图片型 PDF 无文本层，无法转换
        （OCR 属后置能力）。
      </p>
    </div>
  );
}

export const pdfToWordTool: WizardToolDefinition<PdfToWordConfig, PdfForImagesSummary> = {
  id: "pdf-to-word",
  title: "PDF 转 Word",
  description: "把文本型 PDF 转为 Word 文档（.docx），按阅读顺序重建段落。",
  files: {
    multiple: false,
    minCount: 1,
    inspect: inspectPdfForImages,
  },
  config: {
    initial: () => ({ pageBreaks: true }),
    panel: PdfToWordPanel,
  },
  run: async ({ files, config, onProgress, cancelToken }) => {
    const file = files[0];
    try {
      const result = await runPdfToWord(
        { path: file.path, fileName: file.fileName },
        { pageBreaks: config.pageBreaks },
        {
          onStage: (message, ratio) => onProgress({ message, ratio }),
          isCancelled: () => cancelToken.isCancelled(),
        },
      );
      const details = [
        { name: suggestDocxName(file.fileName), note: `重建 ${result.paragraphCount} 个段落` },
        {
          name: "内容范围",
          note:
            result.emptyPages > 0
              ? `${result.pageCount} 页中 ${result.emptyPages} 页无文本（可能含扫描页），已跳过`
              : `${result.pageCount} 页全部提取`,
        },
      ];
      return {
        headline: `转换完成：${result.pageCount} 页 → ${result.paragraphCount} 个段落`,
        details,
        save: async () => {
          const outcome = await saveConvertedDocx(result.bytes, [file.path], suggestDocxName(file.fileName));
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
