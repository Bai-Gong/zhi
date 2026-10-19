/** 最近文件的唯一读写实现（技术方案模块 5 与 5.1 第 2 条）：localStorage 键 zhi.recentFiles。 */
export interface RecentFile {
  /** 本地绝对路径，唯一标识。 */
  path: string;
  fileName: string;
  /** 打开时间（epoch 毫秒）。 */
  openedAt: number;
  numPages?: number;
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
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
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
