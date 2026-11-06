import { inspectSpreadsheetFile, runSpreadsheetToPdf, type SpreadsheetOptions, type SpreadsheetFileSummary } from "../../../core/document/convertSpreadsheet";
import { ConvertCancelled, saveConvertedFile } from "../../../core/document/convertCommon";
import { baseNameOf } from "../../../core/document/mergeSplit";
import { WizardCancelled, type WizardConfigPanelProps, type WizardToolDefinition } from "../../../shell/wizard/types";

function SpreadsheetPanel({ files, config, onChange }: WizardConfigPanelProps<SpreadsheetOptions, SpreadsheetFileSummary>) {
  const file = files[0];
  const selected = config.sheetNames ?? file.sheets.filter(s => !s.hidden).map(s => s.name);
  return <div className="wizard-config">
    <p>A4 横向，缩放至一页宽，纵向自动分页。基础版式不包含图表和绘图。</p>
    <fieldset><legend>导出工作表</legend>{file.sheets.map(sheet => <label key={sheet.name} style={{ display: "block", margin: "8px 0" }}>
      <input type="checkbox" checked={selected.includes(sheet.name)} onChange={event => onChange({ ...config, sheetNames: event.target.checked ? [...selected, sheet.name] : selected.filter(n => n !== sheet.name) })} /> {sheet.name}{sheet.hidden ? "（隐藏）" : ""}
    </label>)}</fieldset>
    {/\.csv$/i.test(file.fileName) && <label>CSV 编码 <select value={config.encoding ?? "utf-8"} onChange={e => onChange({ ...config, encoding: e.target.value as SpreadsheetOptions["encoding"] })}>
      <option value="utf-8">UTF-8</option><option value="gb18030">GB18030（中文旧编码）</option>
    </select></label>}
  </div>;
}

export const spreadsheetToPdfTool: WizardToolDefinition<SpreadsheetOptions, SpreadsheetFileSummary> = {
  id: "spreadsheet-to-pdf", title: "Excel/CSV 转 PDF", description: "将 XLSX 或 CSV 表格按基础版式分页为 PDF，可选择工作表。",
  files: { multiple: false, minCount: 1, filters: [{ name: "Excel / CSV", extensions: ["xlsx", "csv"] }], inspect: inspectSpreadsheetFile },
  config: { initial: () => ({ encoding: "utf-8" }), panel: SpreadsheetPanel, validate: (files, config) => (config.sheetNames ?? files[0]?.sheets.filter(s => !s.hidden).map(s => s.name) ?? []).length ? null : "请选择至少一个工作表。" },
  run: async ({ files, config, onProgress, cancelToken }) => {
    const file = files[0];
    try {
      const result = await runSpreadsheetToPdf(file, config, { onStage: (message, ratio) => onProgress({ message, ratio }), isCancelled: () => cancelToken.isCancelled() });
      return { headline: `转换完成：共 ${result.pageCount} 页`, details: result.warnings.map(note => ({ name: "转换说明", note })), save: async () => {
        const outcome = await saveConvertedFile({ bytes: result.bytes, sourcePaths: [file.path], defaultName: `${baseNameOf(file.fileName)}.pdf`, filterName: "PDF", extensions: ["pdf"] });
        return outcome.status === "saved" ? { status: "saved", paths: [outcome.path] } : outcome;
      } };
    } catch (error) { if (error instanceof ConvertCancelled) throw new WizardCancelled(); throw error; }
  },
};
