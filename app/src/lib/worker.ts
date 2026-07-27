/// <reference lib="webworker" />

// Web-mode backend worker. Runs the `pal-web` wasm off the main thread so the
// single-threaded solver's search deadline never blocks the UI. It is the server
// half of the RPC protocol whose client lives in `lib/tauri.ts`:
//
//   request   { id, cmd, args }                       (posted by the client)
//   response  { id, ok: true, value }                 (success)
//             { id, ok: false, error }                (Err from wasm-bindgen)
//   progress  { progress: <payload> }                 (pushed during a solve)
//
// A special first request `{ id, cmd: "__load_bundle", args: { paths, buffers } }`
// carries the dropped save files (buffers are transferables) and caches the
// parsed save in the wasm's thread-local; its response value is the SaveSummary,
// identical to the native `load_save`. Every other command is forwarded verbatim
// through `dispatch(cmd, args_json)` — including `cancel_solve`, which just flips
// the cancel flag (no worker termination this wave; the solver deadline is the
// hard stop).

/** RPC request envelope from the main thread. */
interface RpcRequest {
  id: number;
  cmd: string;
  args: unknown;
}

/** `__load_bundle` payload: folder-relative paths + their raw file bytes. */
interface LoadBundleArgs {
  paths: string[];
  buffers: ArrayBuffer[];
}

/** The wasm-pkg surface this worker drives (see the shared web contract). The
 *  default export is the wasm-pack init function that instantiates the module. */
interface PalWebModule {
  default: (module_or_path?: unknown) => Promise<unknown>;
  init_pack: () => void;
  load_save_bundle: (paths: string[], buffers: Uint8Array[]) => string;
  dispatch: (cmd: string, args_json: string) => string;
  set_progress: (cb: (payload: string) => void) => void;
  cancel_solve_token: (token: number) => void;
}

// Lazily instantiate the wasm module once. `init_pack()` is idempotent on the
// Rust side, but a single shared promise coalesces a burst of early requests
// into one load.
let wasmPromise: Promise<PalWebModule> | null = null;

function loadWasm(): Promise<PalWebModule> {
  if (!wasmPromise) {
    wasmPromise = instantiate();
  }
  return wasmPromise;
}

async function instantiate(): Promise<PalWebModule> {
  // Dynamic import (not static): the wasm pkg is a platform-specific module that
  // only exists in the web build (published to ../wasm-pkg by the pal-web slice)
  // and MUST NOT enter the desktop Tauri entry bundle. Keeping it behind this
  // worker's dynamic import is what confines it to the web worker chunk.
  // Cast the generated wasm-pkg module (whose own types we don't depend on) to
  // the surface we drive; assigned once to a named const, never inline.
  const mod = (await import("../wasm-pkg/pal_web.js")) as unknown as PalWebModule;
  await mod.default();
  mod.init_pack();
  // The wasm hands each solve/queue progress payload as a JSON string (same
  // snake_case shape as the Tauri "solve-progress" event); parse it to the
  // object the client's progress bus (use-solve) expects, then forward.
  mod.set_progress((payload: string) => {
    self.postMessage({ progress: JSON.parse(payload) });
  });
  return mod;
}

self.onmessage = async (e: MessageEvent<RpcRequest>) => {
  const { id, cmd, args } = e.data;
  try {
    const mod = await loadWasm();
    let value: unknown;
    if (cmd === "__load_bundle") {
      // `args` is our own RPC envelope, built by the client half in tauri.ts —
      // structurally a LoadBundleArgs; cast once to a named const, not inline.
      const bundle = args as LoadBundleArgs;
      const views = bundle.buffers.map((b) => new Uint8Array(b));
      value = JSON.parse(mod.load_save_bundle(bundle.paths, views));
    } else {
      // wasm-bindgen throws the Err(String) as a JS exception, caught below.
      value = JSON.parse(mod.dispatch(cmd, JSON.stringify(args ?? {})));
    }
    self.postMessage({ id, ok: true, value });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
