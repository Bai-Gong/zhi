import type { WizardToolDefinition } from "../../shell/wizard/types";
import { mergeTool } from "./merge/mergeTool";
import { splitTool } from "./split/splitTool";

/**
 * 工具向导注册表（M4，features/tools）：一份**数据文件**，不是框架代码。
 * 新工具（M6 起的格式转换等）= 写一份 WizardToolDefinition 加进本数组——
 * 向导框架（shell/wizard）与路由（/tools/:toolId 通配）无需任何改动
 * （验收 M4-5「配置方式接入」）。
 *
 * 数组元素泛型各异（每个工具的配置/文件元信息类型不同），故以显式 any 宽化；
 * 具体类型在各自工具定义处严格约束。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 异构注册表，见上注
export const WIZARD_TOOLS: readonly WizardToolDefinition<any, any>[] = [mergeTool, splitTool];

/** 按 id 找向导工具（路由 /tools/:toolId 用）；未注册返回 undefined。 */
export function findWizardTool(id: string | undefined): (typeof WIZARD_TOOLS)[number] | undefined {
  return WIZARD_TOOLS.find((tool) => tool.id === id);
}
