// 查看器模块内部的「适应宽度」桥：工具栏不拥有滚动容器，真实计算在 ViewerPage
// （持有容器与页面尺寸）注册，工具栏只发起请求。非全局 store，仅模块内使用。
//
// autoFit 来源标志（M2 阅读模式，B12）：requestFitWidth 置位；任何手动缩放
// （工具栏按钮/快捷键/Ctrl+滚轮）经 clearAutoFit 清零。ViewerPage 的
// ResizeObserver 在滚动容器实际宽变（沉浸进入/退出、侧栏折叠）且 autoFit
// 置位时重跑 requestFitWidth——「适应宽度」的会话在布局变化后保持适应。
// 观察用 border-box（offsetWidth）：滚动条出现/消失不触发，避免 fit↔滚动条来回震荡。

type FitWidthHandler = () => void;

let fitWidthHandler: FitWidthHandler | null = null;
let autoFit = false;

/** 注册处理器；返回注销函数。 */
export function registerFitWidthHandler(handler: FitWidthHandler): () => void {
  fitWidthHandler = handler;
  return () => {
    if (fitWidthHandler === handler) fitWidthHandler = null;
  };
}

/** 请求按当前滚动容器与当前页宽度执行「适应宽度」缩放（并标记 autoFit 来源）。 */
export function requestFitWidth(): void {
  autoFit = true;
  fitWidthHandler?.();
}

/** 手动缩放（按钮/快捷键/Ctrl+滚轮）调用：此后容器宽变不再自动重适配。 */
export function clearAutoFit(): void {
  autoFit = false;
}

/** 当前是否处于「适应宽度」来源（供 ResizeObserver 判定是否重跑）。 */
export function isAutoFit(): boolean {
  return autoFit;
}
