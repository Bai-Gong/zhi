import { useCallback, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  FilePlus2,
  FolderOpen,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import { ROUTES } from "../routes";
import {
  WizardCancelled,
  type WizardFileBase,
  type WizardOutput,
  type WizardProgress,
  type WizardSaveOutcome,
  type WizardToolDefinition,
} from "./types";
import "./wizard.css";

/**
 * 工具向导框架（M4，模块 1 归档；里程碑 M4-4/M4-5）：四步状态机
 * 「选文件 → 配置 → 执行 → 导出」+ 通用 UI（文件列表与排序、配置面板插槽、
 * 进度与取消、导出清单与落盘结果）。对具体工具零感知——一切工具差异都来自
 * {@link WizardToolDefinition}（M6 新工具以配置接入，不改本文件）。
 *
 * 验收 M4-4 的框架侧约定：
 * - 可回退：任意步可返回上一步/配置步，**已选文件与配置全程保留**
 *   （回退不清状态；文件步改动后配置面板自行消化，validate 兜底拦错）；
 * - 执行中可取消（cancelToken → 执行器抛 WizardCancelled → 回配置步）；
 * - 失败给出原因并保留配置（run 抛错的 message 在执行步呈现，「返回配置」重试）；
 * - 导出落盘由工具的 output.save() 完成（对话框/写盘策略归工具，框架只呈现结局）。
 */

/** 四个步骤的中文标题（步骤指示条顺序即流程顺序）。 */
const STEP_TITLES = ["选择文件", "配置", "执行", "导出"] as const;
type WizardStep = (typeof STEP_TITLES)[number];
const STEP_OF: Record<WizardStep, number> = {
  选择文件: 0,
  配置: 1,
  执行: 2,
  导出: 3,
};

/** 文件步的条目状态（解析在框架内驱动，结果缓存到条目上）。 */
interface FileEntry<TFileInfo extends WizardFileBase> {
  path: string;
  status: "loading" | "ready" | "error";
  info?: TFileInfo;
  error?: string;
}

/** 把未知错误折算成中文短文案。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ToolWizard<TConfig, TFileInfo extends WizardFileBase>({
  tool,
}: {
  tool: WizardToolDefinition<TConfig, TFileInfo>;
}) {
  const navigate = useNavigate();

  // ===== 文件步状态（解析结果随条目缓存；排序即数组顺序） =====
  const [step, setStep] = useState<WizardStep>("选择文件");
  const [fileEntries, setFileEntries] = useState<FileEntry<TFileInfo>[]>([]);
  // 配置状态归框架持有：回退/失败/取消一律不清空（验收「保留已选配置」）。
  const [config, setConfig] = useState<TConfig>(() => tool.config.initial());
  const [configError, setConfigError] = useState<string | null>(null);

  // ===== 执行步状态 =====
  const cancelRef = useRef({ cancelled: false });
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "failed" | "cancelled">("idle");
  const [progress, setProgress] = useState<WizardProgress>({ ratio: null, message: "准备执行…" });
  const [runError, setRunError] = useState<string | null>(null);

  // ===== 导出步状态 =====
  const outputRef = useRef<WizardOutput | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "done" | "failed">("idle");
  const [saveOutcome, setSaveOutcome] = useState<WizardSaveOutcome | null>(null);

  const readyFiles = fileEntries.flatMap((entry) => (entry.status === "ready" && entry.info ? [entry.info] : []));
  const filesBusy = fileEntries.some((entry) => entry.status === "loading");
  const filesBroken = fileEntries.some((entry) => entry.status === "error");
  const canLeaveFiles = !filesBusy && !filesBroken && fileEntries.length >= tool.files.minCount;

  // ===== 文件步：添加（plugin-dialog，多选按工具定义）/ 移除 / 排序 =====
  const addFiles = useCallback(async () => {
    let picked: string | string[] | null;
    try {
      picked = await openFileDialog({
        multiple: tool.files.multiple,
        directory: false,
        filters: tool.files.filters ?? [{ name: "PDF", extensions: ["pdf"] }],
      });
    } catch (error) {
      setConfigError(`打开文件对话框失败：${describeError(error)}`);
      return;
    }
    const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter((p) => p.length > 0);
    if (paths.length === 0) return;
    setConfigError(null);
    // 单文件工具（multiple=false）：新选择直接替换（minCount=1 的工具不该出现第二个文件）。
    const replacing = !tool.files.multiple;
    const fresh = paths
      .filter((path) => replacing || !fileEntries.some((entry) => entry.path === path))
      .map<FileEntry<TFileInfo>>((path) => ({ path, status: "loading" }));
    if (fresh.length === 0) return;
    setFileEntries((prev) => (replacing ? fresh : [...prev, ...fresh]));
    // 逐文件解析（并发发起，互不阻塞）；期间被移除的文件丢弃结果即可。
    for (const entry of fresh) {
      void tool.files
        .inspect(entry.path)
        .then((info) => {
          setFileEntries((prev) =>
            prev.map((item) => (item.path === entry.path ? { ...item, status: "ready", info, error: undefined } : item)),
          );
        })
        .catch((error: unknown) => {
          setFileEntries((prev) =>
            prev.map((item) =>
              item.path === entry.path ? { ...item, status: "error", error: describeError(error) } : item,
            ),
          );
        });
    }
  }, [tool, fileEntries]);

  const removeFile = useCallback((path: string) => {
    setFileEntries((prev) => prev.filter((entry) => entry.path !== path));
  }, []);

  /** 上移/下移（越界不动）——「调顺序」的通用实现，合并结果页序即此顺序。 */
  const moveFile = useCallback((index: number, delta: -1 | 1) => {
    setFileEntries((prev) => {
      const next = index + delta;
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  }, []);

  // ===== 步骤流转 =====
  const goFiles = useCallback(() => {
    setConfigError(null);
    setStep("选择文件");
  }, []);

  const goConfig = useCallback(() => {
    setConfigError(null);
    setStep("配置");
  }, []);

  /** 执行：进入执行步即开始（验收「执行进度可见」），完成自动进导出步。 */
  const startRun = useCallback(async () => {
    const problem = tool.config.validate?.(readyFiles, config) ?? null;
    if (problem) {
      setConfigError(problem);
      return;
    }
    setConfigError(null);
    setStep("执行");
    setRunStatus("running");
    setRunError(null);
    setProgress({ ratio: null, message: "准备执行…" });
    cancelRef.current = { cancelled: false };
    try {
      const output = await tool.run({
        files: readyFiles,
        config,
        onProgress: setProgress,
        cancelToken: {
          isCancelled: () => cancelRef.current.cancelled,
        },
      });
      outputRef.current = output;
      setSaveState("idle");
      setSaveOutcome(null);
      setStep("导出");
    } catch (error) {
      if (error instanceof WizardCancelled || cancelRef.current.cancelled) {
        setRunStatus("cancelled");
      } else {
        setRunStatus("failed");
        setRunError(describeError(error));
      }
    }
    // readyFiles/config 闭包快照足够（run 一次一份；重跑走本函数重新取值）。
  }, [tool, readyFiles, config]);

  const cancelRun = useCallback(() => {
    cancelRef.current.cancelled = true;
    setProgress((prev) => ({ ...prev, message: "正在取消…" }));
  }, []);

  /** 导出步「保存」：落盘策略（单文件保存框 / 选目录）全部在工具的 save 闭包里。 */
  const startSave = useCallback(async () => {
    const output = outputRef.current;
    if (!output) return;
    setSaveState("saving");
    try {
      const outcome = await output.save();
      setSaveOutcome(outcome);
      setSaveState(outcome.status === "saved" ? "done" : outcome.status === "cancelled" ? "idle" : "failed");
    } catch (error) {
      setSaveOutcome({ status: "failed", message: describeError(error) });
      setSaveState("failed");
    }
  }, []);

  const stepIndex = STEP_OF[step];

  return (
    <div className="wizard-page">
      <header className="wizard-header">
        <button type="button" className="wizard-back" onClick={() => navigate(ROUTES.home)}>
          <ArrowLeft size={16} aria-hidden />
          返回首页
        </button>
        <h1 className="wizard-title">{tool.title}</h1>
        <p className="wizard-description">{tool.description}</p>
      </header>

      <ol className="wizard-steps" aria-label="向导步骤">
        {STEP_TITLES.map((title, index) => (
          <li
            key={title}
            className={index === stepIndex ? "wizard-step current" : index < stepIndex ? "wizard-step done" : "wizard-step"}
            aria-current={index === stepIndex ? "step" : undefined}
          >
            <span className="wizard-step-index">{index < stepIndex ? "✓" : index + 1}</span>
            <span className="wizard-step-title">{title}</span>
          </li>
        ))}
      </ol>

      <div className="wizard-body">
        {step === "选择文件" && (
          <section className="wizard-card" aria-label="选择文件">
            <div className="wizard-files-toolbar">
              <button type="button" className="wizard-button primary" onClick={() => void addFiles()}>
                <FilePlus2 size={15} aria-hidden />
                {fileEntries.length === 0
                  ? tool.files.multiple
                    ? "添加 PDF 文件"
                    : "选择 PDF 文件"
                  : tool.files.multiple
                    ? "继续添加"
                    : "重新选择"}
              </button>
              {tool.files.multiple && fileEntries.length > 1 && (
                <span className="wizard-hint">列表顺序即处理顺序，可用 ↑ / ↓ 调整。</span>
              )}
            </div>
            {fileEntries.length === 0 ? (
              <p className="wizard-empty">
                {tool.files.multiple ? "尚未选择文件——可一次多选，或分多次添加。" : "尚未选择文件。"}
              </p>
            ) : (
              <ul className="wizard-file-list">
                {fileEntries.map((entry, index) => (
                  <li key={entry.path} className={entry.status === "error" ? "wizard-file error" : "wizard-file"}>
                    <span className="wizard-file-index">{index + 1}</span>
                    <span className="wizard-file-name" title={entry.path}>
                      {entry.path.split(/[\\/]/).pop()}
                    </span>
                    <span className="wizard-file-meta">
                      {entry.status === "loading" && (
                        <>
                          <Loader2 className="wizard-spin" size={13} aria-hidden /> 正在解析…
                        </>
                      )}
                      {entry.status === "ready" && entry.info && `共 ${entry.info.numPages} 页`}
                      {entry.status === "error" && (
                        <>
                          <TriangleAlert size={13} aria-hidden /> {entry.error}
                        </>
                      )}
                    </span>
                    {tool.files.multiple && (
                      <span className="wizard-file-actions">
                        <button
                          type="button"
                          className="wizard-icon-button"
                          aria-label="上移"
                          disabled={index === 0}
                          onClick={() => moveFile(index, -1)}
                        >
                          <ArrowUp size={14} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="wizard-icon-button"
                          aria-label="下移"
                          disabled={index === fileEntries.length - 1}
                          onClick={() => moveFile(index, 1)}
                        >
                          <ArrowDown size={14} aria-hidden />
                        </button>
                      </span>
                    )}
                    <button
                      type="button"
                      className="wizard-icon-button"
                      aria-label="移除文件"
                      onClick={() => removeFile(entry.path)}
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {configError && (
              <p className="wizard-error" role="alert">
                {configError}
              </p>
            )}
            <footer className="wizard-card-footer">
              <span className="wizard-footer-note">
                {tool.files.multiple
                  ? `已选 ${fileEntries.length} 个文件${tool.files.minCount > 1 ? `（至少 ${tool.files.minCount} 个）` : ""}`
                  : fileEntries.length === 1
                    ? "已选 1 个文件"
                    : ""}
              </span>
              <button type="button" className="wizard-button primary" disabled={!canLeaveFiles} onClick={goConfig}>
                下一步：配置
              </button>
            </footer>
          </section>
        )}

        {step === "配置" && (
          <section className="wizard-card" aria-label="配置">
            <tool.config.panel files={readyFiles} config={config} onChange={setConfig} />
            {configError && (
              <p className="wizard-error" role="alert">
                {configError}
              </p>
            )}
            <footer className="wizard-card-footer">
              <button type="button" className="wizard-button" onClick={goFiles}>
                上一步：选择文件
              </button>
              <button type="button" className="wizard-button primary" disabled={readyFiles.length === 0} onClick={() => void startRun()}>
                开始执行
              </button>
            </footer>
          </section>
        )}

        {step === "执行" && (
          <section className="wizard-card" aria-label="执行">
            {runStatus === "running" && (
              <div className="wizard-run">
                <p className="wizard-run-message">{progress.message}</p>
                {progress.ratio !== null ? (
                  <div className="wizard-progress" role="progressbar" aria-valuenow={Math.round(progress.ratio * 100)}>
                    <div className="wizard-progress-fill" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
                  </div>
                ) : (
                  <div className="wizard-progress indeterminate" aria-label="处理中">
                    <div className="wizard-progress-fill" />
                  </div>
                )}
                <div className="wizard-run-actions">
                  <button type="button" className="wizard-button" onClick={cancelRun}>
                    取消
                  </button>
                </div>
              </div>
            )}
            {runStatus === "failed" && (
              <div className="wizard-run" role="alert">
                <p className="wizard-run-failed">
                  <TriangleAlert size={16} aria-hidden /> 执行失败：{runError}
                </p>
                <p className="wizard-hint">已选文件与配置均已保留，可返回调整后重试。</p>
                <div className="wizard-run-actions">
                  <button type="button" className="wizard-button primary" onClick={goConfig}>
                    返回配置
                  </button>
                </div>
              </div>
            )}
            {runStatus === "cancelled" && (
              <div className="wizard-run">
                <p className="wizard-run-message">已取消。</p>
                <p className="wizard-hint">已选文件与配置均已保留。</p>
                <div className="wizard-run-actions">
                  <button type="button" className="wizard-button primary" onClick={goConfig}>
                    返回配置
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {step === "导出" && (
          <section className="wizard-card" aria-label="导出">
            {(() => {
              const output = outputRef.current;
              if (!output) return <p className="wizard-error">执行结果丢失，请返回配置重新执行。</p>;
              const body: ReactNode[] = [
                <p key="headline" className="wizard-export-headline">
                  {output.headline}
                </p>,
              ];
              if (output.details && output.details.length > 0) {
                body.push(
                  <ul key="details" className="wizard-export-list">
                    {output.details.map((item) => (
                      <li key={item.name}>
                        <span className="wizard-export-name">{item.name}</span>
                        <span className="wizard-export-note">{item.note}</span>
                      </li>
                    ))}
                  </ul>,
                );
              }
              if (saveState === "done" && saveOutcome?.status === "saved") {
                body.push(
                  <div key="saved" className="wizard-export-saved">
                    <p className="wizard-export-saved-title">
                      <CheckCircle2 size={16} aria-hidden /> 已保存 {saveOutcome.paths.length} 个文件：
                    </p>
                    <ul className="wizard-export-paths">
                      {saveOutcome.paths.map((path) => (
                        <li key={path} title={path}>
                          {path}
                        </li>
                      ))}
                    </ul>
                  </div>,
                );
              }
              if (saveState === "failed" && saveOutcome?.status === "failed") {
                body.push(
                  <p key="failed" className="wizard-error" role="alert">
                    保存失败：{saveOutcome.message}
                  </p>,
                );
              }
              return body;
            })()}
            <footer className="wizard-card-footer">
              <button type="button" className="wizard-button" onClick={goConfig}>
                返回配置
              </button>
              {saveState === "done" ? (
                <button type="button" className="wizard-button primary" onClick={() => navigate(ROUTES.home)}>
                  完成
                </button>
              ) : (
                <button
                  type="button"
                  className="wizard-button primary"
                  disabled={saveState === "saving"}
                  onClick={() => void startSave()}
                >
                  {saveState === "saving" ? (
                    <>
                      <Loader2 className="wizard-spin" aria-hidden /> 正在保存…
                    </>
                  ) : (
                    <>
                      <FolderOpen size={15} aria-hidden /> 保存到文件…
                    </>
                  )}
                </button>
              )}
            </footer>
          </section>
        )}
      </div>
    </div>
  );
}
