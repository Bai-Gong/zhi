import { inspectPresentationFile, runPresentationToPdf, type PresentationOptions, type PresentationFileSummary } from "../../../core/document/convertPresentation";
import { ConvertCancelled, saveConvertedFile } from "../../../core/document/convertCommon";
import { baseNameOf } from "../../../core/document/mergeSplit";
import { WizardCancelled, type WizardToolDefinition } from "../../../shell/wizard/types";

export const presentationToPdfTool: WizardToolDefinition<PresentationOptions, PresentationFileSummary> = {
  id: "presentation-to-pdf",
  title: "PPT 转 PDF",
  description: "将 PPTX 按原始页面尺寸转换为 PDF。基础版式预览，复杂对象会提示降级，动画以静态页面显示。",
  files: { multiple: false, minCount: 1, filters: [{ name: "PowerPoint 演示文稿", extensions: ["pptx"] }], inspect: inspectPresentationFile },
  config: {
    initial: () => ({ includeHidden: false }),
    panel: ({ files, config, onChange }) => <div><p>共 {files[0]?.numPages ?? 0} 张幻灯片，其中 {files[0]?.hiddenSlides ?? 0} 张隐藏。</p><label><input type="checkbox" checked={config.includeHidden} onChange={e => onChange({ includeHidden: e.target.checked })} /> 包含隐藏幻灯片</label></div>,
  },
  run: async ({ files, config, onProgress, cancelToken }) => {
    const file = files[0];
    try {
      const result = await runPresentationToPdf(file, config, { onStage: (message, ratio) => onProgress({ message, ratio }), isCancelled: () => cancelToken.isCancelled() });
      return {
        headline: `转换完成：共 ${result.pageCount} 页`,
        details: result.warnings.map(note => ({ name: "预览说明", note })),
        save: async () => {
          const resultSave = await saveConvertedFile({ bytes: result.bytes, sourcePaths: [file.path], defaultName: `${baseNameOf(file.fileName)}.pdf`, filterName: "PDF", extensions: ["pdf"] });
          return resultSave.status === "saved" ? { status: "saved", paths: [resultSave.path] } : resultSave;
        },
      };
    } catch (error) { if (error instanceof ConvertCancelled) throw new WizardCancelled(); throw error; }
  },
};
