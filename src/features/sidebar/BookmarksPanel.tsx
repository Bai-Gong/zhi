import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useDocumentStore, activeTabOf, type OutlineNode } from "../../core/document/store";

/**
 * 书签页签（技术方案模块 4 / 里程碑 M1-8）。
 * 数据来自激活标签的 outline（core 装载时已把 pdf.js 目标解析为页码，本模块免接触 pdfjs 类型）：
 * - 多级树可折叠展开（顶层默认展开，更深层默认折叠）；
 * - 点击节点按 pageNumber 定位跳页（写 store.currentPage，由查看器订阅滚动）；
 * - 外链型节点（有 url、无可解析页码）带外链图标，点击经 opener 插件交给系统
 *   默认浏览器打开（capabilities 的 opener:default 已含 http/https/mailto/tel）；
 * - 无有效目标的节点置灰仅展示。
 */

/** 打开书签外链；失败（含超出 opener 授权的协议）只记日志不打断侧栏。 */
async function openExternal(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (error) {
    console.warn("打开书签外链失败：", url, error);
  }
}

/** 顶层带子节点的默认展开，更深层默认折叠。 */
function defaultExpanded(nodes: readonly OutlineNode[]): ReadonlySet<string> {
  const keys = new Set<string>();
  nodes.forEach((node, index) => {
    if (node.children.length > 0) keys.add(String(index));
  });
  return keys;
}

export function BookmarksPanel() {
  // 书签只看激活标签（多标签 store；换标签由 Sidebar 以 key 重挂载本面板）。
  const tab = useDocumentStore(activeTabOf);
  const status = tab.status;
  const outline = tab.outline;
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => defaultExpanded(outline));

  // 文档切换（outline 随装载重置）后重置展开态。
  useEffect(() => {
    setExpanded(defaultExpanded(outline));
  }, [outline]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const jump = useCallback(
    (node: OutlineNode) => {
      if (node.pageNumber != null) setCurrentPage(node.pageNumber);
    },
    [setCurrentPage],
  );

  if (status === "idle") {
    return <p className="sidebar-empty">打开文档后可在此查看书签。</p>;
  }
  if (status === "loading") {
    return <p className="sidebar-hint">正在读取书签…</p>;
  }
  if (status === "error") {
    return <p className="sidebar-empty">书签读取失败，请重新打开文档。</p>;
  }
  if (outline.length === 0) {
    return <p className="sidebar-empty">本文档没有书签。</p>;
  }

  return (
    <div className="bookmarks-panel" role="tree" aria-label="书签树">
      {outline.map((node, index) => (
        <BookmarkItem
          key={`${index}`}
          node={node}
          keyPath={String(index)}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          onJump={jump}
        />
      ))}
    </div>
  );
}

interface BookmarkItemProps {
  node: OutlineNode;
  /** 稳定 key 路径（层内序号拼接），文档内唯一。 */
  keyPath: string;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onJump: (node: OutlineNode) => void;
}

function BookmarkItem({ node, keyPath, depth, expanded, onToggle, onJump }: BookmarkItemProps) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(keyPath);
  const jumpable = node.pageNumber != null;
  /** 外链型：目标解析不出页码但携带 URL——交给系统默认浏览器。 */
  const external = !jumpable && node.url != null;

  return (
    <div className="bookmark-node" role="none">
      <div
        className="bookmark-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        role="treeitem"
        aria-expanded={hasChildren ? isOpen : undefined}
      >
        {hasChildren ? (
          <button
            type="button"
            className="bookmark-chevron"
            title={isOpen ? "折叠" : "展开"}
            aria-label={isOpen ? `折叠「${node.title}」` : `展开「${node.title}」`}
            onClick={() => onToggle(keyPath)}
          >
            {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </button>
        ) : (
          <span className="bookmark-dot" aria-hidden />
        )}
        {jumpable ? (
          <button
            type="button"
            className={clsx("bookmark-title", { "is-link": node.url != null })}
            title={node.url ?? node.title}
            onClick={() => onJump(node)}
          >
            {node.url != null && <ExternalLink size={12} aria-hidden className="bookmark-link-icon" />}
            <span className="bookmark-title-text">{node.title}</span>
          </button>
        ) : external ? (
          <button
            type="button"
            className="bookmark-title is-link"
            title={node.url ?? undefined}
            onClick={() => void openExternal(node.url ?? "")}
          >
            <ExternalLink size={12} aria-hidden className="bookmark-link-icon" />
            <span className="bookmark-title-text">{node.title}</span>
          </button>
        ) : (
          <span className="bookmark-title is-muted" title={node.title}>
            <span className="bookmark-title-text">{node.title}</span>
          </span>
        )}
      </div>
      {hasChildren && isOpen && (
        <div role="group">
          {node.children.map((child, index) => (
            <BookmarkItem
              key={`${keyPath}/${index}`}
              node={child}
              keyPath={`${keyPath}/${index}`}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onJump={onJump}
            />
          ))}
        </div>
      )}
    </div>
  );
}
