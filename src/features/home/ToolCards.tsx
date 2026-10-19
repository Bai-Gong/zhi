import type { ComponentType } from "react";
import {
  BookOpen,
  FileOutput,
  Files,
  Highlighter,
  LayoutGrid,
  Pencil,
  Save,
} from "lucide-react";
import type { IconComponentProps } from "../../components/IconButton";

interface ToolCardsProps {
  /** 启动阅读工具：弹出文件选择框并进入查看器。 */
  onOpenReader: () => void;
}

interface ToolCard {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<IconComponentProps>;
  /** 上线状态：MVP 仅「阅读查看」可用，其余置灰（技术方案 4.1 模块 2）。 */
  available: boolean;
}

/** 功能入口（对齐产品分析的必备核心能力清单，独立工具向导页后续里程碑上线）。 */
const TOOLS: ToolCard[] = [
  {
    id: "reader",
    title: "阅读查看",
    description: "连续滚动阅读、缩放、翻页与书签导航",
    icon: BookOpen,
    available: true,
  },
  {
    id: "merge-split",
    title: "合并拆分",
    description: "多个 PDF 合并成册，或拆分导出页面",
    icon: Files,
    available: false,
  },
  {
    id: "organize",
    title: "页面组织",
    description: "旋转、删除、重排与提取页面",
    icon: LayoutGrid,
    available: false,
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
    available: false,
  },
  {
    id: "convert",
    title: "格式转换",
    description: "PDF 与 Word、图片互转",
    icon: FileOutput,
    available: false,
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
export function ToolCards({ onOpenReader }: ToolCardsProps) {
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
          return tool.available ? (
            <button key={tool.id} type="button" className="tool-card" onClick={onOpenReader}>
              {body}
            </button>
          ) : (
            <div key={tool.id} className="tool-card unavailable" aria-disabled="true">
              {body}
              <span className="tool-badge">未上线</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
