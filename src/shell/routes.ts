/**
 * 路由表唯一事实来源（shell 模块维护）。
 * 路由在 src/App.tsx 组装（骨架冻结）；路径常量与 URL 构造收敛在这里，供外壳导航等处复用。
 */

export const ROUTES = {
  /** 首页工具中心 */
  home: "/",
  /** 文档查看器 */
  viewer: "/viewer",
} as const;

/** 查看器地址：携带待打开文件的绝对路径（技术方案 5.1 第 3 步的 URL 约定）。 */
export function buildViewerUrl(path?: string): string {
  return path ? `${ROUTES.viewer}?path=${encodeURIComponent(path)}` : ROUTES.viewer;
}
