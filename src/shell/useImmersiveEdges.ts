import { useEffect, useState } from "react";

const CHROME = ".top-bar, .viewer-toolbar, .tab-strip, .sidebar, .shell-aside";
const EDGE_PX = 8;
const DWELL_MS = 200;
const HIDE_DELAY_MS = 1600;

/** 归档方案的边缘驻留与焦点保护，适配当前多标签界面。 */
export function useImmersiveEdges(active: boolean): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    setRevealed(false);
    if (!active) return;
    let dwellTimer = 0;
    let hideTimer = 0;
    let visible = false;
    let mouse: { x: number; y: number } | null = null;
    const atEdge = () => mouse !== null && (mouse.y <= EDGE_PX || mouse.x <= EDGE_PX);
    const pinned = () => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(CHROME));
      if (elements.some((el) => el.contains(document.activeElement))) return true;
      return mouse !== null && elements.some((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && mouse!.x >= rect.left && mouse!.x <= rect.right &&
          mouse!.y >= rect.top && mouse!.y <= rect.bottom;
      });
    };
    const evaluate = () => {
      if (atEdge()) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
        if (!visible && !dwellTimer) dwellTimer = window.setTimeout(() => {
          dwellTimer = 0;
          visible = true;
          setRevealed(true);
        }, DWELL_MS);
      } else {
        window.clearTimeout(dwellTimer);
        dwellTimer = 0;
        if (visible && pinned()) {
          window.clearTimeout(hideTimer);
          hideTimer = 0;
        } else if (visible && !hideTimer) {
          hideTimer = window.setTimeout(() => {
            hideTimer = 0;
            if (atEdge() || pinned()) return;
            visible = false;
            setRevealed(false);
          }, HIDE_DELAY_MS);
        }
      }
    };
    const onMove = (event: MouseEvent) => { mouse = { x: event.clientX, y: event.clientY }; evaluate(); };
    const onLeave = () => { mouse = null; evaluate(); };
    // focusout 后 activeElement 才切换；延后一轮复检，避免把有焦点的控件收走。
    let focusTimer = 0;
    const onFocus = () => { window.clearTimeout(focusTimer); focusTimer = window.setTimeout(evaluate, 0); };
    window.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    return () => {
      window.clearTimeout(dwellTimer);
      window.clearTimeout(hideTimer);
      window.clearTimeout(focusTimer);
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
    };
  }, [active]);
  return active && revealed;
}
