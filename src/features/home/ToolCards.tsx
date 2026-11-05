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
  category: string;
  query: string;
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
    description: "打开 PDF，阅读与查找内容",
    icon: BookOpen,
    available: true,
  },
  {
    id: "merge",
    title: "合并 PDF",
    description: "将多个 PDF 合并为一个文件",
    icon: Files,
    available: true,
  },
  {
    id: "split",
    title: "拆分 PDF",
    description: "按页码、书签或固定页数拆分",
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
    description: "将 PDF 页面导出为 PNG 或 JPG",
    icon: FileOutput,
    available: true,
    toolId: "pdf-to-images",
  },
  {
    id: "images-to-pdf",
    title: "图片转 PDF",
    description: "将多张图片合成为 PDF",
    icon: Images,
    available: true,
    toolId: "images-to-pdf",
  },
  {
    id: "pdf-to-word",
    title: "PDF 转 Word",
    description: "将文本型 PDF 转为 Word 文档",
    icon: FileText,
    available: true,
    toolId: "pdf-to-word",
  },
  {
    id: "word-to-pdf",
    title: "Word 转 PDF",
    description: "将 Word 文档（.docx）转为 PDF",
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
  category, query,
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
  const orderedTools = [...TOOLS].sort((a, b) => {
    const order = ["merge", "split", "organize", "pdf-to-word", "word-to-pdf", "pdf-to-images", "images-to-pdf", "reader", "edit"];
    return order.indexOf(a.id) - order.indexOf(b.id);
  });
  const filtered = orderedTools.filter(tool => tool.available &&
    (category === "all" || (category === "convert" ? !!tool.toolId : category === "pages" ? ["merge", "split", "organize"].includes(tool.id) : ["reader", "edit"].includes(tool.id))) &&
    `${tool.title} ${tool.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <section className="home-section" aria-label="功能入口">
      {filtered.length === 0 && <p className="home-empty">没有找到匹配的工具，请更换关键词或分类。</p>}
      <div className="tool-grid">
        {filtered.map((tool) => {
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
              <div key={tool.id} className="tool-card fang-glass-surface unavailable" aria-disabled="true">
                {body}
                <span className="tool-badge">未上线</span>
              </div>
            );
          }
          return (
            <button key={tool.id} type="button" className="tool-card fang-glass-surface" onClick={onClick}>
              {body}
            </button>
          );
        })}
      </div>
    </section>
  );
}
