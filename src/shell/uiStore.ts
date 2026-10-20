import { create } from "zustand";
import { applyResolvedTheme, resolveTheme, watchSystemTheme, type ThemePreference, type ResolvedTheme } from "./theme";

export type { ThemePreference, ResolvedTheme } from "./theme";
export type SidebarTab = "thumbnails" | "bookmarks" | "search";

/** UI 偏好持久化键（localStorage；最近文件的键 zhi.recentFiles 归 core/document，互不冲突）。 */
const PREFS_STORAGE_KEY = "zhi.uiPrefs";

/** 沉浸下可被边缘唤出的两块 chrome 区：顶区（顶栏+查看器工具栏）、左区（侧栏）。 */
export interface ImmersiveReveal {
  top: boolean;
  left: boolean;
}

interface PersistedPrefs {
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  themePreference: ThemePreference;
  rightPanelVisible: boolean;
  /** 深色阅读：反转文档画布底色（M2，与 UI 主题正交）。 */
  invertCanvas: boolean;
}

interface UiState extends PersistedPrefs {
  /** 解析后的实际主题（system 偏好随系统变化刷新）。 */
  resolvedTheme: ResolvedTheme;
  // ===== 阅读模式（M2）：瞬态，不持久化 =====
  /** 沉浸模式：隐藏顶栏/侧栏/工具栏/右侧面板，鼠标移到边缘唤出（useImmersiveEdges）。 */
  immersiveMode: boolean;
  /** 沉浸下已唤出的 chrome 区（鼠标状态机驱动，高频更新）。 */
  immersiveReveal: ImmersiveReveal;
  /** 搜索面板聚焦请求序号：Ctrl+F 时递增，SearchPanel 订阅后 focus+select。 */
  searchFocusRequest: number;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setThemePreference: (preference: ThemePreference) => void;
  /** 浅色 → 深色 → 跟随系统 循环切换。 */
  cycleThemePreference: () => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
  enterImmersive: () => void;
  exitImmersive: () => void;
  toggleImmersive: () => void;
  /** 设置唤出区；值与当前相同则原样返回（zustand v5 的 Object.is 短路，mousemove 高频下零下游更新）。 */
  setImmersiveReveal: (partial: Partial<ImmersiveReveal>) => void;
  /** 请求搜索输入聚焦（递增序号触发订阅方）。 */
  requestSearchFocus: () => void;
  toggleInvertCanvas: () => void;
}

const SIDEBAR_TABS: readonly SidebarTab[] = ["thumbnails", "bookmarks", "search"];
const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** 逐字段校验后吸收持久化值，杜绝脏数据流入 store。 */
function loadPrefs(): Partial<PersistedPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const saved = parsed as Record<string, unknown>;
    const prefs: Partial<PersistedPrefs> = {};
    if (typeof saved.sidebarCollapsed === "boolean") prefs.sidebarCollapsed = saved.sidebarCollapsed;
    if (typeof saved.sidebarTab === "string" && (SIDEBAR_TABS as readonly string[]).includes(saved.sidebarTab)) {
      prefs.sidebarTab = saved.sidebarTab as SidebarTab;
    }
    if (isThemePreference(saved.themePreference)) prefs.themePreference = saved.themePreference;
    if (typeof saved.rightPanelVisible === "boolean") prefs.rightPanelVisible = saved.rightPanelVisible;
    if (typeof saved.invertCanvas === "boolean") prefs.invertCanvas = saved.invertCanvas;
    return prefs;
  } catch {
    return {}; // 损坏的持久化数据直接忽略，回落默认值
  }
}

function savePrefs(prefs: PersistedPrefs): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 隐私模式/存储被禁时静默失败，不影响运行
  }
}

function persistedPrefsOf(state: UiState): PersistedPrefs {
  return {
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarTab: state.sidebarTab,
    themePreference: state.themePreference,
    rightPanelVisible: state.rightPanelVisible,
    invertCanvas: state.invertCanvas,
  };
}

const THEME_CYCLE: readonly ThemePreference[] = ["light", "dark", "system"];
const REVEAL_HIDDEN: ImmersiveReveal = { top: false, left: false };

const initialPrefs: PersistedPrefs = {
  sidebarCollapsed: false,
  sidebarTab: "thumbnails",
  themePreference: "system",
  rightPanelVisible: true,
  invertCanvas: false,
  ...loadPrefs(),
};
const initialResolved = resolveTheme(initialPrefs.themePreference);

/**
 * shell 模块的 UI 偏好 store。
 * 全局 store 仅允许 core/document 与 shell 两处（技术方案 4.3 规则 5）。
 */
export const useUiStore = create<UiState>((set, get) => ({
  ...initialPrefs,
  resolvedTheme: initialResolved,
  immersiveMode: false,
  immersiveReveal: REVEAL_HIDDEN,
  searchFocusRequest: 0,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setThemePreference: (preference) =>
    set({ themePreference: preference, resolvedTheme: resolveTheme(preference) }),
  cycleThemePreference: () => {
    const index = THEME_CYCLE.indexOf(get().themePreference);
    get().setThemePreference(THEME_CYCLE[(index + 1) % THEME_CYCLE.length]);
  },
  toggleRightPanel: () => set((s) => ({ rightPanelVisible: !s.rightPanelVisible })),
  setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
  enterImmersive: () => set((s) => (s.immersiveMode ? s : { immersiveMode: true, immersiveReveal: REVEAL_HIDDEN })),
  exitImmersive: () =>
    set((s) =>
      s.immersiveMode || s.immersiveReveal.top || s.immersiveReveal.left
        ? { immersiveMode: false, immersiveReveal: REVEAL_HIDDEN }
        : s,
    ),
  toggleImmersive: () =>
    set((s) => ({ immersiveMode: !s.immersiveMode, immersiveReveal: REVEAL_HIDDEN })),
  setImmersiveReveal: (partial) =>
    set((s) => {
      const next = { ...s.immersiveReveal, ...partial };
      if (next.top === s.immersiveReveal.top && next.left === s.immersiveReveal.left) return s;
      return { immersiveReveal: next };
    }),
  requestSearchFocus: () => set((s) => ({ searchFocusRequest: s.searchFocusRequest + 1 })),
  toggleInvertCanvas: () => set((s) => ({ invertCanvas: !s.invertCanvas })),
}));

/** 输入框「无可清内容」时的 Escape 兜底：交还焦点；沉浸下退出沉浸（逃生通道，M2 阅读模式）。 */
export function escapeFromEditable(target: HTMLElement): void {
  target.blur();
  const ui = useUiStore.getState();
  if (ui.immersiveMode) ui.exitImmersive();
}

// ===== 模块加载即启动的副作用（先于首帧渲染，避免主题闪变） =====

// 首帧前应用一次解析后的主题
applyResolvedTheme(initialResolved);

// 主题变化 → 写 <html data-theme>；偏好变化 → 序列化脏检查后持久化。
// reveal 等瞬态字段高频更新时，序列化串不变即不写 localStorage（A3 双保险之二）。
let lastAppliedTheme: ResolvedTheme = initialResolved;
let lastSavedPrefsJson = JSON.stringify(initialPrefs);
useUiStore.subscribe((s) => {
  if (s.resolvedTheme !== lastAppliedTheme) {
    lastAppliedTheme = s.resolvedTheme;
    applyResolvedTheme(s.resolvedTheme);
  }
  const prefsJson = JSON.stringify(persistedPrefsOf(s));
  if (prefsJson !== lastSavedPrefsJson) {
    lastSavedPrefsJson = prefsJson;
    savePrefs(persistedPrefsOf(s));
  }
});

// 偏好为「跟随系统」时，系统主题变化实时刷新
watchSystemTheme((dark) => {
  const s = useUiStore.getState();
  if (s.themePreference !== "system") return;
  const resolved: ResolvedTheme = dark ? "dark" : "light";
  if (s.resolvedTheme !== resolved) useUiStore.setState({ resolvedTheme: resolved });
});
