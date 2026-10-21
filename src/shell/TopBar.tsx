import { NavLink } from "react-router-dom";
import { Monitor, Moon, Sun } from "lucide-react";
import { IconButton } from "../components/IconButton";
import { WindowControls } from "./WindowControls";
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

/**
 * 顶栏（shell 模块）：应用标识、主导航与主题切换（中文文案）。
 * decorations=false 后兼任窗口标题栏：顶栏背景、品牌区与标题标了
 * data-tauri-drag-region 成为拖拽区（该属性只作用于所标元素自身，
 * 导航/按钮不受影响；双击最大化由 Tauri 运行时内置处理）；
 * 右端挂自绘窗口控制按钮组（WindowControls）。
 */
export function TopBar() {
  const themePreference = useUiStore((s) => s.themePreference);
  const cycleThemePreference = useUiStore((s) => s.cycleThemePreference);
  const theme = THEME_CYCLE[themePreference];

  return (
    <header className="top-bar" data-tauri-drag-region>
      <div className="top-bar-brand" data-tauri-drag-region>
        <span className="top-bar-logo" data-tauri-drag-region aria-hidden>
          纸
        </span>
        <span className="top-bar-title" data-tauri-drag-region>
          百工·纸
        </span>
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
        <span className="top-bar-theme-text" data-tauri-drag-region aria-hidden>
          {theme.text}
        </span>
        <WindowControls />
      </div>
    </header>
  );
}
