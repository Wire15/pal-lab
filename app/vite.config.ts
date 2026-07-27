import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** Absolute path to the inert wasm stub used outside the web build. */
const wasmStub = fileURLToPath(new URL("./src/wasm-stub.ts", import.meta.url));

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), tailwindcss()],

  // Outside the web build the pal-web wasm is never loaded. Alias its import
  // (from lib/worker.ts) to an inert stub so the ~2 MB pkg is neither required
  // on disk nor emitted into the desktop/fixture bundle. The web build resolves
  // the real pkg untouched.
  resolve: {
    alias:
      mode === "web"
        ? {}
        : { "../wasm-pkg/pal_web.js": wasmStub },
  },

  // Emit workers as ES modules so the web-mode wasm backend's
  // `new Worker(new URL("./lib/worker.ts", import.meta.url), { type: "module" })`
  // and its dynamic wasm import chunk correctly. Harmless for the desktop build,
  // which never instantiates the worker.
  worker: { format: "es" },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
