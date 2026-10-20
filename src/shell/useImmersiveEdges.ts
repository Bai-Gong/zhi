import { useEffect } from "react";
import { useUiStore, type ImmersiveReveal } from "./uiStore";

/**
 * 沉浸模式边缘唤出状态机（shell 模块，M2 阅读模式，里程碑验收 4）。
 *
 * - 条带定义：顶条带 y≤EDGE_PX 全宽；左条带 x≤EDGE_PX 且 y>EDGE_PX——
 *   左上 8×8 角区归顶区（顶区优先），两区已揭示后互不排斥、各自独立收起；
 * - 驻留：鼠标进入条带起 DWELL_MS 一次定时（条带内移动不重置，累计停留即算），
 *   移出条带即取消——斜穿屏幕不误触发；
 * - 钉住：每 mousemove 判定「鼠标 ∈ 该区条带 ∪ 该区揭示完成后的缓存 rect」，
 *   由钉住转未钉住起一次 HIDE_DELAY_MS 隐藏定时（此后移动不重置），重回即取消；
 * - 隐藏定时触发时双复检：实时重取 rect（此刻过渡必已结束，无插值中间值）判
 *   鼠标最后位置，并查 activeElement 是否在该区 chrome 内（focus 钉住——搜索
 *   输入框聚焦时侧栏绝不收走）；任一成立即取消隐藏；
 * - rect 缓存用纯定时兜底（REVEAL_SETTLE_MS > 过渡时长），不依赖 transitionend，
 *   兼容关闭过渡（prefers-reduced-motion）等场景；
 * - 鼠标离开窗口（document mouseleave）：清全部驻留定时，已揭示区按未钉住收起。
 */
/** 边缘条带厚度（px）。 */
const EDGE_PX = 8;
/** 条带内驻留揭示延时（ms）。 */
const DWELL_MS = 200;
/** 离开后自动隐藏延时（ms）。 */
const HIDE_DELAY_MS = 1600;
/** 揭示后缓存最终 rect 的兜底延时（ms，须大于 CSS 过渡时长 200ms）。 */
const REVEAL_SETTLE_MS = 250;

type Zone = "top" | "left";

/** 各区 chrome 的稳定选择器：顶区=顶栏+查看器工具栏，左区=侧栏（均随窗口 resize 实时重取）。 */
const ZONE_SELECTORS: Record<Zone, readonly string[]> = {
  top: [".top-bar", ".viewer-toolbar"],
  left: [".sidebar"],
};

function zoneElements(zone: Zone): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const selector of ZONE_SELECTORS[zone]) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) found.push(el);
  }
  return found;
}

function rectsOf(zone: Zone): DOMRect[] {
  return zoneElements(zone).map((el) => el.getBoundingClientRect());
}

function pointInRects(x: number, y: number, rects: DOMRect[]): boolean {
  return rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
}

function inStrip(zone: Zone, x: number, y: number): boolean {
  return zone === "top" ? y <= EDGE_PX : x <= EDGE_PX && y > EDGE_PX;
}

const ZONES: readonly Zone[] = ["top", "left"];

/** 仅在沉浸模式且查看器路由时激活（由调用方传入 active）。 */
export function useImmersiveEdges(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    let lastMouse: { x: number; y: number } | null = null;
    const dwellTimers: Record<Zone, number> = { top: 0, left: 0 };
    const hideTimers: Record<Zone, number> = { top: 0, left: 0 };
    const settleTimers: Record<Zone, number> = { top: 0, left: 0 };
    const pinned: Record<Zone, boolean> = { top: false, left: false };
    /** 揭示完成后的最终布局 rect（钉住判定用缓存值，避开过渡插值中间值）；隐藏时清空。 */
    const cachedRects: Record<Zone, DOMRect[]> = { top: [], left: [] };

    const clearTimer = (timers: Record<Zone, number>, zone: Zone) => {
      if (timers[zone]) {
        window.clearTimeout(timers[zone]);
        timers[zone] = 0;
      }
    };

    const setZoneRevealed = (zone: Zone, value: boolean) => {
      const partial: Partial<ImmersiveReveal> = zone === "top" ? { top: value } : { left: value };
      useUiStore.getState().setImmersiveReveal(partial);
    };

    const reveal = (zone: Zone) => {
      clearTimer(hideTimers, zone);
      setZoneRevealed(zone, true);
      // 过渡完成后缓存最终 rect（纯定时兜底，不依赖 transitionend）。
      clearTimer(settleTimers, zone);
      settleTimers[zone] = window.setTimeout(() => {
        settleTimers[zone] = 0;
        cachedRects[zone] = rectsOf(zone);
      }, REVEAL_SETTLE_MS);
    };

    const scheduleHide = (zone: Zone) => {
      clearTimer(hideTimers, zone);
      hideTimers[zone] = window.setTimeout(() => {
        hideTimers[zone] = 0;
        const mouse = lastMouse;
        if (!mouse) return; // 从未见过鼠标：不做动作
        // 双复检：实时 rect（此刻过渡必已结束）判鼠标最后位置 + 焦点包含。
        if (inStrip(zone, mouse.x, mouse.y) || pointInRects(mouse.x, mouse.y, rectsOf(zone))) return;
        const focusEl = document.activeElement;
        if (focusEl && zoneElements(zone).some((el) => el.contains(focusEl))) return;
        setZoneRevealed(zone, false);
        cachedRects[zone] = [];
      }, HIDE_DELAY_MS);
    };

    const evaluate = (x: number, y: number) => {
      const revealState = useUiStore.getState().immersiveReveal;
      for (const zone of ZONES) {
        const strip = inStrip(zone, x, y);
        const zonePinned = strip || (revealState[zone] && pointInRects(x, y, cachedRects[zone]));
        if (strip && !revealState[zone]) {
          // 驻留：进入条带起一次定时，条带内移动不重置。
          if (!dwellTimers[zone]) {
            dwellTimers[zone] = window.setTimeout(() => {
              dwellTimers[zone] = 0;
              reveal(zone);
            }, DWELL_MS);
          }
        } else if (!strip) {
          clearTimer(dwellTimers, zone);
        }
        if (zonePinned) {
          clearTimer(hideTimers, zone);
        } else if (pinned[zone] && revealState[zone]) {
          scheduleHide(zone); // 钉住→未钉住：起一次隐藏定时（此后移动不重置）。
        } else if (revealState[zone] && !hideTimers[zone]) {
          scheduleHide(zone); // 已揭示但从未钉住（如 Ctrl+F 程序化唤出）：兜底起隐藏定时。
        } else if (!revealState[zone]) {
          clearTimer(hideTimers, zone);
        }
        pinned[zone] = zonePinned;
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      lastMouse = { x: event.clientX, y: event.clientY };
      evaluate(event.clientX, event.clientY);
    };

    const onMouseLeave = () => {
      // 鼠标离开窗口：清全部驻留定时；已揭示区按未钉住起隐藏定时。
      for (const zone of ZONES) {
        clearTimer(dwellTimers, zone);
        pinned[zone] = false;
        if (useUiStore.getState().immersiveReveal[zone]) scheduleHide(zone);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    document.documentElement.addEventListener("mouseleave", onMouseLeave);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      document.documentElement.removeEventListener("mouseleave", onMouseLeave);
      for (const zone of ZONES) {
        clearTimer(dwellTimers, zone);
        clearTimer(hideTimers, zone);
        clearTimer(settleTimers, zone);
      }
    };
  }, [active]);
}
