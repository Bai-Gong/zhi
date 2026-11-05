import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyNativeTheme as syncNativeTheme, type ThemePreference } from "@baigong/fang/glass";
export { applyResolvedTheme, resolveTheme, systemPrefersDark, watchSystemTheme, type ThemePreference, type ResolvedTheme } from "@baigong/fang/glass";

// Only the Tauri adapter is application-owned; all theme policy lives in Fang.
export function applyNativeTheme(preference: ThemePreference): void {
  void syncNativeTheme(preference, isTauri() ? theme => getCurrentWindow().setTheme(theme) : undefined)
    .catch(error => console.warn("无法同步窗口主题：", error));
}
