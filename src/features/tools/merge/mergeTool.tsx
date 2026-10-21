import {
  allPageIndices,
  parsePageRanges,
  MergeSplitCancelled,
  type PageRangesResult,
} from "../../../core/document/mergeSplit";
import {
  inspectPdfFile,
  runMerge,
  saveMergedPdf,
  type PdfFileSummary,
} from "../../../core/document/mergeSplitExport";
import {
  WizardCancelled,
  type WizardConfigPanelProps,
  type WizardToolDefinition,
} from "../../../shell/wizard/types";

/**
 * 「合并 PDF」向导工具定义（M4，features/tools）：多文件按序合并、每文件可选
 * 页码范围（验收 M4-2）、可选「每源文件一条顶级书签」。读文件/合并/落盘全部
 * 经 core 的 mergeSplitExport（pdf-lib 使用收敛在 core，技术方案 4.3 规则 1），
 * 本文件只组装配置、校验、进度文案与结果清单。
 *
 * 书签/链接降级策略（验收 M4-1 允许的「按策略降级 + 明确提示」，配置步文案明示）：
 * copyPages 合并不迁移源文档的内部书签与页内跳转链接；本工具提供「每源文件
 * 一条顶级书签」的目录级导航作为替代。
 */

/** 合并配置：每文件（按 path 键）的页码范围输入（空串 = 整本）+ 书签开关。 */
export interface MergeConfig {
  ranges: Record<string, string>;
  bookmarkPerFile: boolean;
}

/** 单文件的有效页选择（空输入 → 全部页；非法输入返回错误）。 */
function rangeOf(file: PdfFileSummary, config: MergeConfig): PageRangesResult {
  const text = (config.ranges[file.path] ?? "").trim();
  if (text === "") return { indices: allPageIndices(file.numPages) };
  return parsePageRanges(text, file.numPages);
}

function MergePanel({ files, config, onChange }: WizardConfigPanelProps<MergeConfig, PdfFileSummary>) {
  return (
    <div className="tool-panel">
      <p className="tool-panel-lead">按列表顺序合并；每行可填页码范围（留空 = 取整本）。</p>
      <ul className="tool-rows">
        {files.map((file, index) => {
          const value = config.ranges[file.path] ?? "";
          const parsed = rangeOf(file, config);
          return (
            <li key={file.path} className="tool-row">
              <span className="tool-row-index">{index + 1}</span>
              <span className="tool-row-name" title={file.path}>
                {file.fileName}
              </span>
              <span className="tool-row-meta">共 {file.numPages} 页</span>
              <input
                type="text"
                className="tool-row-input"
                placeholder="全部页，如 1-3,5,8"
                value={value}
                aria-label={`「${file.fileName}」的页码范围`}
                onChange={(event) =>
                  onChange({ ...config, ranges: { ...config.ranges, [file.path]: event.target.value } })
                }
              />
              <span className={"tool-row-hint" + ("error" in parsed ? " invalid" : "")}>
                {"error" in parsed
                  ? parsed.error
                  : parsed.indices.length === file.numPages
                    ? "整本"
                    : `选中 ${parsed.indices.length} 页`}
              </span>
            </li>
          );
        })}
      </ul>
      <label className="tool-check">
        <input
          type="checkbox"
          checked={config.bookmarkPerFile}
          onChange={(event) => onChange({ ...config, bookmarkPerFile: event.target.checked })}
        />
        为每个源文件生成一条顶级书签（便于在合并结果中定位各文件起始页）
      </label>
      <p className="tool-note">
        说明：源文档的内部书签与页内跳转链接不会迁移到合并结果（合并采用复制页方式，
        此类目标无法可靠重定向）；勾选上项可获得「每文件一条」的目录级导航。
      </p>
    </div>
  );
}

export const mergeTool: WizardToolDefinition<MergeConfig, PdfFileSummary> = {
  id: "merge",
  title: "合并 PDF",
  description: "把多个 PDF 按顺序合并为一个文件，可按页码范围选取每个文件的页。",
  files: {
    multiple: true,
    minCount: 2,
    inspect: inspectPdfFile,
  },
  config: {
    initial: () => ({ ranges: {}, bookmarkPerFile: true }),
    panel: MergePanel,
    validate: (files, config) => {
      let total = 0;
      for (const file of files) {
        const parsed = rangeOf(file, config);
        if ("error" in parsed) return `「${file.fileName}」${parsed.error}`;
        total += parsed.indices.length;
      }
      if (total === 0) return "所有文件都没有选中任何页，请调整页码范围。";
      return null;
    },
  },
  run: async ({ files, config, onProgress, cancelToken }) => {
    const inputs = files.map((file) => {
      const parsed = rangeOf(file, config);
      // validate 已拦非法输入，此处的空数组只是类型防御。
      return { path: file.path, fileName: file.fileName, indices: "error" in parsed ? [] : parsed.indices };
    });
    try {
      const result = await runMerge(inputs, { bookmarkPerFile: config.bookmarkPerFile }, {
        onStage: (message, ratio) => onProgress({ message, ratio }),
        onPages: (done, total) =>
          onProgress({ message: `正在合并页面…（${done}/${total}）`, ratio: total > 0 ? done / total : null }),
        isCancelled: () => cancelToken.isCancelled(),
      });
      return {
        headline: `合并完成：${files.length} 个文件 → 共 ${result.pageCount} 页`,
        details: result.perFile.map((item) => ({
          name: item.fileName,
          note: item.from === item.to ? `第 ${item.from} 页` : `第 ${item.from}–${item.to} 页`,
        })),
        save: async () => {
          const outcome = await saveMergedPdf(
            result.bytes,
            files.map((file) => file.path),
            "合并文档.pdf",
          );
          if (outcome.status === "saved") return { status: "saved" as const, paths: [outcome.path] };
          if (outcome.status === "cancelled") return { status: "cancelled" as const };
          return { status: "failed" as const, message: outcome.message };
        },
      };
    } catch (error) {
      if (error instanceof MergeSplitCancelled) throw new WizardCancelled();
      throw error;
    }
  },
};
