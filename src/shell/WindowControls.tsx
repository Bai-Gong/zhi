import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 自绘窗口控制按钮组（shell 模块）：decorations=false 后替代系统标题栏的
 * 最小化 / 最大化（还原）/ 关闭。最大化态经 tauri://resize 事件跟随窗口
 * 实际状态（任务栏还原、贴边分屏等来源的变化都会同步），用于切换
 * 「最大化 □ / 还原 ❐」两枚图标。按钮贴窗口右上角、整高悬停带，
 * 关闭键悬停转红（Windows 惯例）。
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    let unlisten: (() => void) | undefined;
    const sync = () => win.isMaximized().then((v) => setMaximized(v)).catch(() => {});
    sync();
    win
      .onResized(sync)
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const win = getCurrentWindow();
  const MaximizeIcon = maximized ? Copy : Square;
  const maximizeLabel = maximized ? "还原" : "最大化";

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button
        type="button"
        className="window-control-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => win.minimize()}
      >
        <Minus size={15} aria-hidden />
      </button>
      <button
        type="button"
        className="window-control-btn"
        title={maximizeLabel}
        aria-label={maximizeLabel}
        onClick={() => win.toggleMaximize()}
      >
        <MaximizeIcon size={maximized ? 14 : 13} aria-hidden />
      </button>
      <button
        type="button"
        className="window-control-btn window-control-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => win.close()}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
