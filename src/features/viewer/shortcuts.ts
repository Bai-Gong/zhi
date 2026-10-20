// 查看器快捷键体系（M2 阅读模式与快捷键，里程碑验收 5）：
// - 表驱动清单 + 单一 window keydown 分发器（仅查看器路由挂载），
//   动作一律 getState() 现取现用（无闭包过期）；
// - 修饰键精确匹配：每条 match 校验 ctrl/meta/alt/shift 与期待完全一致，
//   未匹配的组合不拦截——Alt+←→ 历史导航等系统行为放行；
// - 焦点排除：目标命中 input/textarea/contenteditable 时全部静默（含 Ctrl+F，
//   杜绝聚焦搜索框时重复触发打断输入；F11/Ctrl+Alt+I 输入态静默为有意设计，
//   退出路径见 shell 的 escapeFromEditable）；isComposing 忽略（中文 IME 组合期）；
// - 纯键翻页（方向键/PageUp/PageDown/Home/End）留在滚动容器监听（ViewerPage），
//   侧栏结果列表聚焦时方向键归列表导航，不被 window 级劫走；
// - F11/Ctrl+W 的 WebView2 加速键行为需 build 产物实测；如冲突单行改表换备选
//   （Ctrl+Alt+R / Ctrl+Alt+W），风险封闭在本文件。
import { useEffect } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import {
  closeDocument,
  openDocument,
  pickPdfFile,
  revealRelativeSearchResult,
  useDocumentStore,
} from "../../core/document";
import { buildViewerUrl } from "../../shell/routes";
import { useUiStore } from "../../shell/uiStore";
import { clampScale, ZOOM_STEP } from "./pageGeometry";
import { clearAutoFit } from "./scrollBridge";

/** 键盘事件的目标是否为可编辑元素（输入态快捷键静默的统一判据，ViewerPage 翻页监听共用）。 */
export function isEditableTarget(target: Element | null): boolean {
  return target !== null && target.closest("input, textarea, [contenteditable='true']") !== null;
}

/** 查看器内打开搜索面板（工具栏按钮与 Ctrl+F 同入口）：展开侧栏 → 切页签 → 请求聚焦。 */
export function openSearchPanel(): void {
  const ui = useUiStore.getState();
  if (ui.sidebarCollapsed) ui.toggleSidebar();
  ui.setSidebarTab("search");
  ui.requestSearchFocus();
  // 沉浸态：唤出左区（侧栏），搜索输入获焦点后即被 focus 钉住，不会自动收起。
  if (ui.immersiveMode) ui.setImmersiveReveal({ left: true });
}

interface ModifierExpectation {
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** 键名（忽略大小写）与修饰键集合均须与期待完全一致。 */
function withModifiers(event: KeyboardEvent, key: string, modifiers: ModifierExpectation): boolean {
  if (event.key.toLowerCase() !== key.toLowerCase()) return false;
  return (
    event.ctrlKey === (modifiers.ctrl ?? false) &&
    event.metaKey === (modifiers.meta ?? false) &&
    event.altKey === (modifiers.alt ?? false) &&
    event.shiftKey === (modifiers.shift ?? false)
  );
}

/** 手动缩放：退出「适应宽度」自动重适配（scrollBridge 的 autoFit 来源标志）。 */
function zoomTo(transform: (scale: number) => number): void {
  const store = useDocumentStore.getState();
  if (store.numPages <= 0) return;
  clearAutoFit();
  store.setScale(clampScale(transform(store.scale)));
}

interface ShortcutEntry {
  id: string;
  /** 动作说明（键位已含在内，与工具栏按钮 title 同源）。 */
  label: string;
  match: (event: KeyboardEvent) => boolean;
  run: (navigate: NavigateFunction) => void;
}

/** 快捷键清单（里程碑 M2 验收 5：打开/关闭/搜索/缩放/翻页/阅读模式）。 */
const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: "open",
    label: "打开 PDF 文件（Ctrl+O）",
    match: (e) => withModifiers(e, "o", { ctrl: true }),
    run: (navigate) => {
      void (async () => {
        let path: string | null;
        try {
          path = await pickPdfFile(); // 用户取消返回 null；对话框异常就地吸收
        } catch (error) {
          console.warn("打开文件对话框调用失败：", error);
          return;
        }
        if (!path) return;
        if (path === useDocumentStore.getState().sourcePath) {
          void openDocument(path); // 同一路径不改查询参数，直接重开刷新会话
        } else {
          navigate(buildViewerUrl(path));
        }
      })();
    },
  },
  {
    id: "close",
    label: "关闭文档（Ctrl+W）",
    match: (e) => withModifiers(e, "w", { ctrl: true }),
    run: (navigate) => {
      void closeDocument();
      navigate(buildViewerUrl(), { replace: true });
    },
  },
  {
    id: "search",
    label: "搜索全文（Ctrl+F）",
    match: (e) => withModifiers(e, "f", { ctrl: true }),
    run: () => openSearchPanel(),
  },
  {
    id: "next-hit",
    label: "下一个搜索结果（F3）",
    match: (e) => withModifiers(e, "F3", {}),
    run: () => revealRelativeSearchResult(1),
  },
  {
    id: "prev-hit",
    label: "上一个搜索结果（Shift+F3）",
    match: (e) => withModifiers(e, "F3", { shift: true }),
    run: () => revealRelativeSearchResult(-1),
  },
  {
    id: "zoom-in",
    label: "放大（Ctrl+=）",
    match: (e) => withModifiers(e, "=", { ctrl: true }) || withModifiers(e, "+", { ctrl: true, shift: true }),
    run: () => zoomTo((scale) => scale * ZOOM_STEP),
  },
  {
    id: "zoom-out",
    label: "缩小（Ctrl+-）",
    match: (e) => withModifiers(e, "-", { ctrl: true }),
    run: () => zoomTo((scale) => scale / ZOOM_STEP),
  },
  {
    id: "zoom-reset",
    label: "恢复 100% 缩放（Ctrl+0）",
    match: (e) => withModifiers(e, "0", { ctrl: true }),
    run: () => zoomTo(() => 1),
  },
  {
    id: "immersive",
    label: "切换阅读模式（F11）",
    match: (e) => withModifiers(e, "F11", {}),
    run: () => useUiStore.getState().toggleImmersive(),
  },
  {
    id: "invert-canvas",
    label: "深色阅读：反转文档底色（Ctrl+Alt+I）",
    match: (e) => withModifiers(e, "i", { ctrl: true, alt: true }),
    run: () => useUiStore.getState().toggleInvertCanvas(),
  },
  {
    id: "exit-immersive",
    label: "退出阅读模式（Esc）",
    match: (e) => withModifiers(e, "Escape", {}),
    run: () => {
      const ui = useUiStore.getState();
      if (ui.immersiveMode) ui.exitImmersive();
    },
  },
];

/** 挂载查看器路由即接管快捷键（window 级单一监听，卸载即归还）。 */
export function useViewerShortcuts(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return; // 中文 IME 组合期
      const target = event.target instanceof Element ? event.target : null;
      if (isEditableTarget(target)) return; // 输入态全静默（含 Ctrl+F）
      for (const shortcut of SHORTCUTS) {
        if (!shortcut.match(event)) continue;
        event.preventDefault();
        shortcut.run(navigate);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}
