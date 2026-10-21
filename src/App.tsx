import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell/AppShell";
import { HomePage } from "./features/home/HomePage";
import { ViewerPage } from "./features/viewer/ViewerPage";
import { OrganizePage } from "./features/organize/OrganizePage";
import { EditPage } from "./features/edit/EditPage";
import { ToolWizardPage } from "./features/tools/ToolWizardPage";

/**
 * 应用外壳与路由（模块 1）。
 * 路由表唯一组装点：页面组件只在此挂载（技术方案 4.3 规则 2）。
 * 用 HashRouter：Tauri 生产环境走自定义协议，hash 路由无服务端兜底依赖。
 * /tools/:toolId 为通配（M4 向导框架）：新工具注册进 features/tools/registry.ts
 * 即可路由，无需改本文件（验收 M4-5）。
 */
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/viewer" element={<ViewerPage />} />
          <Route path="/organize" element={<OrganizePage />} />
          <Route path="/edit" element={<EditPage />} />
          <Route path="/tools/:toolId" element={<ToolWizardPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
