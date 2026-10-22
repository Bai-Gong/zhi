import type { ComponentType } from "react";
import {
  BookOpen,
  FileDown,
  FileOutput,
  FileText,
  Highlighter,
  Images,
  LayoutGrid,
  Pencil,
  Save,
  Scissors,
  Files,
} from "lucide-react";
import type { IconComponentProps } from "../../components/IconButton";

interface ToolCardsProps {
  /** 启动阅读工具：弹出文件选择框并进入查看器。 */
  onOpenReader: () => void;
  /** 启动页面组织（M3）：弹出文件选择框并进入组织视图。 */
  onOpenOrganize: () => void;
  /** 启动内容编辑（M5）：弹出文件选择框并进入编辑视图。 */
  onOpenEdit: () => void;
  /** 进入「合并 PDF」向导（M4）：文件选择在向导第一步完成。 */
  onOpenMerge: () => void;
  /** 进入「拆分 PDF」向导（M4）：文件选择在向导第一步完成。 */
  onOpenSplit: () => void;
  /** 进入格式转换向导（M6）：按注册表工具 id 直进向导（文件选择在向导内完成）。 */
  onOpenToolWizard: (toolId: string) => void;
}

interface ToolCard {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<IconComponentProps>;
  /** 上线状态：未上线工具置灰（技术方案 4.1 模块 2）。 */
  available: boolean;
  /** 向导工具 id（M4/M6 的向导类卡片）：点击直进 /tools/:toolId。 */
  toolId?: string;
}

/** 功能入口（对齐产品分析的必备核心能力清单；M4 合并/拆分与 M6 格式转换以工具向导上线）。 */
const TOOLS: ToolCard[] = [
  {
    id: "reader",
    title: "阅读查看",
    description: "连续滚动阅读、缩放、翻页与书签导航",
    icon: BookOpen,
    available: true,
  },
  {
    id: "merge",
    title: "合并 PDF",
    description: "多个 PDF 按顺序合并成册，可按页码范围选取",
    icon: Files,
    available: true,
  },
  {
    id: "split",
    title: "拆分 PDF",
    description: "按每 N 页、顶级书签或页码范围拆分导出",
    icon: Scissors,
    available: true,
  },
  {
    id: "organize",
    title: "页面组织",
    description: "旋转、删除、重排与提取页面",
    icon: LayoutGrid,
    available: true,
  },
  {
    id: "annotate",
    title: "批注高亮",
    description: "高亮文本并添加批注，另存副本",
    icon: Highlighter,
    available: false,
  },
  {
    id: "edit",
    title: "内容编辑",
    description: "编辑 PDF 中的文本与图片",
    icon: Pencil,
    available: true,
  },
  {
    id: "pdf-to-images",
    title: "PDF 转图片",
    description: "逐页导出 PNG/JPG（96/192 dpi），文件名带页码",
    icon: FileOutput,
    available: true,
    toolId: "pdf-to-images",
  },
  {
    id: "images-to-pdf",
    title: "图片转 PDF",
    description: "多张图片按顺序合成 PDF，可设页面与边距",
    icon: Images,
    available: true,
    toolId: "images-to-pdf",
  },
  {
    id: "pdf-to-word",
    title: "PDF 转 Word",
    description: "文本型 PDF 转 .docx，按阅读顺序重建段落",
    icon: FileText,
    available: true,
    toolId: "pdf-to-word",
  },
  {
    id: "word-to-pdf",
    title: "Word 转 PDF",
    description: ".docx 转 PDF，无需配置：按文档自身页面设置",
    icon: FileDown,
    available: true,
    toolId: "word-to-pdf",
  },
  {
    id: "export",
    title: "导出另存",
    description: "另存副本与添加水印",
    icon: Save,
    available: false,
  },
];

/** 功能入口卡片：可用工具可点击进入，未上线工具置灰并标「未上线」。 */
export function ToolCards({
  onOpenReader,
  onOpenOrganize,
  onOpenEdit,
  onOpenMerge,
  onOpenSplit,
  onOpenToolWizard,
}: ToolCardsProps) {
  /** 可用工具各自的进入方式：阅读查看、页面组织与内容编辑从「选文件」开始；向导工具直进向导。 */
  const entryOf = (tool: ToolCard): (() => void) | null => {
    if (tool.id === "organize") return onOpenOrganize;
    if (tool.id === "edit") return onOpenEdit;
    if (tool.id === "merge") return onOpenMerge;
    if (tool.id === "split") return onOpenSplit;
    if (tool.id === "reader") return onOpenReader;
    if (tool.toolId) return () => onOpenToolWizard(tool.toolId as string);
    return null;
  };
  return (
    <section className="home-section" aria-label="功能入口">
      <h2 className="home-section-title">工具箱</h2>
      <div className="tool-grid">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const body = (
            <>
              <span className="tool-card-icon">
                <Icon size={20} aria-hidden />
              </span>
              <span className="tool-card-title">{tool.title}</span>
              <span className="tool-card-desc">{tool.description}</span>
            </>
          );
          const onClick = entryOf(tool);
          if (!tool.available || !onClick) {
            return (
              <div key={tool.id} className="tool-card unavailable" aria-disabled="true">
                {body}
                <span className="tool-badge">未上线</span>
              </div>
            );
          }
          return (
            <button key={tool.id} type="button" className="tool-card" onClick={onClick}>
              {body}
            </button>
          );
        })}
      </div>
    </section>
  );
}
