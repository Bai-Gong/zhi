import { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { exists } from "@tauri-apps/plugin-fs";
import {
  loadRecentFiles,
  removeRecentFile,
  type RecentFile,
} from "../../core/document/recentFiles";
import { IconButton } from "../../components/IconButton";
import { formatOpenedAt } from "./formatOpenedAt";

/** 单条最近文件的存在性检测结果。 */
type Existence = "ok" | "missing" | "unknown";

interface RecentFileListProps {
  /** 一键重开：跳 /viewer?path=…，由 core 的 openDocument 装载并刷新打开时间（去重置顶）。 */
  onOpen: (path: string) => void;
}

/**
 * 最近文件列表（模块 2，技术方案 4.1）：只读展示 + 失效态 + 一键重开/移除入口。
 * 持久化（localStorage 键 zhi.recentFiles，去重置顶、上限 20）归 core/document
 * 唯一实现，本组件只消费其读写接口；路由切换回首页时组件重挂载、列表重新读取。
 */
export function RecentFileList({ onOpen }: RecentFileListProps) {
  const [files, setFiles] = useState<RecentFile[]>(() => loadRecentFiles());
  const [existence, setExistence] = useState<Record<string, Existence>>({});
  const resultsRef = useRef<Record<string, Existence>>({});
  const mountedRef = useRef(true);

  // StrictMode 双挂载兼容：每次挂载置 true、卸载置 false。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 失效态检测（技术方案模块 2「失效态」）：逐条探测本地文件是否存在。
  // 文件被移动/删除 → missing（置灰、禁用重开，保留移除入口）；
  // 权限不足或非 Tauri 环境下 exists 会 reject → 按 unknown 展示（不置灰）。
  useEffect(() => {
    for (const file of files) {
      if (resultsRef.current[file.path]) continue; // 已探测过的路径不重复探测
      exists(file.path).then(
        (ok) => {
          if (!mountedRef.current) return;
          resultsRef.current[file.path] = ok ? "ok" : "missing";
          setExistence({ ...resultsRef.current });
        },
        () => {
          if (!mountedRef.current) return;
          resultsRef.current[file.path] = "unknown";
          setExistence({ ...resultsRef.current });
        },
      );
    }
  }, [files]);

  const handleRemove = (path: string) => {
    setFiles(removeRecentFile(path));
  };

  return (
    <section className="home-section" aria-label="最近文件">
      <h2 className="home-section-title">最近文件</h2>
      {files.length === 0 ? (
        <p className="home-empty">还没有打开过的文件——点上方「打开 PDF 文件」开始。</p>
      ) : (
        <ul className="recent-list">
          {files.map((file) => {
            const missing = existence[file.path] === "missing";
            const meta = missing
              ? "文件已不存在"
              : `${
                  typeof file.numPages === "number" && file.numPages > 0 ? `${file.numPages} 页 · ` : ""
                }${formatOpenedAt(file.openedAt)}`;
            return (
              <li key={file.path} className={`recent-item${missing ? " stale" : ""}`}>
                <button
                  type="button"
                  className="recent-open"
                  title={
                    missing ? `文件已不存在：${file.path}` : `重新打开 ${file.fileName}\n${file.path}`
                  }
                  onClick={() => onOpen(file.path)}
                  disabled={missing}
                >
                  <FileText size={16} className="recent-icon" aria-hidden />
                  <span className="recent-name">{file.fileName}</span>
                  <span className="recent-pages">{meta}</span>
                </button>
                <IconButton icon={X} label="从最近文件移除" onClick={() => handleRemove(file.path)} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
