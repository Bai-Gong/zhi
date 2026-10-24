// 文档标签条（M2-计划 D2 / T9，验收 M2-6）：渲染 core store 的 tabs 与 activeTabId。
// 边界与口径：
// - D2 约定标签条归 viewer 模块、渲染在查看器工具栏上方，shell 四区布局不动；
// - 点击切换走 store.activateTab（保留该标签独立的页码/缩放/高亮——每标签会话
//   自带这三样，滚动舞台按 activeTabId 重挂载即恢复到该标签的页码）；
// - 关闭一律走 shell/hotkeys 的 closeTabAndSyncRoute → core 的 closeDocument：
//   取消渲染、终止装载、销毁 pdf.js 文档与专属 worker（T9 的内存释放路径），
//   与 Ctrl+W / Ctrl+F4 / 工具栏「关闭文档」/ 中键点击同一实现，杜绝多份口径漂移；
// - 「+」新建标签 = 打开文件对话框选 PDF（openPickedPdf，同工具栏「打开」，
//   单选沿用既有语义、多选走批量打开器一次开多标签）；
// - 多标签增强（Acrobat 对齐批次）：
//   · 拖拽重排——左键 HTML5 DnD + store.moveTab 纯数据动作（中键无法发起拖拽，
//     HTML5 DnD 只认左键按住拖动）；重排不改 activeTabId 与各标签会话字段；
//   · 右键菜单（tabMenu.tsx：关闭/关闭其他/关闭右侧/关闭全部）；
//   · 中键点击关闭——mousedown 阻止 WebView2 中键自动滚动，auxclick 执行关闭；
//   · 溢出「∨」清单（tabMenu.tsx：全部标签列表，点击显式滚入视野）。
// - 本组件零 pdfjs 依赖，只消费 core 暴露的 store 与动作。
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { ChevronDown, Plus, X } from "lucide-react";
import { useDocumentStore, type TabSession } from "../../core/document";
import { closeTabAndSyncRoute, openPickedPdf } from "../../shell/hotkeys";
import { TabContextMenu, TabOverflowMenu, type FloatingMenuAnchor } from "./tabMenu";
import "./tabStrip.css";

/** 拖拽插入指示的形态：在目标条目前 / 最后一个条目后。 */
type DropEdge = "before" | "after";

/** 标签条：溢出横向滚动的标签列表 + 右端「∨」溢出清单与「+」新建按钮。 */
export function TabStrip() {
  const navigate = useNavigate();
  const tabs = useDocumentStore((s) => s.tabs);
  const activeTabId = useDocumentStore((s) => s.activeTabId);
  const activateTab = useDocumentStore((s) => s.activateTab);
  const moveTab = useDocumentStore((s) => s.moveTab);
  const itemsRef = useRef<HTMLDivElement | null>(null);
  const overflowBtnRef = useRef<HTMLButtonElement | null>(null);

  // ===== 拖拽重排：dragId=拖动中的标签；dropIndex=插入位（按原数组计，即
  // 「插到第 dropIndex 个条目之前」，末尾为 tabs.length）。 =====
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const endDrag = useCallback(() => {
    setDragId(null);
    setDropIndex(null);
  }, []);
  const commitDrop = useCallback(() => {
    // moveTab 的 targetIndex 按「先摘除该标签后的数组」计，插入位在来源右侧时减一。
    if (dragId && dropIndex !== null) {
      const from = tabs.findIndex((t) => t.id === dragId);
      if (from >= 0) moveTab(dragId, dropIndex > from ? dropIndex - 1 : dropIndex);
    }
    endDrag();
  }, [dragId, dropIndex, endDrag, moveTab, tabs]);

  // ===== 右键菜单与溢出清单（浮层互斥由条件渲染天然保证） =====
  const [contextMenu, setContextMenu] = useState<{ tabId: string; anchor: FloatingMenuAnchor } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  // 激活标签滚入视野：标签多到溢出时，切换/关闭后当前标签不被挤出可视区。
  // 溢出清单的「点击已激活标签」不经过这里——两者依赖均不变、效应不重跑，
  // 由清单点击处理显式 scrollIntoView（见 pickFromOverflow）。
  useEffect(() => {
    itemsRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  // ===== 溢出检测（T6）=====
  // ResizeObserver 只报告元素自身盒尺寸变化，不报告内容溢出量（scrollWidth）——
  // 标签增删、装载状态与文件名变化会改内容宽度但容器盒不变。因此容器尺寸走
  // RO + window resize，内容变化走 tabSignature（id:文件名:状态）双信号重算。
  const tabSignature = tabs.map((t) => `${t.id}:${t.fileName ?? ""}:${t.status}`).join("|");
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = itemsRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tabSignature]);
  // 标签减少到不再溢出时收起已打开的清单浮层。
  useEffect(() => {
    if (!overflow) setOverflowOpen(false);
  }, [overflow]);

  /** 「+」＝打开文件对话框：选中文件即新建标签并装载（单选/多选语义见 openPickedPdf）。 */
  const handleNew = useCallback(() => void openPickedPdf(navigate), [navigate]);

  /** 溢出清单点击任一标签：显式滚入视野（含已激活标签），再激活。 */
  const pickFromOverflow = useCallback(
    (tabId: string) => {
      itemsRef.current
        ?.querySelector(`[data-tab-id="${tabId}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      activateTab(tabId);
    },
    [activateTab],
  );

  return (
    <div className="tab-strip" role="tablist" aria-label="文档标签">
      <div
        className="tab-strip-items"
        ref={itemsRef}
        onDragOver={(event) => {
          // 容器级兜底：拖到条目之外的空白区视为插到末尾（条目处理器 stopPropagation）。
          if (!dragId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (dropIndex !== tabs.length) setDropIndex(tabs.length);
        }}
        onDrop={(event) => {
          if (!dragId) return;
          event.preventDefault();
          commitDrop();
        }}
      >
        {tabs.map((tab, index) => (
          <TabStripItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            dragging={dragId === tab.id}
            dropEdge={
              dragId && dropIndex !== null
                ? dropIndex === index
                  ? ("before" as DropEdge)
                  : dropIndex === index + 1 && index === tabs.length - 1
                    ? ("after" as DropEdge)
                    : null
                : null
            }
            onActivate={() => activateTab(tab.id)}
            onClose={() => closeTabAndSyncRoute(tab.id, navigate)}
            onOpenMenu={(anchor) => setContextMenu({ tabId: tab.id, anchor })}
            onDragStart={(event) => {
              // setData 是部分环境启动 DnD 的必要条件；move 语义抑制复制光标。
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", tab.id);
              setDragId(tab.id);
            }}
            onDragOver={(event) => {
              if (!dragId) return;
              event.preventDefault();
              event.stopPropagation(); // 别冒泡给容器级「插到末尾」兜底
              event.dataTransfer.dropEffect = "move";
              // 按指针相对目标条目中线计算插入位（前半＝插到它前面）。
              const rect = event.currentTarget.getBoundingClientRect();
              const insert = index + (event.clientX < rect.left + rect.width / 2 ? 0 : 1);
              if (insert !== dropIndex) setDropIndex(insert);
            }}
            onDrop={(event) => {
              if (!dragId) return;
              event.preventDefault();
              event.stopPropagation();
              commitDrop();
            }}
            onDragEnd={endDrag}
          />
        ))}
      </div>
      {overflow && (
        <button
          type="button"
          ref={overflowBtnRef}
          className="tab-strip-overflow"
          title="显示全部标签"
          aria-label="显示全部标签"
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          onClick={() => setOverflowOpen(true)}
        >
          <ChevronDown size={14} aria-hidden />
        </button>
      )}
      <button
        type="button"
        className="tab-strip-new"
        title="新建标签（打开 PDF 文件）"
        aria-label="新建标签（打开 PDF 文件）"
        onClick={handleNew}
      >
        <Plus size={14} aria-hidden />
      </button>
      {contextMenu && (
        <TabContextMenu
          tabId={contextMenu.tabId}
          anchor={contextMenu.anchor}
          onClose={() => setContextMenu(null)}
        />
      )}
      {overflowOpen && (
        <TabOverflowMenu
          anchor={() => {
            const rect = overflowBtnRef.current?.getBoundingClientRect();
            return rect ? { x: rect.left, y: rect.bottom + 4 } : { x: window.innerWidth - 240, y: 48 };
          }}
          onClose={() => setOverflowOpen(false)}
          onPick={pickFromOverflow}
        />
      )}
    </div>
  );
}

interface TabStripItemProps {
  tab: TabSession;
  active: boolean;
  dragging: boolean;
  dropEdge: DropEdge | null;
  onActivate: () => void;
  onClose: () => void;
  onOpenMenu: (anchor: FloatingMenuAnchor) => void;
  onDragStart: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onDragEnd: () => void;
}

function TabStripItem({
  tab,
  active,
  dragging,
  dropEdge,
  onActivate,
  onClose,
  onOpenMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TabStripItemProps) {
  // 装载失败（failTab 复位会话）后 fileName 为空：给可读兜底，避免出现空标签。
  const label = tab.fileName ?? (tab.status === "error" ? "打开失败" : "加载中…");
  return (
    // 外层用 div 而非 button：内部还有关闭按钮，button 嵌 button 是非法 HTML。
    <div
      role="tab"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      data-tab-id={tab.id}
      data-drop={dropEdge ?? undefined}
      tabIndex={0}
      draggable // 左键拖拽重排；HTML5 DnD 不响应中键，中键无法发起拖拽
      className={clsx("tab-strip-item", active && "active", tab.status === "error" && "error", dragging && "dragging")}
      title={tab.sourcePath ?? label}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
      onMouseDown={(event) => {
        // 中键（button===1）必须在 mousedown 阶段阻止默认行为：Windows/WebView2 的
        // 中键自动滚动光标只有此阶段可阻——auxclick 的 preventDefault 只取消
        // 「中键打开链接」类动作、不覆盖 autoscroll（MDN Element: auxclick 口径）。
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        // 中键点击＝关闭该标签（与 X / Ctrl+W / Ctrl+F4 同一实现）；只认 button===1。
        if (event.button !== 1) return;
        event.stopPropagation();
        event.preventDefault();
        onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu({ x: event.clientX, y: event.clientY });
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <span className="tab-strip-label">{label}</span>
      <button
        type="button"
        className="tab-strip-close"
        aria-label={`关闭 ${label}`}
        title={`关闭 ${label}`}
        onClick={(event) => {
          event.stopPropagation(); // 关闭不触发标签激活
          onClose();
        }}
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}
