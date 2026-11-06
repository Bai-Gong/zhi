# 百工·纸 (Zhi)

PDF / 文档处理工具，对标 Adobe Acrobat。

产品分析见 [docs/产品分析.md](docs/产品分析.md)。

属于「百工」项目集群，约定参见上级目录 [AGENTS.md](../AGENTS.md)。

## 共用毛玻璃主题

公共样式与主题运行逻辑统一来自 `@baigong/fang/glass`、`@baigong/fang/glass.css`（坊 0.1.1）。本仓库只保留布局、既有变量名映射、主题偏好及 Tauri 适配；原生窗口配置仍在 `src-tauri/tauri.macos.conf.json`。

`vendor/baigong-fang-0.1.1.tgz` 是坊 `npm pack` 的固定产物，package-lock 校验内容；可独立检出后执行 `npm ci`，不需要邻近坊源码或跨仓库凭据。公共效果修改应先在坊完成、验证并升级包版本，再同步纸和锻的同一份构建包，不能直接修改 vendor 中的实现。

本轮验证：坊 73 项测试通过，包出口检查通过；两应用 npm ci、前端构建与 macOS Tauri 调试打包通过，实际窗口检查浅色/深色与原生半透明；锻的按需详情与拖拽调宽保持正常。Windows 原生窗口本轮未实机复核。

## Office 阅读与导出

“打开文档”、拖放和多标签支持 PDF、DOCX、XLSX、PPTX、CSV。Office 文件在本机转换为分页预览，点击“导出 PDF”保存副本；原文件不修改。转换后的 PDF 是图片页面，不提供文字搜索或选择。需要整理或编辑时，先导出并打开 PDF。

- Word：基础正文、图片、表格与页面设置沿用现有转换管线。
- Excel/CSV：A4 横向、一页宽、纵向分页；“转换设置”可选择工作表。CSV 支持 UTF-8 / GB18030，阅读编码随会话恢复。公式仅显示已保存结果，不重新计算。
- PPTX：按原尺寸逐页显示，默认跳过隐藏页；转换设置可包含隐藏页。复杂图表、SmartArt、组合图形、动画和部分母版装饰可能降级，界面会给出提示。
- 不支持旧版 DOC/XLS/PPT、加密文档、宏或编辑保存回 Office 格式。文档内的外部资源不联网加载。

回归检查：`node scripts/test-office-lifecycle.mjs`、`node scripts/spreadsheet-tests.mjs`、`node scripts/ppt-tests.mjs`、`node scripts/test-text-index.mjs`、`node scripts/test-archive-ui.mjs`，以及 `npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml`。

2026-11-06 验证：上述解析/生命周期及既有回归脚本通过，前端构建、Rust 检查与 macOS 调试打包通过。Chromium 验证中文多页表格、隐藏工作表/幻灯片、图片、取消与清理；macOS 原生窗口验证 Word/Excel/PPT 阅读、Excel 导出并重开、五个混合标签恢复、PPT 转换设置带入当前文稿。Windows 尚未实机验证。可选 Word 浏览器回归：启动 Vite 后运行 `scripts/word-office-tests.mjs`（需 Playwright，可通过 `PLAYWRIGHT_MODULE` 指定已有安装，默认测试端口 1431）。
