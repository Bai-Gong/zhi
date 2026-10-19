import type { ButtonHTMLAttributes, ComponentType } from "react";
import clsx from "clsx";

/** 图标组件的最小结构约束（lucide-react 图标均满足，避免绑定具体类型导出名）。 */
export interface IconComponentProps {
  size?: number | string;
  className?: string;
  strokeWidth?: number | string;
  "aria-hidden"?: boolean | "true" | "false";
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ComponentType<IconComponentProps>;
  /** 无障碍标签与悬浮提示（中文文案）。 */
  label: string;
}

/** 通用图标按钮（src/components 归模块 1 维护，其余模块只读使用）。 */
export function IconButton({ icon: Icon, label, className, ...rest }: IconButtonProps) {
  return (
    <button type="button" title={label} aria-label={label} className={clsx("icon-button", className)} {...rest}>
      <Icon size={16} aria-hidden />
    </button>
  );
}
