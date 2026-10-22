import type { ComponentType } from "react";

/**
 * 工具向导框架的配置契约（M4，模块 1 归档；里程碑 M4-5）。
 *
 * 框架（ToolWizard.tsx）只实现四步状态机与通用 UI，对具体工具**零感知**：
 * 一个工具 = 一份 {@link WizardToolDefinition}（选文件方式 + 配置面板 + 执行器）。
 * 后续里程碑（M6 格式转换等）的新工具以此**配置方式接入**，不改框架代码；
 * 注册见 features/tools/registry.ts（数据文件，非框架）。
 *
 * 本文件不得 import 任何重库（pdfjs-dist/pdf-lib 只允许出现在 src/core/document，
 * 技术方案 4.3 规则 1），类型全部为纯数据/React 组件类型。
 */

/** 选定文件的基础元信息（工具可在扩展字段里携带更多解析结果，如书签概要）。 */
export interface WizardFileBase {
  /** 本地绝对路径。 */
  path: string;
  fileName: string;
  /** 文档页数。 */
  numPages: number;
}

/** 执行进度：ratio 为 0–1（阶段性未知进度用 null），message 为中文阶段文案。 */
export interface WizardProgress {
  ratio: number | null;
  message: string;
}

/** 取消令牌：框架在用户点「取消」时置位；执行器在安全点轮询并抛 {@link WizardCancelled}。 */
export interface WizardCancelToken {
  isCancelled(): boolean;
}

/** 执行器因用户取消而中止（框架捕获后回到配置步，已选文件与配置全部保留）。 */
export class WizardCancelled extends Error {
  constructor() {
    super("已取消");
    this.name = "WizardCancelled";
  }
}

/** 导出（落盘）结局三态，与 core/document 的 SaveCopyResult 同构（含多文件扩展）。 */
export type WizardSaveOutcome =
  | { status: "saved"; paths: string[] }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

/** 执行产物明细行（导出步的清单预览）。 */
export interface WizardOutputItem {
  /** 明细名称（如输出文件名）。 */
  name: string;
  /** 一句话说明（如对应页范围）。 */
  note: string;
}

/**
 * 执行产物：内存中的结果 + 落盘函数。
 * `save` 在导出步用户点「保存」时才调用（内部弹保存/目录对话框并写文件，
 * 全程不抛出——结局折算进 {@link WizardSaveOutcome}）。
 */
export interface WizardOutput {
  /** 结果摘要（导出步顶部，如「合并完成：共 12 页」）。 */
  headline: string;
  /** 明细清单（可选）。 */
  details?: WizardOutputItem[];
  /** 落盘（弹对话框 + 写用户选定的新文件/目录）；原文件绝不被改动由工具侧保证。 */
  save: () => Promise<WizardSaveOutcome>;
}

/** 文件选择对话框的过滤器（与 plugin-dialog 的 filters 同构，框架内不引插件类型）。 */
export interface WizardFileFilter {
  name: string;
  extensions: string[];
}

/** 配置面板的受控 props（框架渲染 tool.config.panel，配置状态归框架持有）。 */
export interface WizardConfigPanelProps<TConfig, TFileInfo extends WizardFileBase> {
  /** 解析就绪的文件元信息（顺序即文件步的当前顺序）。 */
  files: readonly TFileInfo[];
  config: TConfig;
  onChange: (next: TConfig) => void;
}

/** 向导工具定义——新工具接入的全部契约（M6 起照此扩展，无需改框架）。 */
export interface WizardToolDefinition<TConfig, TFileInfo extends WizardFileBase> {
  /** 工具 id（路由 /tools/:toolId 使用，注册表内唯一）。 */
  id: string;
  title: string;
  /** 顶部一句话说明（文件步标题下方）。 */
  description: string;
  files: {
    /** 是否允许多选（合并为 true、拆分为 false）。 */
    multiple: boolean;
    /** 进入配置步所需的最少文件数。 */
    minCount: number;
    /** 文件选择对话框过滤器（缺省 PDF）。 */
    filters?: WizardFileFilter[];
    /**
     * 解析单个文件的元信息（页数等）。抛出 = 该文件不可用（中文原因，
     * 文件步标红展示、可移除；存在不可用文件时禁止进入配置步）。
     */
    inspect: (path: string) => Promise<TFileInfo>;
  };
  /**
   * 配置步（可选）。缺省 = 无配置工具：向导只有「选文件 → 执行 → 导出」三步，
   * 选完文件直接执行（如 Word→PDF——纸张/边距全部取自文档自身，不靠用户选）。
   */
  config?: {
    /** 向导挂载时的初始配置。 */
    initial: () => TConfig;
    /** 配置面板（受控组件：文件元信息只读流入，配置改动经 onChange 流出）。 */
    panel: ComponentType<WizardConfigPanelProps<TConfig, TFileInfo>>;
    /** 返回中文错误文案 = 禁止进入执行步；null/undefined 放行。 */
    validate?: (files: readonly TFileInfo[], config: TConfig) => string | null;
  };
  /**
   * 执行（配置步「开始执行」或无配置工具的「开始执行」触发一次）：产出内存结果
   * 与落盘函数。实现约定：轮询 cancelToken，在安全点抛 {@link WizardCancelled}；
   * 阶段性调用 onProgress；失败直接抛错（中文 message，框架呈现并保留配置）。
   * 无配置工具的 config 为 undefined（TConfig 记为 void/undefined 即可）。
   */
  run: (input: {
    files: readonly TFileInfo[];
    config: TConfig;
    onProgress: (progress: WizardProgress) => void;
    cancelToken: WizardCancelToken;
  }) => Promise<WizardOutput>;
}
