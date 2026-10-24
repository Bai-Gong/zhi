import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FilePlus2 } from "lucide-react";
import { openDocumentsBatch, pickPdfFile, pickPdfFiles, useDocumentStore } from "../../core/document";
import { loadLastSession, clearLastSession, type SessionSnapshot } from "../../core/document/sessionRestore";
import { syncViewerRouteToActiveTab } from "../../shell/hotkeys";
import { buildEditUrl, buildOrganizeUrl, buildToolWizardUrl, buildViewerUrl } from "../../shell/routes";
import { RecentFileList } from "./RecentFileList";
import { ToolCards } from "./ToolCards";
import "./home.css";

/** 从绝对路径取文件名（与 core/document/openDocument 同款切分，展示用）。 */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * 首页工具中心（模块 2，路由 /，技术方案 4.1）：
 * 打开文件入口 + 会话恢复卡片 + 最近文件列表（只读展示/失效态/移除）+ 功能入口卡片。
 * 打开流程（技术方案 5.1）：plugin-dialog 选文件 → 跳 /viewer?path=…，
 * 装载与写最近文件（去重置顶）由 core/document 的 openDocument 统一完成。
 * 多选增强：一次选中多个 PDF 时先进入查看器（不带 path）再走 core 的批量打开器，
 * 每文件一个标签、装载反馈在查看器内逐个可见；单选语义不变（navigate 带 path）。
 */
export function HomePage() {
  const navigate = useNavigate();
  const [openError, setOpenError] = useState<string | null>(null);
  // 上次会话快照（多标签增强 T7）：挂载时读一次；「忽略」或发起恢复后清空本地展示。
  const [lastSession, setLastSession] = useState<SessionSnapshot | null>(() => loadLastSession());
  const [restoring, setRestoring] = useState(false);

  const openViewer = useCallback(
    (path: string) => navigate(buildViewerUrl(path)),
    [navigate],
  );

  /** 打开文件入口：弹出 PDF 选择框；单选进入查看器（既有语义），多选走批量打开。 */
  const handleOpen = useCallback(async () => {
    setOpenError(null);
    try {
      const paths = await pickPdfFiles();
      if (!paths || paths.length === 0) return;
      if (paths.length === 1) {
        openViewer(paths[0]);
        return;
      }
      // 多选：先进入查看器（不带 path，ViewerPage 装载效应不触发），
      // 批量装载「标签逐个出现」的过程反馈在查看器内可见；结束后同步地址栏。
      navigate(buildViewerUrl());
      await openDocumentsBatch(paths);
      syncViewerRouteToActiveTab(navigate);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate, openViewer]);

  /** 一键恢复上次会话：按记录顺序批量重开，逐个回写页码/缩放，最后激活记录时的激活项。 */
  const handleRestore = useCallback(async () => {
    const session = lastSession;
    if (!session || restoring) return;
    setRestoring(true);
    navigate(buildViewerUrl());
    try {
      await openDocumentsBatch(
        session.tabs.map((t) => t.path),
        session.tabs.map((t) => ({ page: t.page, scale: t.scale })),
      );
      // 激活记录时的激活标签（失效文件是 error 标签，仍可激活展示错误与路径）。
      const target = session.activePath
        ? useDocumentStore.getState().tabs.find((t) => t.sourcePath === session.activePath)
        : undefined;
      if (target) useDocumentStore.getState().activateTab(target.id);
      syncViewerRouteToActiveTab(navigate);
    } finally {
      setRestoring(false);
      setLastSession(null); // 已发起恢复，卡片退场（记录由订阅按新标签集续写）
    }
  }, [lastSession, navigate, restoring]);

  /** 忽略：清除记录，刷新首页后不再出现恢复卡片。 */
  const handleIgnore = useCallback(() => {
    clearLastSession();
    setLastSession(null);
  }, []);

  /** 页面组织入口（M3）：选文件后进入组织视图（装载由组织页按 path 触发；单文档模式用单选）。 */
  const handleOpenOrganize = useCallback(async () => {
    setOpenError(null);
    try {
      const path = await pickPdfFile();
      if (path) navigate(buildOrganizeUrl(path));
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate]);

  /** 内容编辑入口（M5）：选文件后进入编辑视图（装载由编辑页按 path 触发；单文档模式用单选）。 */
  const handleOpenEdit = useCallback(async () => {
    setOpenError(null);
    try {
      const path = await pickPdfFile();
      if (path) navigate(buildEditUrl(path));
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate]);

  /** 合并/拆分向导入口（M4）：直进向导第一步选文件（向导自持文件列表）。 */
  const openToolWizard = useCallback(
    (toolId: string) => navigate(buildToolWizardUrl(toolId)),
    [navigate],
  );

  return (
    <div className="home-page">
      <section className="home-hero">
        <button type="button" className="primary-button" onClick={() => void handleOpen()}>
          <FilePlus2 size={18} aria-hidden />
          打开 PDF 文件
        </button>
        {openError && (
          <p className="home-error" role="alert">
            打开文件出错：{openError}
          </p>
        )}
        <p className="home-hint">选择本地 PDF 文件（可多选），在查看器中阅读、缩放与翻页。</p>
      </section>
      {lastSession && lastSession.tabs.length > 0 && (
        <section className="home-section" aria-label="恢复上次会话">
          <h2 className="home-section-title">上次会话</h2>
          <div className="session-restore-card">
            <div className="session-restore-info">
              <span className="session-restore-title">
                恢复上次会话（{lastSession.tabs.length} 个文档）
              </span>
              <span className="session-restore-meta" title={lastSession.tabs.map((t) => t.path).join("\n")}>
                {lastSession.tabs.map((t) => fileNameOf(t.path)).join("、")}
              </span>
            </div>
            <div className="session-restore-actions">
              <button
                type="button"
                className="primary-button"
                disabled={restoring}
                onClick={() => void handleRestore()}
              >
                {restoring ? "正在恢复…" : "恢复会话"}
              </button>
              <button
                type="button"
                className="session-restore-ignore"
                disabled={restoring}
                onClick={handleIgnore}
              >
                忽略
              </button>
            </div>
          </div>
        </section>
      )}
      <RecentFileList onOpen={openViewer} />
      <ToolCards
        onOpenReader={() => void handleOpen()}
        onOpenOrganize={() => void handleOpenOrganize()}
        onOpenEdit={() => void handleOpenEdit()}
        onOpenMerge={() => openToolWizard("merge")}
        onOpenSplit={() => openToolWizard("split")}
        onOpenToolWizard={openToolWizard}
      />
    </div>
  );
}
