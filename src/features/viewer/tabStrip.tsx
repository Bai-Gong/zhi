// 文档标签条（M2-计划 D2 / T9，验收 M2-6）：渲染 core store 的 tabs 与 activeTabId。
// 边界与口径：
// - D2 约定标签条归 viewer 模块、渲染在查看器工具栏上方，shell 四区布局不动；
// - 点击切换走 store.activateTab（保留该标签独立的页码/缩放/高亮——每标签会话
//   自带这三样，滚动舞台按 activeTabId 重挂载即恢复到该标签的页码）；
// - 关闭一律走 shell/hotkeys 的 closeTabAndSyncRoute → core 的 closeDocument：
//   取消渲染、终止装载、销毁 pdf.js 文档与专属 worker（T9 的内存释放路径），
//   与 Ctrl+W / 工具栏「关闭文档」同一实现，杜绝多份口径漂移；
// - 「+」新建标签 = 打开文件对话框选 PDF（openPickedPdf，同工具栏「打开」）；
// - 本组件零 pdfjs 依赖，只消费 core 暴露的 store 与动作。
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { useDocumentStore, type TabSession } from "../../core/document";
import { closeTabAndSyncRoute, openPickedPdf } from "../../shell/hotkeys";
import "./tabStrip.css";

/** 标签条：溢出横向滚动的标签列表 + 固定在右端的「+」新建按钮。 */
export function TabStrip() {
  const navigate = useNavigate();
  const tabs = useDocumentStore((s) => s.tabs);
  const activeTabId = useDocumentStore((s) => s.activeTabId);
  const activateTab = useDocumentStore((s) => s.activateTab);
  const itemsRef = useRef<HTMLDivElement | null>(null);

  // 激活标签滚入视野：标签多到溢出时，切换/关闭后当前标签不被挤出可视区。
  useEffect(() => {
    itemsRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  /** 「+」＝打开文件对话框：选中文件即新建标签并装载（M2-计划 D1 语义）。 */
  const handleNew = useCallback(() => void openPickedPdf(navigate), [navigate]);

  return (
    <div className="tab-strip" role="tablist" aria-label="文档标签">
      <div className="tab-strip-items" ref={itemsRef}>
        {tabs.map((tab) => (
          <TabStripItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onActivate={() => activateTab(tab.id)}
            onClose={() => closeTabAndSyncRoute(tab.id, navigate)}
          />
        ))}
      </div>
      <button
        type="button"
        className="tab-strip-new"
        title="新建标签（打开 PDF 文件）"
        aria-label="新建标签（打开 PDF 文件）"
        onClick={handleNew}
      >
        <Plus size={14} aria-hidden />
      </button>
    </div>
  );
}

interface TabStripItemProps {
  tab: TabSession;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}

function TabStripItem({ tab, active, onActivate, onClose }: TabStripItemProps) {
  // 装载失败（failTab 复位会话）后 fileName 为空：给可读兜底，避免出现空标签。
  const label = tab.fileName ?? (tab.status === "error" ? "打开失败" : "加载中…");
  return (
    // 外层用 div 而非 button：内部还有关闭按钮，button 嵌 button 是非法 HTML。
    <div
      role="tab"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      tabIndex={0}
      className={clsx("tab-strip-item", active && "active", tab.status === "error" && "error")}
      title={tab.sourcePath ?? label}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
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
