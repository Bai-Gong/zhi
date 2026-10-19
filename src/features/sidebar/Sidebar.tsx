import { useEffect } from "react";
import { Bookmark, LayoutGrid, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import clsx from "clsx";
import { IconButton } from "../../components/IconButton";
import { useUiStore, type SidebarTab } from "../../shell/uiStore";
import { useDocumentStore } from "../../core/document/store";
import { ThumbnailsPanel } from "./ThumbnailsPanel";
import { BookmarksPanel } from "./BookmarksPanel";
import "./sidebar.css";

const TABS: Array<{ id: SidebarTab; label: string; icon: typeof LayoutGrid }> = [
  { id: "thumbnails", label: "缩略图", icon: LayoutGrid },
  { id: "bookmarks", label: "书签", icon: Bookmark },
];

/**
 * 左侧导航侧栏（模块 4）：缩略图/书签两页签，可折叠。
 * 与 viewer 互不依赖，只消费 core 的 store 与接口（技术方案 4.3 规则 2）。
 * 无书签的文档禁用书签页签（里程碑 M1-8）；书签失效时自动切回缩略图。
 */
export function Sidebar() {
  const sidebarTab = useUiStore((s) => s.sidebarTab);
  const setSidebarTab = useUiStore((s) => s.setSidebarTab);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  const status = useDocumentStore((s) => s.status);
  const outline = useDocumentStore((s) => s.outline);
  const bookmarksUnavailable = status === "ready" && outline.length === 0;

  // 书签页签不可用（当前文档无书签）时自动切回缩略图。
  useEffect(() => {
    if (bookmarksUnavailable && sidebarTab === "bookmarks") {
      setSidebarTab("thumbnails");
    }
  }, [bookmarksUnavailable, sidebarTab, setSidebarTab]);

  if (sidebarCollapsed) {
    return (
      <nav className="sidebar collapsed" aria-label="侧栏（已折叠）">
        <IconButton icon={PanelLeftOpen} label="展开侧栏" onClick={toggleSidebar} />
      </nav>
    );
  }

  return (
    <nav className="sidebar" aria-label="侧栏">
      <div className="sidebar-header">
        <div className="sidebar-tabs" role="tablist" aria-label="侧栏页签">
          {TABS.map((tab) => {
            const disabled = tab.id === "bookmarks" && bookmarksUnavailable;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={sidebarTab === tab.id}
                className={clsx("sidebar-tab", { active: sidebarTab === tab.id })}
                disabled={disabled}
                title={disabled ? "本文档没有书签" : undefined}
                onClick={() => setSidebarTab(tab.id)}
              >
                <tab.icon size={14} aria-hidden />
                {tab.label}
              </button>
            );
          })}
        </div>
        <IconButton icon={PanelLeftClose} label="折叠侧栏" onClick={toggleSidebar} />
      </div>
      <div className="sidebar-content">
        {sidebarTab === "thumbnails" ? <ThumbnailsPanel /> : <BookmarksPanel />}
      </div>
    </nav>
  );
}
