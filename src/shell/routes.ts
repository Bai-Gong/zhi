/**
 * 路由表唯一事实来源（shell 模块维护）。
 * 路由在 src/App.tsx 组装（骨架冻结）；路径常量与 URL 构造收敛在这里，供外壳导航等处复用。
 */

export const ROUTES = {
  /** 首页工具中心 */
  home: "/",
  /** 文档查看器 */
  viewer: "/viewer",
  /** 页面组织（M3，独立全屏模式：缩略图网格重排/旋转/删除/提取/另存副本） */
  organize: "/organize",
  /** 工具向导（M4）：/tools/:toolId，工具集见 features/tools/registry.ts */
  toolWizard: "/tools",
} as const;

/** 查看器地址：携带待打开文件的绝对路径（技术方案 5.1 第 3 步的 URL 约定）。 */
export function buildViewerUrl(path?: string): string {
  return path ? `${ROUTES.viewer}?path=${encodeURIComponent(path)}` : ROUTES.viewer;
}

/** 组织页地址：与查看器同款 path 查询参数（同路径标签已就绪时不重载）。 */
export function buildOrganizeUrl(path?: string): string {
  return path ? `${ROUTES.organize}?path=${encodeURIComponent(path)}` : ROUTES.organize;
}

/** 工具向导地址：按注册表的工具 id 生成（/tools/merge、/tools/split…）。 */
export function buildToolWizardUrl(toolId: string): string {
  return `${ROUTES.toolWizard}/${toolId}`;
}
