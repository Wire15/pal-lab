# Pal Lab — app

The Pal Lab frontend: **React 19 + TypeScript (strict) + Tailwind v4**, bundled
with **Vite**. It ships two ways from this one codebase:

- **Desktop** — a **Tauri v2** shell (`src-tauri/`) wrapping the same UI, with a
  live save watcher and native FS access.
- **Web** — a WebAssembly build where the Rust solver/parser (`../crates/pal-web`)
  runs client-side in a Web Worker, deployed to **pal-lab.pages.dev**.

## Dev commands

Run with [Bun](https://bun.sh) (`package.json` scripts are the source of truth):

```sh
bun install            # install deps
bun run dev            # Vite dev server (desktop-mode UI, no backend)
bun run dev:web        # Vite dev server in web mode
bun run tauri dev      # desktop app against the dev server
bun run tauri build    # build the desktop app/installer
bun run build          # tsc + vite build (desktop assets)
bun run build:web      # build:wasm, then tsc + vite build for the web target
cargo test             # Rust workspace tests (solver/parser/data), from repo root
```

## Design contract

The visual + interaction contract is binding: see the repo root
[`../README.md`](../README.md) for what the app does, and
[`UI-DESIGN.md`](UI-DESIGN.md) for the per-view design spec.
