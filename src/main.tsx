import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "@tauri-apps/api/core";
import "./styles/global.css";
import "./styles/workspace.css";

// Only native macOS windows expose the desktop through AppKit vibrancy.
if (isTauri() && /Macintosh|MacIntel/.test(navigator.userAgent + navigator.platform)) {
  document.documentElement.dataset.nativeMaterial = "macos";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
