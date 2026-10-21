import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FilePlus2 } from "lucide-react";
import { pickPdfFile } from "../../core/document/openDocument";
import { buildOrganizeUrl, buildViewerUrl } from "../../shell/routes";
import { RecentFileList } from "./RecentFileList";
import { ToolCards } from "./ToolCards";
import "./home.css";

/**
 * 首页工具中心（模块 2，路由 /，技术方案 4.1）：
 * 打开文件入口 + 最近文件列表（只读展示/失效态/移除）+ 功能入口卡片（未上线置灰）。
 * 打开流程（技术方案 5.1）：plugin-dialog 选文件 → 跳 /viewer?path=…，
 * 装载与写最近文件（去重置顶）由 core/document 的 openDocument 统一完成。
 */
export function HomePage() {
  const navigate = useNavigate();
  const [openError, setOpenError] = useState<string | null>(null);

  const openViewer = useCallback(
    (path: string) => navigate(buildViewerUrl(path)),
    [navigate],
  );

  /** 打开文件入口：弹出 PDF 选择框，选中后进入查看器；取消返回 null 不跳转。 */
  const handleOpen = useCallback(async () => {
    setOpenError(null);
    try {
      const path = await pickPdfFile();
      if (path) openViewer(path);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  }, [openViewer]);

  /** 页面组织入口（M3）：选文件后进入组织视图（装载由组织页按 path 触发）。 */
  const handleOpenOrganize = useCallback(async () => {
    setOpenError(null);
    try {
      const path = await pickPdfFile();
      if (path) navigate(buildOrganizeUrl(path));
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  }, [navigate]);

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
        <p className="home-hint">选择本地 PDF 文件，在查看器中阅读、缩放与翻页。</p>
      </section>
      <RecentFileList onOpen={openViewer} />
      <ToolCards onOpenReader={() => void handleOpen()} onOpenOrganize={() => void handleOpenOrganize()} />
    </div>
  );
}
