import { NavLink } from "react-router-dom";
import { Monitor, Moon, Sun } from "lucide-react";
import { IconButton } from "../components/IconButton";
import { ROUTES } from "./routes";
import { useUiStore, type ThemePreference } from "./uiStore";

const NAV_ITEMS = [
  { to: ROUTES.home, label: "首页", end: true },
  { to: ROUTES.viewer, label: "查看器", end: false },
] as const;

/** 主题循环：浅色 → 深色 → 跟随系统（uiStore.cycleThemePreference 同序）。 */
const THEME_CYCLE: Record<ThemePreference, { icon: typeof Sun; text: string; action: string }> = {
  light: { icon: Sun, text: "浅色", action: "当前浅色主题，点击切换为深色" },
  dark: { icon: Moon, text: "深色", action: "当前深色主题，点击切换为跟随系统" },
  system: { icon: Monitor, text: "跟随系统", action: "当前跟随系统主题，点击切换为浅色" },
};

/** 顶栏（shell 模块）：应用标识、主导航与主题切换（中文文案）。 */
export function TopBar() {
  const themePreference = useUiStore((s) => s.themePreference);
  const cycleThemePreference = useUiStore((s) => s.cycleThemePreference);
  const theme = THEME_CYCLE[themePreference];

  return (
    <header className="top-bar">
      <div className="top-bar-brand">
        <span className="top-bar-logo" aria-hidden>
          纸
        </span>
        <span className="top-bar-title">百工·纸</span>
      </div>
      <nav className="top-bar-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `top-bar-link${isActive ? " active" : ""}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="top-bar-actions">
        <IconButton icon={theme.icon} label={theme.action} onClick={cycleThemePreference} />
        <span className="top-bar-theme-text" aria-hidden>
          {theme.text}
        </span>
      </div>
    </header>
  );
}
