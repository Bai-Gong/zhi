import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, House, RotateCcw } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 路由键（pathname+search）：变化即复位错误态——崩溃页面不影响导航去其他页面。 */
  resetKey: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: string;
}

/**
 * 页面级错误边界（shell 模块）：包住路由出口，
 * 单个页面渲染崩溃时给出中文兜底界面，而不是整窗白屏。
 * 路由变化（顶栏导航、「返回首页」等）时自动复位，错误屏不会卡死整个应用。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // 只置错误位，保留当前 resetKey：同路由下错误屏保持，路由变化才复位。
    return { error };
  }

  /** 路由键变化（进入错误态之后）→ 清除错误，让新路由的页面正常挂载。 */
  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (state.error !== null && props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[zhi] 页面渲染异常：", error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="shell-error" role="alert">
        <p className="shell-error-title">
          <AlertTriangle size={18} aria-hidden />
          页面渲染出错
        </p>
        <p className="shell-error-message">{error.message || "发生未知错误。"}</p>
        <div className="shell-error-actions">
          <button type="button" className="shell-error-button primary" onClick={this.retry}>
            <RotateCcw size={14} aria-hidden />
            重试
          </button>
          {/* HashRouter 下用 hash 链接返回首页，无需依赖路由上下文 */}
          <a className="shell-error-button" href="#/">
            <House size={14} aria-hidden />
            返回首页
          </a>
        </div>
      </div>
    );
  }
}
