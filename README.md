# 百工·纸 (Zhi)

PDF / 文档处理工具，对标 Adobe Acrobat。

产品分析见 [docs/产品分析.md](docs/产品分析.md)。

属于「百工」项目集群，约定参见上级目录 [AGENTS.md](../AGENTS.md)。

## 共用毛玻璃主题

公共样式与主题运行逻辑统一来自 `@baigong/fang/glass`、`@baigong/fang/glass.css`（坊 0.1.1）。本仓库只保留布局、既有变量名映射、主题偏好及 Tauri 适配；原生窗口配置仍在 `src-tauri/tauri.macos.conf.json`。

`vendor/baigong-fang-0.1.1.tgz` 是坊 `npm pack` 的固定产物，package-lock 校验内容；可独立检出后执行 `npm ci`，不需要邻近坊源码或跨仓库凭据。公共效果修改应先在坊完成、验证并升级包版本，再同步纸和锻的同一份构建包，不能直接修改 vendor 中的实现。

本轮验证：坊 73 项测试通过，包出口检查通过；两应用 npm ci、前端构建与 macOS Tauri 调试打包通过，实际窗口检查浅色/深色与原生半透明；锻的按需详情与拖拽调宽保持正常。Windows 原生窗口本轮未实机复核。
