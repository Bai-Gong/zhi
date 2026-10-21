/**
 * core/document 公共出口（模块 5：文档服务与状态）。
 * 其他模块（viewer/sidebar/home）请从此处或各子文件导入；
 * pdfjs-dist 只允许在本目录内 import（技术方案 4.3 规则 1），
 * 因此本出口不含任何 pdfjs 符号——渲染一律经 renderQueue / renderTextLayer。
 */
export { useDocumentStore, activeTabOf, MAX_TABS } from "./store";
export type {
  DocumentStatus,
  DocumentStoreState,
  DocumentMeta,
  PageSize,
  OutlineNode,
  TabSession,
  Highlight,
  HighlightRect,
} from "./store";

export { openDocument, closeDocument, pickPdfFile, getPage } from "./openDocument";

export { loadRecentFiles, addRecentFile, removeRecentFile } from "./recentFiles";
export type { RecentFile } from "./recentFiles";

export { useOrganizeStore, organizeOf, EMPTY_ORGANIZE } from "./organizeStore";
export type { OrganizeSnapshot } from "./organizeStore";

export { renderQueue, RenderQueue, capScaleForRaster, MAX_RASTER_EDGE, RENDER_PRIORITY } from "./renderQueue";
export type { RenderHandle, RenderOutcome, RenderGeometry } from "./renderQueue";

export { renderTextLayer } from "./textLayer";
export type { TextLayerHandle } from "./textLayer";

export { getPageTextItems } from "./textIndex";

export { useEditStore, EDIT_UNDO_LIMIT } from "./editStore";
export type { EditSnapshot } from "./editStore";
export {
  EDIT_FONTS,
  COVER_PADDING,
  TEXT_LINE_HEIGHT,
  editFontSpec,
  isVectorText,
  userPointToCss,
  cssPointToUser,
  userRectToCssRect,
  cssRectToUserRect,
  textItemRect,
  hitTextItem,
  makeEditObjectId,
  roundPt,
} from "./editModel";
export type {
  EditFontId,
  EditFontSpec,
  EditTransform,
  EditCssRect,
  EditObject,
  TextEditObject,
  ImageEditObject,
  EditImageAsset,
} from "./editModel";
