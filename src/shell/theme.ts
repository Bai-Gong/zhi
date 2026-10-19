/**
 * 主题骨架（shell 模块）：浅色 / 深色 / 跟随系统。
 * 主题以 CSS 变量落地（浅色基线在 src/styles/global.css，深色覆盖在 shell/theme.css），
 * 这里只负责「偏好 → 解析 → 写到 <html data-theme>」，为日后接入 fang/ 共享外壳留接口。
 */

export type ResolvedTheme = "light" | "dark";
export type ThemePreference = ResolvedTheme | "system";

const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

function matchMediaAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/** 当前系统是否偏好深色。 */
export function systemPrefersDark(): boolean {
  return matchMediaAvailable() ? window.matchMedia(PREFERS_DARK_QUERY).matches : false;
}

/** 把偏好解析成确定主题：system 时读系统偏好。 */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? (systemPrefersDark() ? "dark" : "light") : preference;
}

/** 把解析结果写到文档根元素：变量选择器 + 滚动条等原生控件配色。 */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** 监听系统主题变化，返回取消函数。 */
export function watchSystemTheme(listener: (dark: boolean) => void): () => void {
  if (!matchMediaAvailable()) return () => {};
  const mql = window.matchMedia(PREFERS_DARK_QUERY);
  mql.addEventListener("change", (event) => listener(event.matches));
  return () => mql.removeEventListener("change", (event) => listener(event.matches));
}
