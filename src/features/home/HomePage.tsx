import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, FilePlus2, Files, Scissors, LayoutGrid, ArrowRightLeft, House, Clock3, Search, ShieldCheck } from "lucide-react";
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
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState("workbench");
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
      <aside className="workspace-nav" aria-label="工作台导航">
        <div className="workspace-label">文档空间 <span>WORKSPACE</span></div>
        <button className={view === "workbench" ? "selected" : ""} onClick={() => setView("workbench")}><House size={18} />工作台</button>
        <button className={view === "recent" ? "selected" : ""} onClick={() => setView("recent")}><Clock3 size={18} />最近文档</button>
        <div className="workspace-label nav-tools-label">文档工具</div>
        {[{ id: "all", name: "全部工具", icon: LayoutGrid }, { id: "pages", name: "合并与整理", icon: Files }, { id: "convert", name: "格式转换", icon: ArrowRightLeft }].map(item => <button key={item.id} className={view === "tools" && category === item.id ? "selected" : ""} onClick={() => { setView("tools"); setCategory(item.id); setQuery(""); }}><item.icon size={18} />{item.name}</button>)}
        <div className="workspace-note"><ShieldCheck size={20} /><strong>文件留在你的设备</strong><span>本地处理，安心创作。</span></div>
      </aside>
      <div className="workspace-content">
        <div className="workspace-heading"><div><span className="eyebrow">BAIGONG / ZHI</span><h1>{view === "recent" ? "最近文档" : view === "tools" ? "你的文档工具箱" : "让文档，井井有条。"}</h1><p>阅读、整理、转换。把琐碎的文档工作，变得简单。</p></div><span className="workspace-edition">个人工作空间</span></div>
        {view === "workbench" && <section className="home-hero">
          <div className="hero-copy"><span className="eyebrow">从一份文档开始</span><h2>每一页，都有新可能。</h2><p>选择一个或多个 PDF 继续阅读，或选择下方工具开始处理。</p><button type="button" className="primary-button" onClick={() => void handleOpen()}><FilePlus2 size={18} />打开 PDF 文件<ArrowUpRight size={16} /></button></div>
          <div className="paper-art" aria-hidden="true"><div className="art-sheet back" /><div className="art-sheet front"><span>纸。</span><i /><i /><i /><div className="art-seal">百工</div></div><span className="art-caption">A LITTLE LESS PAPERWORK.</span></div>
        </section>}
        {openError && <p className="home-error" role="alert">打开文件出错：{openError}</p>}
        {view === "workbench" && <section className="quick-actions" aria-label="常用文档任务">
          {[{ title: "合并文档", desc: "多份文件，合为一本", icon: Files, action: () => openToolWizard("merge") }, { title: "拆分文档", desc: "按需拆分，轻松分发", icon: Scissors, action: () => openToolWizard("split") }, { title: "整理页面", desc: "排序、旋转、删除", icon: LayoutGrid, action: () => void handleOpenOrganize() }, { title: "转换格式", desc: "PDF、Word 与图片互转", icon: ArrowRightLeft, action: () => { setCategory("convert"); setView("tools"); } }].map(item => <button key={item.title} onClick={item.action}><item.icon size={22} /><span><strong>{item.title}</strong><small>{item.desc}</small></span><ArrowUpRight size={16} /></button>)}
        </section>}
      {view !== "tools" && lastSession && lastSession.tabs.length > 0 && (
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
        {view !== "tools" && <RecentFileList onOpen={openViewer} onOrganize={(path) => navigate(buildOrganizeUrl(path))} />}
        {view !== "recent" && <><div className="tool-section-heading"><div><h2>为每一步，找到合适的工具</h2><p>从整理到交付，一处完成。</p></div><label className="tool-search"><Search size={17} /><input aria-label="搜索工具" placeholder="搜索工具…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="清空搜索" onClick={() => setQuery("")}>×</button>}</label></div><div className="tool-filters" aria-label="工具分类">{[{ id: "all", name: "全部工具" }, { id: "pages", name: "合并与整理" }, { id: "convert", name: "格式转换" }, { id: "read", name: "阅读与编辑" }].map(item => <button key={item.id} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.name}</button>)}</div>
      <ToolCards category={category} query={query}
        onOpenReader={() => void handleOpen()}
        onOpenOrganize={() => void handleOpenOrganize()}
        onOpenEdit={() => void handleOpenEdit()}
        onOpenMerge={() => openToolWizard("merge")}
        onOpenSplit={() => openToolWizard("split")}
        onOpenToolWizard={openToolWizard}
      /></>}
      <footer className="workspace-footer"><span>百工·纸</span><span>专注内容，其他交给纸。</span></footer>
      </div>
    </div>
  );
}
