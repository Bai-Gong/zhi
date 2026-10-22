import {
  inspectDocxFile,
  runWordToPdf,
  type DocxFileSummary,
} from "../../../core/document/convertWord";
import { saveMergedPdf } from "../../../core/document/mergeSplitExport";
import { baseNameOf } from "../../../core/document/mergeSplit";
import { ConvertCancelled } from "../../../core/document/convertCommon";
import { WizardCancelled, type WizardToolDefinition } from "../../../shell/wizard/types";

/**
 * 「Word 转 PDF」向导工具定义（M6，features/tools）：.docx → PDF 的基础版式
 * 转换（验收 M6-4——标题/正文/图片/简单表格保留、中文字体经系统字体截图
 * 不缺字；复杂版式降级并在产品内**明确提示「基础版式转换」**——本文件
 * description 与结果页两处都带该提示）。链路与落盘在 core 的
 * convertWord/wordPagination/docxPageSetup（mammoth → 文档页面设置 →
 * 分页 DOM → html2canvas-pro → pdf-lib）。
 *
 * **无配置工具**：纸张与四边距直接采用 .docx 自带的页面设置（sectPr），
 * 解析不到才兜底 A4 常规边距——「设置一致」不靠用户选，故不设 config，
 * 向导只有「选文件 → 执行 → 导出」三步。
 */

/** 页面设置展示：pt → 毫米（一位小数），结果页用。 */
function ptToMmText(pt: number): string {
  return (Math.round((pt / 72) * 25.4 * 10) / 10).toFixed(1);
}

export const wordToPdfTool: WizardToolDefinition<void, DocxFileSummary> = {
  id: "word-to-pdf",
  title: "Word 转 PDF",
  description:
    "把 Word 文档（.docx）转换为 PDF——无需配置：纸张与页边距按文档自身的页面设置。基础版式转换：标题/正文/图片/简单表格保留。",
  files: {
    multiple: false,
    minCount: 1,
    filters: [{ name: "Word 文档", extensions: ["docx"] }],
    inspect: inspectDocxFile,
  },
  run: async ({ files, onProgress, cancelToken }) => {
    const file = files[0];
    try {
      const result = await runWordToPdf(
        { path: file.path, fileName: file.fileName },
        {
          onStage: (message, ratio) => onProgress({ message, ratio }),
          isCancelled: () => cancelToken.isCancelled(),
        },
      );
      const g = result.pageSetup.geometry;
      const sizeNote = `${ptToMmText(g.widthPt)}×${ptToMmText(g.heightPt)} 毫米，边距 上下 ${ptToMmText(g.marginTopPt)} / ${ptToMmText(g.marginBottomPt)}、左右 ${ptToMmText(g.marginLeftPt)} / ${ptToMmText(g.marginRightPt)} 毫米`;
      const details = [
        {
          name: `${baseNameOf(file.fileName)}.pdf`,
          note: `共 ${result.pageCount} 页（分页由转换决定）`,
        },
        {
          name: "页面设置",
          note: result.pageSetup.fromDocument
            ? `${sizeNote}（取自文档自身的页面设置）`
            : `${sizeNote}（文档未声明页面设置，按 A4 常规边距兜底）`,
        },
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
