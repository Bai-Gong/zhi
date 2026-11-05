// 全局快捷键体系（M2-计划 D7 / T8，验收 M2-5）。归 shell 统一注册：
// - **单一 keydown 入口**：应用级快捷键全部在本文件匹配分发，杜绝散落各组件的
//   监听互相踩踏。唯一例外是查看器滚动容器自带的键盘翻页监听（ViewerPage）——
//   它先于本入口执行且会 preventDefault，本入口以 event.defaultPrevented 让位；
// - 动作只做「改 store / 调 core 接口 / 请求导航」。react-router 的 navigate 只能
//   在组件内取得，由 AppShell 装配时注入（{@link HotkeyNavigator}），replace 语义
//   得以保留（关标签清 ?path 不能产生可后退重开的历史项）；
// - 组合键取舍（避开系统/浏览器保留）：Ctrl+O / Ctrl+F / Ctrl+W 是桌面阅读器通行
//   约定。Ctrl+W 在浏览器 dev 预览里属浏览器保留键（关页，页面拦不住），在
//   Tauri 产物（WebView2）内无冲突——M2 计划指定沿用。Ctrl+Tab / Ctrl+Shift+Tab /
//   Ctrl+F4（标签循环切换 / 关当前标签，Acrobat 官方快捷键表）与 Ctrl+W 同款处境，
//   同样仅应用窗口内生效。Ctrl+Shift+I（DevTools）、F11（系统全屏）、Ctrl+P（打印）
//   一概不用；**沉浸模式选 Ctrl+I**（I=Immersive）：浏览器与 WebView2 均未保留，
//   单修饰键易按，比 Alt+Enter / F11（被系统占用）安全；未匹配的 Ctrl 组合一律放行
//   （Ctrl+C/V/A/S 等用户习惯不劫持）；
// - 焦点在输入框（input/textarea/select/contenteditable）时不触发——与查看器滚动
//   容器键盘翻页同款判据，杜绝吞掉用户输入。
import { activeTabOf, closeDocument, openDocument, openDocumentsBatch, pickPdfFiles, useDocumentStore } from "../core/document";
import { buildViewerUrl } from "./routes";
import { useUiStore } from "./uiStore";
// 缩放档位/夹取是查看器域的唯一事实来源（pageGeometry，零依赖纯函数）。shell 反向
// import features 的纯函数不违反 4.3 边界（规则限制的是组件与 pdfjs/store），而
// 复制 1.1 / 0.25–4.0 魔数会让工具栏与快捷键步进漂移，危害更大。
import { clampScale, ZOOM_STEP } from "../features/viewer/pageGeometry";

/** 注入的导航器：即 react-router 的 navigate（AppShell 装配时提供）。 */
export type HotkeyNavigator = (to: string, options?: { replace?: boolean }) => void;

/** 快捷键说明清单条目（工具栏「快捷键说明」弹层直接消费，与实现同步维护）。 */
export interface HotkeyEntry {
  combo: string;
  label: string;
}

export const HOTKEY_LIST: readonly HotkeyEntry[] = [
  { combo: "Ctrl+O", label: "打开 PDF 文件（对话框可多选）" },
  { combo: "Ctrl+W / Ctrl+F4", label: "关闭当前标签" },
  { combo: "Ctrl+Tab", label: "切换到下一个标签（循环）" },
  { combo: "Ctrl+Shift+Tab", label: "切换到上一个标签（循环）" },
  { combo: "Ctrl+F", label: "全文搜索（打开/聚焦搜索面板）" },
  { combo: "Ctrl+= / Ctrl+-", label: "放大 / 缩小" },
  { combo: "Ctrl+0", label: "缩放复位 100%" },
  { combo: "Ctrl+滚轮", label: "跟随光标缩放（查看器既有交互）" },
  { combo: "PageUp / PageDown / 方向键", label: "上一页 / 下一页" },
  { combo: "Ctrl+I", label: "进入 / 退出沉浸模式" },
  { combo: "Esc", label: "退出沉浸模式（有未收起的选区时先收选区）" },
];

/**
 * 打开对话框选 PDF 并进入查看（工具栏「打开」、标签条「+」与 Ctrl+O 共用）。
 * **单选/多选语义分叉**：
 * - 单选完全沿用既有语义——同激活路径原地重开刷新会话，其余 navigate 带 path
 *   （M1/M2「同路径原地重开」约定不因批量器漂移）；
 * - 多选（≥2 个）走 core 的批量打开器 openDocumentsBatch：已开路径仅激活不重置，
 *   新路径串行开新标签。非查看器路由发起时先 navigate 进查看器（不带 path，
 *   ViewerPage 装载效应 `if (!path) return` 不触发），使「标签逐个出现」的
 *   装载反馈可见；结束后把地址栏同步到最终激活标签（见 syncViewerRouteToActiveTab），
 *   避免 URL 残留旧 ?path 导致刷新/后退重开旧文件。
 */
export async function openPickedPdf(navigate: HotkeyNavigator): Promise<void> {
  let paths: string[] | null;
  try {
    paths = await pickPdfFiles(); // 用户取消返回 null；对话框异常在这里吸收
  } catch (error) {
    console.warn("打开文件对话框调用失败：", error);
    return;
  }
  if (!paths || paths.length === 0) return;
  if (paths.length === 1) {
    const path = paths[0];
    if (path === activeTabOf(useDocumentStore.getState()).sourcePath) {
      void openDocument(path); // 同一路径不改变查询参数，直接重开刷新该标签会话
    } else {
      navigate(buildViewerUrl(path));
    }
    return;
  }
  if (!window.location.hash.startsWith("#/viewer")) navigate(buildViewerUrl());
  void openDocumentsBatch(paths).then(() => syncViewerRouteToActiveTab(navigate));
}

/**
 * 把查看器地址栏同步到当前激活标签（批量打开/批量关闭后调用）：
 * 幸存/最终激活标签为 ready 时 replace 到其 sourcePath，否则（error/loading 态）
 * replace 到不带 path 的 /viewer——ViewerPage 的装载效应只对 ready 态跳过，
 * 带 path 会自动重试失败文件或打断装载中标签；不带 path 时 `if (!path) return`
 * 不触发。replace 语义：不留可后退重开的历史项（与 closeTabAndSyncRoute 同款）。
 */
export function syncViewerRouteToActiveTab(navigate: HotkeyNavigator): void {
  if (!window.location.hash.startsWith("#/viewer")) return;
  const tab = activeTabOf(useDocumentStore.getState());
  const target = tab.status === "ready" && tab.sourcePath ? buildViewerUrl(tab.sourcePath) : buildViewerUrl();
  if (window.location.hash.slice(1) === target) return; // 已一致，不动路由
  navigate(target, { replace: true });
}

/**
 * 关闭一个标签并同步路由：关的是**激活**标签时清掉 ?path（replace，不留可后退
 * 重开的历史项；此后从首页重开同一文件仍能触发装载），非激活标签不动路由。
 * 销毁走 core 的 closeDocument（取消渲染、终止装载、销毁 pdf.js 文档与专属 worker）。
 */
export function closeTabAndSyncRoute(tabId: string, navigate: HotkeyNavigator): void {
  const isActive = useDocumentStore.getState().activeTabId === tabId;
  void closeDocument(tabId);
  if (isActive) navigate(buildViewerUrl(), { replace: true });
}

/**
 * 批量关闭（右键菜单「关闭其他/关闭右侧/关闭全部」）：串行 await closeDocument
 * （渲染取消/worker 回收链内建），全部落地后统一同步路由（syncViewerRouteToActiveTab
 * 的口径：幸存激活标签 ready 才带其 path，否则清 path——防止 ViewerPage 装载效应按
 * 残留 ?path 把刚关的文件重新装载、或对幸存 error/loading 标签自动重试）。
 * 调用方须先 activateTab 到要保留的标签（closeTab 只在关激活标签时移交激活位，
 * 先激活可让整个批量过程激活位稳定在幸存者上）。
 */
export function closeTabsAndSyncRoute(tabIds: readonly string[], navigate: HotkeyNavigator): void {
  if (tabIds.length === 0) return;
  void (async () => {
    for (const id of tabIds) {
      await closeDocument(id);
    }
    syncViewerRouteToActiveTab(navigate);
  })();
}

/** Ctrl+F：打开搜索面板（挂载即 autoFocus 聚焦输入框），已打开则聚焦并全选关键词。 */
function focusSearchPanel(): void {
  const ui = useUiStore.getState();
  if (!ui.searchPanelOpen) {
    ui.setSearchPanelOpen(true);
    return;
  }
  const input = document.querySelector<HTMLInputElement>(".search-input");
  if (input) {
    input.focus();
    input.select(); // 选中既有关键词，直接输入即替换
  }
}

/** 安装全局快捷键（单一 keydown 入口）；返回卸载函数（AppShell 卸载时调用）。 */
export function installHotkeys(navigate: HotkeyNavigator): () => void {
  // Esc 走捕获：必须抢在 PageCanvas 的 document 冒泡监听（收起选区/浮动条）之前
  // 判定，才能实现「先收选区、下一次 Esc 再退沉浸」的两段式；退出时 preventDefault，
  // 冒泡段的常规分发经 defaultPrevented 让位，同一键不双重处理。
  const onEscapeCapture = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey) return;
    const ui = useUiStore.getState();
    if (!ui.immersive) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return; // 选区未收：让 PageCanvas 先处理
    event.preventDefault();
    ui.setImmersive(false);
  };

  // 常规分发走冒泡：晚于查看器滚动容器的翻页监听执行，defaultPrevented 即让位。
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    // Native macOS menus own these accelerators; do not dispatch twice.
    if (document.documentElement.dataset.nativeMaterial === "macos" && event.metaKey &&
        ["o", "w"].includes(event.key.toLowerCase())) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest("input, textarea, select, [contenteditable='true']")) return;

    const ctrl = event.ctrlKey || event.metaKey;
    // Shift 组合一律不进本分支：Ctrl+Shift+I/O/W 等是浏览器/DevTools 保留组合
    // （文件头自述「一概不用」），混进来会与 i/o/w 撞同一 case 叠发；两个例外：
    // 主键盘「+」本身要按住 Shift（Shift+=，按物理键 code 放行缩放档位）、
    // Ctrl+Shift+Tab 切上一个标签（Acrobat 官方快捷键，例外严格限定
    // event.key==="Tab"，其余 Shift 组合维持一概排除）。
    const shiftForPlus = event.shiftKey && event.code === "Equal";
    const shiftForTab = event.shiftKey && event.key === "Tab";
    if (ctrl && !event.altKey && (!event.shiftKey || shiftForPlus || shiftForTab)) {
      const docStore = useDocumentStore.getState();
      const ui = useUiStore.getState();
      const session = activeTabOf(docStore);
      switch (event.key.toLowerCase()) {
        case "o":
          event.preventDefault();
          void openPickedPdf(navigate);
          return;
        case "w":
        case "f4": // Ctrl+F4 与 Ctrl+W 同义（Acrobat 官方快捷键表），同一实现
          if (!docStore.activeTabId) return;
          event.preventDefault();
          closeTabAndSyncRoute(docStore.activeTabId, navigate);
          return;
        case "tab": {
          // Ctrl+Tab / Ctrl+Shift+Tab 循环切换标签（±1 取模：最后一个再按回到第一个）。
          // 浏览器 dev 预览内是浏览器保留键（页面拦不住），仅应用窗口生效（同 Ctrl+W 口径）。
          event.preventDefault();
          const { tabs, activeTabId } = docStore;
          if (!activeTabId || tabs.length <= 1) return;
          const index = tabs.findIndex((t) => t.id === activeTabId);
          if (index < 0) return;
          const next = (index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
          useDocumentStore.getState().activateTab(tabs[next].id);
          return;
        }
        case "f":
          // 搜索面板挂在查看器路由内：不在查看器时不响应，避免「面板已开却看不见」。
          if (!window.location.hash.startsWith("#/viewer")) return;
          event.preventDefault();
          focusSearchPanel();
          return;
        case "i":
          event.preventDefault();
          ui.toggleImmersive();
          return;
        case "=":
        case "+": // 主键盘 Shift+= 与小键盘 NumpadAdd 的 key 均为 "+"/"="
          event.preventDefault();
          docStore.setScale(clampScale(session.scale * ZOOM_STEP));
          return;
        case "-":
          event.preventDefault();
          docStore.setScale(clampScale(session.scale / ZOOM_STEP));
          return;
        case "0":
          event.preventDefault();
          docStore.setScale(1);
          return;
        default:
          return; // 其余 Ctrl 组合放行（浏览器/系统保留：Ctrl+C/V/A/S/T/N…）
      }
    }

    if (ctrl || event.altKey || event.shiftKey) return;
    // 无修饰键：翻页（PageUp/PageDown/方向键，验收 M2-5）。
    let delta: number;
    switch (event.key) {
      case "PageDown":
      case "ArrowDown":
      case "ArrowRight":
        delta = 1;
        break;
      case "PageUp":
      case "ArrowUp":
      case "ArrowLeft":
        delta = -1;
        break;
      default:
        return;
    }
    const session = activeTabOf(useDocumentStore.getState());
    if (session.numPages <= 0) return;
    // preventDefault 阻止浏览器默认滚动（.shell-main 自身 overflow:auto，会被滚走）。
    event.preventDefault();
    useDocumentStore.getState().setCurrentPage(session.currentPage + delta);
  };

  window.addEventListener("keydown", onEscapeCapture, true);
  window.addEventListener("keydown", onKeyDown);
  return () => {
    window.removeEventListener("keydown", onEscapeCapture, true);
    window.removeEventListener("keydown", onKeyDown);
  };
}
