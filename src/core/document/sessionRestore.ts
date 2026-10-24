// 轻量会话恢复（多标签增强 T7）：把标签清单（顺序/页码/缩放/激活项）写入
// localStorage，重启后由首页「恢复上次会话（N 个文档）」卡片一键批量重开
// （复用 openDocument 的批量打开器 openDocumentsBatch）。
//
// 设计口径：
// - 另立新键 `zhi.lastSession`：有序标签会话与去重置顶的最近文件（zhi.recentFiles）
//   语义不同，混键互相污染；
// - 写入节流（订阅 store）：**标签集/顺序/激活变化立即写**（低频、关窗前必准确），
//   **页码/缩放变化 debounce 800ms**（翻页滚动高频，不能每帧写）；关窗瞬间存在
//   debounce 窗口内的最后一次翻页丢失，用 beforeunload 同步 flush 兜底；
// - 标签清空（关掉最后一个标签 / 关闭全部）即清键——重启后首页不再出现恢复卡片；
// - 解析防御损坏 JSON、写入 try-catch，失败后**停写降级**（console.warn 一次，
//   本次运行不再重试，不影响任何功能）；
// - 只存纯数据（路径/页码/缩放），pdf.js 文档代理与高亮不入快照（高亮跨会话
//   持久化是 M2 明确不做的独立话题）；失效文件恢复时自然走 failTab
//   「打开失败」标签兜底（保留 sourcePath 可见、可重试）。
//
// 副作用与 shell/uiStore 同款「模块加载即启动」：App 静态导入 HomePage →
// 本模块必然加载，订阅随模块缓存只装一次（StrictMode 双渲染安全）。
import { useDocumentStore, activeTabOf } from "./store";

/** 会话恢复持久化键（与 zhi.recentFiles / zhi.uiPrefs 互不冲突）。 */
const STORAGE_KEY = "zhi.lastSession";
/** 页码/缩放的 debounce 写入间隔（毫秒）：高频翻页/缩放不阻塞交互。 */
const PERSIST_DEBOUNCE_MS = 800;

/** 单个标签的恢复快照（纯数据）。 */
export interface SessionTabSnapshot {
  /** 打开时的本地绝对路径（恢复时按它重新装载）。 */
  path: string;
  /** 1 起页码。 */
  page: number;
  /** 0.25–4.0 缩放。 */
  scale: number;
}

/** 一次会话的恢复快照：有序标签清单 + 恢复完成后应激活的路径。 */
export interface SessionSnapshot {
  tabs: SessionTabSnapshot[];
  /** 记录时的激活标签路径（找不到则落到批量打开的末位标签）。 */
  activePath: string | null;
}

function snapshotOf(state: ReturnType<typeof useDocumentStore.getState>): SessionSnapshot | null {
  // 无标签（关掉最后一个 / 关闭全部）＝ 没有可恢复会话，写 null 清键。
  if (state.tabs.length === 0) return null;
  const tabs: SessionTabSnapshot[] = [];
  for (const tab of state.tabs) {
    if (!tab.sourcePath) continue; // 防御：无路径的标签无法恢复
    tabs.push({ path: tab.sourcePath, page: tab.currentPage, scale: tab.scale });
  }
  if (tabs.length === 0) return null;
  return { tabs, activePath: activeTabOf(state).sourcePath ?? null };
}

/** 写失败后置 true：本次运行停写降级（隐私模式/配额满，重试无意义）。 */
let persistBroken = false;

function persistSnapshot(snapshot: SessionSnapshot | null): void {
  if (persistBroken) return;
  try {
    if (snapshot) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    persistBroken = true;
    console.warn("会话恢复写入 localStorage 失败，本次运行停止记录：", error);
  }
}

function parseSnapshot(raw: string | null): SessionSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<SessionSnapshot>;
    if (!Array.isArray(candidate.tabs) || candidate.tabs.length === 0) return null;
    const tabs: SessionTabSnapshot[] = [];
    for (const item of candidate.tabs) {
      if (typeof item !== "object" || item === null) continue;
      const tab = item as Partial<SessionTabSnapshot>;
      // 页码/缩放非法时回落默认值（第 1 页/100%），路径缺失才整条丢弃。
      if (typeof tab.path !== "string" || tab.path.length === 0) continue;
      tabs.push({
        path: tab.path,
        page: typeof tab.page === "number" && Number.isFinite(tab.page) ? tab.page : 1,
        scale: typeof tab.scale === "number" && Number.isFinite(tab.scale) ? tab.scale : 1,
      });
    }
    if (tabs.length === 0) return null;
    return {
      tabs,
      activePath: typeof candidate.activePath === "string" ? candidate.activePath : null,
    };
  } catch {
    return null; // 损坏的 JSON 直接当作无记录
  }
}

/** 读取上次会话快照（无记录/数据损坏返回 null）。 */
export function loadLastSession(): SessionSnapshot | null {
  try {
    return parseSnapshot(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 清除会话记录（首页「忽略」入口）：刷新后不再出现恢复卡片。 */
export function clearLastSession(): void {
  persistSnapshot(null);
}

// ===== 模块加载即启动的副作用（shell/uiStore 同款模式） =====

let debounceTimer: number | null = null;

function cancelDebounce(): void {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function writeNow(): void {
  persistSnapshot(snapshotOf(useDocumentStore.getState()));
}

useDocumentStore.subscribe((state, prev) => {
  // 标签集/顺序/激活变化（打开/关闭/重排/切换）：低频，立即写。
  // 顺序变化靠「id 序列」比较捕获（moveTab 只变顺序不变集合）。
  const structural =
    state.tabs.length !== prev.tabs.length ||
    state.activeTabId !== prev.activeTabId ||
    state.tabs.some((t, i) => t.id !== prev.tabs[i]?.id);
  if (structural) {
    cancelDebounce();
    writeNow();
    return;
  }
  // 页码/缩放变化（翻页滚动/Ctrl+滚轮缩放）：高频，debounce 写入不阻塞交互。
  const positional = state.tabs.some(
    (t, i) => t.currentPage !== prev.tabs[i]?.currentPage || t.scale !== prev.tabs[i]?.scale,
  );
  if (positional) {
    cancelDebounce();
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      writeNow();
    }, PERSIST_DEBOUNCE_MS);
  }
});

// 关窗兜底：debounce 窗口内的最后一次翻页/缩放在这里同步落盘
// （beforeunload 监听器是同步执行的，localStorage 写入来得及）。
window.addEventListener("beforeunload", () => {
  cancelDebounce();
  writeNow();
});
