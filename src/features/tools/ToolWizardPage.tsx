import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { ROUTES } from "../../shell/routes";
import { ToolWizard } from "../../shell/wizard/ToolWizard";
import { findWizardTool } from "./registry";
import "./tools.css";
import { useDocumentStore } from "../../core/document/store";

/**
 * 工具向导路由页（M4，features/tools）：`/tools/:toolId` 按注册表解析工具并
 * 渲染框架组件（key 绑工具 id，切换工具即重建向导状态）。未注册 id 回首页。
 * 页面组装在路由层完成（技术方案 4.3 规则 2）。
 */
export function ToolWizardPage() {
  const { toolId } = useParams();
  const [searchParams] = useSearchParams();
  const tool = findWizardTool(toolId);
  const requestedPath = searchParams.get("path") ?? undefined;
  const officeTool = toolId === "word-to-pdf" || toolId === "spreadsheet-to-pdf" || toolId === "presentation-to-pdf";
  const extension = requestedPath?.split(".").pop()?.toLowerCase();
  const initialPath = officeTool && extension && tool?.files.filters?.some(filter => filter.extensions.includes(extension)) ? requestedPath : undefined;
  const previousOptions = useDocumentStore(state => state.tabs.find(tab => tab.sourcePath === initialPath)?.officeOptions);
  const initialConfig = toolId === "presentation-to-pdf"
    ? { includeHidden: previousOptions?.includeHidden ?? false }
    : toolId === "spreadsheet-to-pdf" ? { encoding: "utf-8", ...previousOptions } : undefined;
  if (!tool) return <Navigate to={ROUTES.home} replace />;
  // 同一工具重进（离开再回来）也应重建：key 用 toolId 已足够（路由参数变化即重挂）。
  return <ToolWizard key={`${tool.id}:${initialPath ?? ""}`} tool={tool} initialPath={initialPath} initialConfig={initialConfig} />;
}
