// 查看器模块内部的「适应宽度」桥：工具栏不拥有滚动容器，真实计算在 ViewerPage
// （持有容器与页面尺寸）注册，工具栏只发起请求。非全局 store，仅模块内使用。

type FitWidthHandler = () => void;

let fitWidthHandler: FitWidthHandler | null = null;

/** 注册处理器；返回注销函数。 */
export function registerFitWidthHandler(handler: FitWidthHandler): () => void {
  fitWidthHandler = handler;
  return () => {
    if (fitWidthHandler === handler) fitWidthHandler = null;
  };
}

/** 请求按当前滚动容器与当前页宽度执行「适应宽度」缩放。 */
export function requestFitWidth(): void {
  fitWidthHandler?.();
}
