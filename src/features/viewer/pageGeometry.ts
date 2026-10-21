// 缩放档位（技术方案 5.3 第 10 条：1.1^n，0.25–4.0）。
// 页面基准尺寸随标签会话由 core 的 openDocument 装载进激活标签的 pageSizes，
// 查看器与侧栏缩略图直接消费，本目录不再有独立的取页/装载实现。

/** 缩放档位步长与上下限（与 core store.setScale 的夹取一致）。 */
export const ZOOM_STEP = 1.1;
export const SCALE_MIN = 0.25;
export const SCALE_MAX = 4;

export function clampScale(scale: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}
