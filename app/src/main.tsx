import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isWeb } from "./lib/caps";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Progressive-web-app service worker. Registered ONLY in the deployed web build
// (`vite build --mode web`, VITE_BACKEND=web → isWeb): it gives that build an
// installable manifest and an offline shell. Guarded so it NEVER runs in dev
// (import.meta.env.PROD is false), in the fixture build, or inside Tauri —
// `isWeb` is already `!isTauri && VITE_BACKEND==="web"`, so the desktop webview
// never installs a SW that could shadow its assets.
if (import.meta.env.PROD && isWeb && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // A failed registration must never break the app; offline is best-effort.
    });
  });
}
