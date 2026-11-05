import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPickedPdf, type HotkeyNavigator } from "./hotkeys";
import { buildToolWizardUrl, ROUTES } from "./routes";
import { useUiStore } from "./uiStore";

/** Returns cleanup immediately, including when the async listener mounts late. */
export function installNativeMenu(navigate: HotkeyNavigator): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<string>("zhi:native-menu", ({ payload }) => {
    if (disposed) return;
    if (payload === "open") { void openPickedPdf(navigate); return; }
    if (payload === "theme-light" || payload === "theme-dark" || payload === "theme-system") {
      const theme = payload === "theme-light" ? "light" : payload === "theme-dark" ? "dark" : "system";
      useUiStore.getState().setThemePreference(theme);
      return;
    }
    let route: string | undefined;
    if (payload === "home") route = ROUTES.home;
    else if (payload === "viewer") route = ROUTES.viewer;
    else if (["merge", "split", "pdf-to-word", "word-to-pdf", "pdf-to-images", "images-to-pdf"].includes(payload)) {
      route = buildToolWizardUrl(payload);
    }
    if (route) {
      useUiStore.getState().setImmersive(false);
      navigate(route);
    }
  }).then(stop => {
    if (disposed) stop();
    else unlisten = stop;
  }).catch(error => console.warn("无法连接原生菜单：", error));
  return () => { disposed = true; unlisten?.(); };
}
