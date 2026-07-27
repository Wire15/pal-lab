// Non-web builds (desktop Tauri, fixture dev) alias the pal-web wasm import to
// this stub via vite.config's resolve.alias. It keeps the worker module
// compilable/bundlable without pulling the ~2 MB wasm into the desktop bundle
// (or requiring wasm-pkg on disk), and throws loudly if ever actually invoked —
// which never happens, because those builds never instantiate the worker.

const UNAVAILABLE = "wasm backend not available in this build";

export default function init(): Promise<unknown> {
  return Promise.reject(new Error(UNAVAILABLE));
}
export function init_pack(): void {
  throw new Error(UNAVAILABLE);
}
export function load_save_bundle(): string {
  throw new Error(UNAVAILABLE);
}
export function dispatch(): string {
  throw new Error(UNAVAILABLE);
}
export function set_progress(): void {
  throw new Error(UNAVAILABLE);
}
export function cancel_solve_token(): void {
  throw new Error(UNAVAILABLE);
}
