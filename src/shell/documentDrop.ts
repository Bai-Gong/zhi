import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openDocumentsBatch, useDocumentStore } from "../core/document";
import { isSupportedDocument } from "../core/document/officeDocument";
import { buildViewerUrl } from "./routes";
import { syncViewerRouteToActiveTab, type HotkeyNavigator } from "./hotkeys";

/** Native drops expose local paths; browser File objects intentionally do not. */
export function installDocumentDrop(navigate: HotkeyNavigator): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let stop: (() => void) | undefined;
  let chain = Promise.resolve();
  void getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (disposed || payload.type !== "drop") return;
    const paths = payload.paths;
    chain = chain.then(async () => {
      if (disposed) return;
      const supported = paths.filter(isSupportedDocument);
      navigate(buildViewerUrl());
      if (supported.length) await openDocumentsBatch(supported);
      if (disposed) return;
      syncViewerRouteToActiveTab(navigate);
      if (supported.length !== paths.length) useDocumentStore.getState().rejectOpen("部分文件未打开：支持 PDF、DOCX、XLSX、PPTX 和 CSV。");
    }).catch(error => useDocumentStore.getState().rejectOpen(`打开拖入文件失败：${String(error)}`));
  }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; })
    .catch(error => console.warn("无法注册文件拖放：", error));
  return () => { disposed = true; stop?.(); };
}
