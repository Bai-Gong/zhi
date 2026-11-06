import type { DocumentFormat } from "./officeValidation";
/** 最近文件的唯一读写实现（技术方案模块 5 与 5.1 第 2 条）：localStorage 键 zhi.recentFiles。 */
export interface RecentFile {
  /** 本地绝对路径，唯一标识。 */
  path: string;
  fileName: string;
  /** 打开时间（epoch 毫秒）。 */
  openedAt: number;
  numPages?: number;
  sourceFormat?: DocumentFormat;
}

const STORAGE_KEY = "zhi.recentFiles";
const LIMIT = 20;

function parse(raw: string | null): RecentFile[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RecentFile => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as Partial<RecentFile>;
      return typeof candidate.path === "string" && typeof candidate.fileName === "string";
    });
  } catch {
    return [];
  }
}

/** 读取最近文件列表（新→旧）。 */
export function loadRecentFiles(): RecentFile[] {
  return parse(window.localStorage.getItem(STORAGE_KEY));
}

function persist(files: RecentFile[]): RecentFile[] {
  // 写入失败必须就地吸收：addRecentFile 的调用点在 openDocument 的 try 块内
  // （装载已就绪），无保护的异常会把已就绪文档误标「装载失败」。隐私模式/
  // 配额满时静默降级——最近文件是附属记录，不值得打断打开流程。
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  } catch (error) {
    console.warn("最近文件写入 localStorage 失败：", error);
  }
  return files;
}

/** 记录一次打开：按路径去重并置顶，超上限截断。返回更新后的列表。 */
export function addRecentFile(entry: Omit<RecentFile, "openedAt"> & { openedAt?: number }): RecentFile[] {
  const rest = loadRecentFiles().filter((item) => item.path !== entry.path);
  const next: RecentFile = { ...entry, openedAt: entry.openedAt ?? Date.now() };
  return persist([next, ...rest].slice(0, LIMIT));
}

/** 移除一条最近文件。返回更新后的列表。 */
export function removeRecentFile(path: string): RecentFile[] {
  return persist(loadRecentFiles().filter((item) => item.path !== path));
}
