import {
  baseNameOf,
  planBookmarkSegments,
  planEveryNSegments,
  planRangeSegments,
  parsePageRanges,
  MergeSplitCancelled,
  type SplitSegment,
} from "../../../core/document/mergeSplit";
import {
  exportSplitFiles,
  inspectPdfFile,
  runSplit,
  type PdfFileSummary,
} from "../../../core/document/mergeSplitExport";
import {
  WizardCancelled,
  type WizardConfigPanelProps,
  type WizardToolDefinition,
} from "../../../shell/wizard/types";

/**
 * 「拆分 PDF」向导工具定义（M4，features/tools）：三种模式——每 N 页 /
 * 按顶级书签 / 按页码范围（逗号分段），命名 `原名_1.pdf`…（书签模式带书签名，
 * 验收 M4-3）。分段规划与执行在 core（mergeSplit/mergeSplitExport），本文件
 * 只组装模式 UI、预览、校验与落盘文案。
 */

export type SplitMode = "everyN" | "bookmarks" | "ranges";

export interface SplitConfig {
  mode: SplitMode;
  /** 「每 N 页」的 N。 */
  everyN: number;
  /** 「按页码范围」的输入（每个逗号段一个输出文件，如 `1-3,5-8,10`）。 */
  rangesText: string;
}

/** 由配置产出拆分计划（预览/校验/执行共用一份口径）。 */
function planSplit(file: PdfFileSummary, config: SplitConfig): { segments: SplitSegment[] } | { error: string } {
  const base = baseNameOf(file.fileName);
  if (config.mode === "everyN") {
    if (!Number.isInteger(config.everyN) || config.everyN < 1) {
      return { error: "「每 N 页」请填一个不小于 1 的整数。" };
    }
    return { segments: planEveryNSegments(file.numPages, config.everyN, base) };
  }
  if (config.mode === "bookmarks") {
    if (file.topBookmarks.length === 0) {
      return { error: "该文档没有书签，无法按书签拆分：请改用「每 N 页」或「按页码范围」。" };
    }
    const plan = planBookmarkSegments(file.topBookmarks, file.numPages, base);
    if (plan.segments.length === 0) {
      return { error: "书签均无法定位到页（空段或无页目标），请改用其他模式。" };
    }
    return { segments: plan.segments };
  }
  const text = config.rangesText.trim();
  if (text === "") return { error: "请填写页码范围，如 1-3,5-8（每个逗号段一个文件）。" };
  const parts = text
    .replace(/[\uFF0C\u3001]/g, ",")
    .replace(/\s+/g, "")
    .split(",")
    .filter((part) => part !== "");
  const parsed: number[][] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const result = parsePageRanges(parts[i], file.numPages);
    if ("error" in result) return { error: `第 ${i + 1} 段「${parts[i]}」：${result.error}` };
    parsed.push(result.indices);
  }
  if (parsed.length === 0) return { error: "请填写页码范围。" };
  return { segments: planRangeSegments(parsed, base) };
}

/** 页选择 → 中文页码描述（连续段给区间，离散页逐个列出）。 */
function pageLabelOf(indices: readonly number[]): string {
  const sorted = [...indices].sort((a, b) => a - b);
  if (sorted.length === 0) return "无页";
  const first = sorted[0] + 1;
  const last = sorted[sorted.length - 1] + 1;
  if (last - first + 1 === sorted.length) {
    return first === last ? `第 ${first} 页` : `第 ${first}–${last} 页`;
  }
  return `第 ${sorted.map((index) => index + 1).join("、")} 页`;
}

const MODES: { id: SplitMode; label: string; hint: string }[] = [
  { id: "everyN", label: "每 N 页一档", hint: "固定页数切分，末档可短" },
  { id: "bookmarks", label: "按顶级书签", hint: "每个顶级书签一档（至下一个书签前）" },
  { id: "ranges", label: "按页码范围", hint: "每个逗号段一个文件，如 1-3,5-8" },
];

function SplitPanel({ files, config, onChange }: WizardConfigPanelProps<SplitConfig, PdfFileSummary>) {
  const file = files[0];
  if (!file) return <p className="tool-panel-lead">请先选择文件。</p>;
  const base = baseNameOf(file.fileName);
  const plan = planSplit(file, config);
  const segments = "segments" in plan ? plan.segments : [];
  const bookmarkPlan =
    config.mode === "bookmarks" ? planBookmarkSegments(file.topBookmarks, file.numPages, base) : null;

  return (
    <div className="tool-panel">
      <p className="tool-panel-lead">
        「{file.fileName}」共 {file.numPages} 页，输出文件名为「{base}_序号.pdf」
        {config.mode === "bookmarks" ? "（书签模式附书签名）" : ""}。
      </p>
      <div className="tool-modes" role="radiogroup" aria-label="拆分模式">
        {MODES.map((mode) => (
          <label
            key={mode.id}
            className={"tool-mode" + (config.mode === mode.id ? " active" : "")}
          >
            <input
              type="radio"
              name="split-mode"
              checked={config.mode === mode.id}
              onChange={() => onChange({ ...config, mode: mode.id })}
            />
            <span className="tool-mode-label">{mode.label}</span>
            <span className="tool-mode-hint">{mode.hint}</span>
          </label>
        ))}
      </div>

      {config.mode === "everyN" && (
        <div className="tool-field">
          <label htmlFor="split-every-n">每几页一档：</label>
          <input
            id="split-every-n"
            type="number"
            min={1}
            step={1}
            className="tool-row-input narrow"
            value={Number.isNaN(config.everyN) ? "" : config.everyN}
            onChange={(event) => onChange({ ...config, everyN: event.target.valueAsNumber })}
          />
        </div>
      )}
      {config.mode === "bookmarks" && (
        <div className="tool-note-block">
          {file.topBookmarks.length === 0 ? (
            <p className="tool-note invalid">该文档没有书签——此模式不可用。</p>
          ) : (
            <>
              <p className="tool-note">
                共 {file.topBookmarks.length} 个顶级书签
                {bookmarkPlan && bookmarkPlan.skipped.length > 0
                  ? `，其中 ${bookmarkPlan.skipped.length} 个（无页目标或空段）将被跳过：${bookmarkPlan.skipped.join("、")}`
                  : ""}
                {bookmarkPlan && bookmarkPlan.leadingPages > 0
                  ? `；第一个书签之前的 ${bookmarkPlan.leadingPages} 页不属于任何档，不导出`
                  : ""}
                。
              </p>
              <ul className="tool-preview">
                {segments.slice(0, 8).map((segment) => (
                  <li key={segment.fileName}>
                    <span className="tool-export-name">{segment.fileName}</span>
                    <span className="tool-row-hint">{pageLabelOf(segment.indices)}</span>
                  </li>
                ))}
                {segments.length > 8 && <li className="tool-preview-more">… 共 {segments.length} 个文件</li>}
              </ul>
            </>
          )}
        </div>
      )}
      {config.mode === "ranges" && (
        <div className="tool-field">
          <label htmlFor="split-ranges">页码范围（每个逗号段一个文件）：</label>
          <input
            id="split-ranges"
            type="text"
            className="tool-row-input"
            placeholder="如 1-3,5-8,10"
            value={config.rangesText}
            onChange={(event) => onChange({ ...config, rangesText: event.target.value })}
          />
        </div>
      )}

      {"error" in plan ? (
        <p className="tool-note invalid" role="alert">
          {plan.error}
        </p>
      ) : (
        segments.length > 0 &&
        config.mode !== "bookmarks" && (
          <ul className="tool-preview">
            {segments.slice(0, 8).map((segment) => (
              <li key={segment.fileName}>
                <span className="tool-export-name">{segment.fileName}</span>
                <span className="tool-row-hint">{pageLabelOf(segment.indices)}</span>
              </li>
            ))}
            {segments.length > 8 && <li className="tool-preview-more">… 共 {segments.length} 个文件</li>}
          </ul>
        )
      )}
    </div>
  );
}

export const splitTool: WizardToolDefinition<SplitConfig, PdfFileSummary> = {
  id: "split",
  title: "拆分 PDF",
  description: "把一个 PDF 按每 N 页、顶级书签或页码范围拆分为多个文件。",
  files: {
    multiple: false,
    minCount: 1,
    inspect: inspectPdfFile,
  },
  config: {
    initial: () => ({ mode: "everyN", everyN: 1, rangesText: "" }),
    panel: SplitPanel,
    validate: (files, config) => {
      const file = files[0];
      if (!file) return "请先选择文件。";
      const plan = planSplit(file, config);
      return "error" in plan ? plan.error : null;
    },
  },
  run: async ({ files, config, onProgress, cancelToken }) => {
    const file = files[0];
    const plan = planSplit(file, config);
    if ("error" in plan) throw new Error(plan.error);
    try {
      const result = await runSplit({ path: file.path, fileName: file.fileName }, plan.segments, {
        onStage: (message, ratio) => onProgress({ message, ratio }),
        onPages: (done, total) =>
          onProgress({ message: `正在拆分页面…（${done}/${total}）`, ratio: total > 0 ? done / total : null }),
        isCancelled: () => cancelToken.isCancelled(),
      });
      return {
        headline: `拆分完成：将生成 ${result.items.length} 个文件（选择目录后写入）`,
        details: plan.segments.map((segment) => ({
          name: segment.fileName,
          note: pageLabelOf(segment.indices),
        })),
        save: async () => {
          const outcome = await exportSplitFiles(result.items, file.path);
          if (outcome.status === "saved") return { status: "saved" as const, paths: outcome.paths ?? [outcome.path] };
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
