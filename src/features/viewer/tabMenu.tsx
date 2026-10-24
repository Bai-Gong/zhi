// 标签浮动菜单（多标签增强 T4/T6）：右键标签菜单（关闭/关闭其他/关闭右侧/关闭全部）
// 与标签溢出下拉清单共用的浮动菜单原语 + 两个菜单组件。
//
// 边界与口径：
// - 关闭动作一律走 shell/hotkeys 的 closeTabAndSyncRoute / closeTabsAndSyncRoute
//   → core 的 closeDocument（取消渲染、终止装载、销毁 pdf.js 文档与专属 worker），
//   与 X 按钮 / Ctrl+W / 工具栏「关闭文档」同一实现，杜绝多份口径漂移；
// - 「关闭其他/关闭右侧」先 activateTab 到右键目标再关其余（closeTab 只在关激活
//   标签时移交激活位，先激活可让批量过程激活位稳定在幸存者上）；
// - 浮层定位用 fixed + 视口夹取；Esc / 点击外部关闭；role=menu + 方向键可达
//   （ArrowUp/Down 循环、Home/End 首末）；
// - 本组件零 pdfjs 依赖，只消费 core store 与 shell 的关闭入口。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useDocumentStore, type TabSession } from "../../core/document";
import { closeTabAndSyncRoute, closeTabsAndSyncRoute } from "../../shell/hotkeys";
import "./tabStrip.css";

/** 浮动菜单锚点（屏幕坐标，clientX/clientY 或按钮左下角）。 */
export interface FloatingMenuAnchor {
  x: number;
  y: number;
}

interface FloatingMenuProps {
  ariaLabel: string;
  anchor: FloatingMenuAnchor;
  onClose: () => void;
  children: ReactNode;
}

/** 视口边缘回拉的余量（菜单不被窗口裁掉）。 */
const MENU_VIEWPORT_MARGIN = 8;
/** 浮层层级：高于查看器内容、低于工具栏模态弹层（1000）。 */
const MENU_Z_INDEX = 800;

/**
 * 浮动菜单原语：fixed 定位（渲染后按自身尺寸夹取进视口）、Esc / 点击外部关闭、
 * role=menu 键盘可达。条目约定为 `role="menuitem"` 的可聚焦元素（tabIndex=-1），
 * 打开时聚焦第一个条目，方向键在其间循环——WAI-ARIA menu 模式的轻量实现。
 * 右键菜单与溢出清单共用（样式 .tab-menu*，见 tabStrip.css）。
 */
export function FloatingMenu({ ariaLabel, anchor, onClose, children }: FloatingMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 初值用锚点坐标；菜单每次打开都是新挂载实例，无需响应锚点变化，
  // 只在首次布局时按实际尺寸夹取（useLayoutEffect 在提交前校正，无跳动）。
  const [pos, setPos] = useState(anchor);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(MENU_VIEWPORT_MARGIN, Math.min(anchor.x, window.innerWidth - rect.width - MENU_VIEWPORT_MARGIN));
    const y = Math.max(MENU_VIEWPORT_MARGIN, Math.min(anchor.y, window.innerHeight - rect.height - MENU_VIEWPORT_MARGIN));
    setPos({ x, y });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const el = rootRef.current;
    // 打开即聚焦第一个条目：键盘用户立即可 Enter/方向键操作。
    el?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    // 点击外部关闭：capture 阶段抢在其它交互处理之前；菜单自身的点击不算外部。
    const onPointerDown = (event: PointerEvent) => {
      if (el && !el.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  const menuItems = (): HTMLElement[] =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={ariaLabel}
      className="tab-menu"
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: MENU_Z_INDEX }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
        const items = menuItems();
        if (items.length === 0) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLElement);
        let next: number;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else next = event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
      }}
    >
      {children}
    </div>
  );
}

interface TabContextMenuProps {
  /** 右键的目标标签 id。 */
  tabId: string;
  anchor: FloatingMenuAnchor;
  onClose: () => void;
}

/** 菜单条目按钮（WAI-ARIA menuitem；由 FloatingMenu 统一做键盘导航）。 */
function MenuButton({ disabled, children, onClick }: { disabled?: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="tab-menu-item" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * 标签右键菜单：关闭 / 关闭其他 / 关闭右侧 / 关闭全部。
 * 批量关闭统一走 closeTabsAndSyncRoute（结束后按幸存激活标签状态同步路由，
 * 防止 ViewerPage 装载效应按残留 ?path 复活已关文件或自动重试失败标签）。
 */
export function TabContextMenu({ tabId, anchor, onClose }: TabContextMenuProps) {
  const navigate = useNavigate();
  const tabs = useDocumentStore((s) => s.tabs);
  const activateTab = useDocumentStore((s) => s.activateTab);
  const index = tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return null; // 目标标签已被关掉：菜单不渲染（外层随即卸载）

  const closeOthers = () => {
    activateTab(tabId); // 幸存者先上位，批量过程激活位稳定
    closeTabsAndSyncRoute(
      tabs.filter((t) => t.id !== tabId).map((t) => t.id),
      navigate,
    );
    onClose();
  };
  const closeRight = () => {
    activateTab(tabId);
    closeTabsAndSyncRoute(
      tabs.slice(index + 1).map((t) => t.id),
      navigate,
    );
    onClose();
  };
  const closeAll = () => {
    closeTabsAndSyncRoute(
      tabs.map((t) => t.id),
      navigate,
    );
    onClose();
  };

  return (
    <FloatingMenu ariaLabel="标签操作菜单" anchor={anchor} onClose={onClose}>
      <MenuButton onClick={() => { closeTabAndSyncRoute(tabId, navigate); onClose(); }}>关闭</MenuButton>
      <MenuButton disabled={tabs.length <= 1} onClick={closeOthers}>关闭其他</MenuButton>
      <MenuButton disabled={tabs.length <= 1 || index >= tabs.length - 1} onClick={closeRight}>关闭右侧</MenuButton>
      <MenuButton disabled={tabs.length <= 1} onClick={closeAll}>关闭全部</MenuButton>
    </FloatingMenu>
  );
}

interface TabOverflowMenuProps {
  /** 锚点：对象直给，或惰性函数（挂载瞬间读取触发按钮位置）。 */
  anchor: FloatingMenuAnchor | (() => FloatingMenuAnchor);
  onClose: () => void;
  /** 点击某标签：由 TabStrip 执行 scrollIntoView（含已激活标签）+ activateTab。 */
  onPick: (tabId: string) => void;
}

/** 标签装载状态的清单后缀文案。 */
function statusLabelOf(tab: TabSession): string {
  if (tab.status === "ready") return `${tab.numPages} 页`;
  if (tab.status === "loading") return "正在装载…";
  if (tab.status === "error") return "打开失败";
  return "等待装载";
}

/**
 * 标签溢出下拉清单（T6）：标签条横向溢出时右端「∨」按钮弹出全部标签列表
 * （文件名 + 装载状态），点击切换并显式滚入视野——不依赖既有「激活滚入」效应
 * （它依赖 [activeTabId, tabs.length] 变化，点击已激活标签时两者均不变、不会滚）。
 */
export function TabOverflowMenu({ anchor, onClose, onPick }: TabOverflowMenuProps) {
  const tabs = useDocumentStore((s) => s.tabs);
  const activeTabId = useDocumentStore((s) => s.activeTabId);
  if (tabs.length === 0) return null;
  const resolvedAnchor = typeof anchor === "function" ? anchor() : anchor;
  return (
    <FloatingMenu ariaLabel="全部标签" anchor={resolvedAnchor} onClose={onClose}>
      {tabs.map((tab) => {
        const label = tab.fileName ?? (tab.status === "error" ? "打开失败" : "加载中…");
        return (
          <button
            key={tab.id}
            type="button"
            role="menuitem"
            className="tab-menu-item tab-overflow-item"
            aria-current={tab.id === activeTabId ? "true" : undefined}
            title={tab.sourcePath ?? label}
            onClick={() => {
              onPick(tab.id);
              onClose();
            }}
          >
            <span className="tab-overflow-name">{label}</span>
            <span className="tab-overflow-status">{statusLabelOf(tab)}</span>
          </button>
        );
      })}
    </FloatingMenu>
  );
}
