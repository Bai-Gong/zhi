import { create } from "zustand";
import { applyResolvedTheme, resolveTheme, watchSystemTheme, type ThemePreference, type ResolvedTheme } from "./theme";

export type { ThemePreference, ResolvedTheme } from "./theme";
export type SidebarTab = "thumbnails" | "bookmarks";

/** UI 偏好持久化键（localStorage；最近文件的键 zhi.recentFiles 归 core/document，互不冲突）。 */
const PREFS_STORAGE_KEY = "zhi.uiPrefs";

interface PersistedPrefs {
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  themePreference: ThemePreference;
  rightPanelVisible: boolean;
}

interface UiState extends PersistedPrefs {
  /** 解析后的实际主题（system 偏好随系统变化刷新）。 */
  resolvedTheme: ResolvedTheme;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setThemePreference: (preference: ThemePreference) => void;
  /** 浅色 → 深色 → 跟随系统 循环切换。 */
  cycleThemePreference: () => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
}

const SIDEBAR_TABS: readonly SidebarTab[] = ["thumbnails", "bookmarks"];
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

const THEME_CYCLE: readonly ThemePreference[] = ["light", "dark", "system"];

const initialPrefs: PersistedPrefs = {
  sidebarCollapsed: false,
  sidebarTab: "thumbnails",
  themePreference: "system",
  rightPanelVisible: true,
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
}));

// ===== 模块加载即启动的副作用（先于首帧渲染，避免主题闪变） =====

// 首帧前应用一次解析后的主题
applyResolvedTheme(initialResolved);

// 主题变化 → 写 <html data-theme>；任意偏好变化 → 持久化
let lastAppliedTheme: ResolvedTheme = initialResolved;
useUiStore.subscribe((s) => {
  if (s.resolvedTheme !== lastAppliedTheme) {
    lastAppliedTheme = s.resolvedTheme;
    applyResolvedTheme(s.resolvedTheme);
  }
  savePrefs({
    sidebarCollapsed: s.sidebarCollapsed,
    sidebarTab: s.sidebarTab,
    themePreference: s.themePreference,
    rightPanelVisible: s.rightPanelVisible,
  });
});

// 偏好为「跟随系统」时，系统主题变化实时刷新
watchSystemTheme((dark) => {
  const s = useUiStore.getState();
  if (s.themePreference !== "system") return;
  const resolved: ResolvedTheme = dark ? "dark" : "light";
  if (s.resolvedTheme !== resolved) useUiStore.setState({ resolvedTheme: resolved });
});
