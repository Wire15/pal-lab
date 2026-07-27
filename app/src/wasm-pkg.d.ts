// Fallback type declaration for the generated pal-web wasm pkg. When the real
// wasm-pack output is present (built via `build:wasm`), its own `pal_web.d.ts`
// resolves and wins — this wildcard is only consulted when the pkg is absent
// (a clean checkout, or the desktop/fixture builds where the import is aliased
// to a stub). It keeps `tsc` green without requiring the 2 MB pkg on disk.
//
// No top-level import/export here — this stays a global script so the `declare
// module` applies ambiently.

declare module "*/wasm-pkg/pal_web.js" {
  const init: (module_or_path?: unknown) => Promise<unknown>;
  export default init;
  export function init_pack(): void;
  export function load_save_bundle(
    paths: string[],
    buffers: Uint8Array[],
  ): string;
  export function dispatch(cmd: string, args_json: string): string;
  export function set_progress(cb: (payload: string) => void): void;
  export function cancel_solve_token(token: number): void;
}
