# pal-web

wasm-bindgen bridge that exposes the Pal Lab Tauri command surface to the
browser build. The React/TS app runs the same `pal-*` crates compiled to wasm
inside a Web Worker; this crate is the boundary the Worker talks to.

Every export mirrors a native Tauri command 1:1 — same command strings, same
camelCase invoke arg keys, same JSON return shapes — so `app/src/lib/tauri.ts`
needs no per-command shims.

## Building the wasm package

The build emits into `app/src/wasm-pkg/` (git-ignored — it is generated from
this crate, never committed). From the repo root:

```sh
wasm-pack build crates/pal-web --target web --out-dir ../../app/src/wasm-pkg
```

`--out-dir` is relative to this crate's manifest, so `../../app/src/wasm-pkg`
resolves to `app/src/wasm-pkg/`. This produces:

- `pal_web.js` — the JS glue (ES module).
- `pal_web.d.ts` — TypeScript types for the exports below.
- `pal_web_bg.wasm` — the compiled module (~2 MB).

### `build:wasm` script hint

Add this to `app/package.json` `scripts` so the web build has a one-liner
(run it before `build:web`):

```json
"build:wasm": "wasm-pack build ../crates/pal-web --target web --out-dir ../app/src/wasm-pkg"
```

Install `wasm-pack` first if missing: `cargo install wasm-pack --locked`.
The `wasm32-unknown-unknown` rustup target is also required
(`rustup target add wasm32-unknown-unknown`).

## Exports (contract)

| export | signature | notes |
| --- | --- | --- |
| `default()` | `() => Promise<InitOutput>` | wasm-bindgen module init; call once. |
| `init_pack()` | `() => void` | Idempotent; force-decodes the embedded GameData pack. |
| `load_save_bundle(paths, buffers)` | `(string[], Uint8Array[]) => string` | Parses + caches a save from raw file buffers; returns `SaveSummary` JSON. Paths are folder-relative, tolerant of any leading prefix. |
| `dispatch(cmd, args_json)` | `(string, string) => string` | Runs a command against the cached save / pack; returns result JSON, throws on error. |
| `set_progress(cb)` | `(Function) => void` | Installs the `solve-progress` callback; `cb` receives one arg — the payload as a JSON **string** (same snake_case shape as the Tauri `solve-progress` event). |
| `cancel_solve_token(token)` | `(number) => void` | Trips the cancel flag for a solve token (best-effort; the search deadline is the hard stop). `dispatch("cancel_solve", {token})` does the same. |

### Bundle files

`load_save_bundle` classifies each `(path, buffer)` pair by filename:

- `Level.sav` — **required** (errors if absent).
- `LevelMeta.sav` — world name.
- `WorldOption.sav` — `get_world_options` (egg hatch time).
- `LocalData.sav` — map fog + custom markers (`get_map_state`).
- `Players/*.sav` — regular player saves (party/palbox + map player state).
- `Players/*_dps.sav` — dimensional pal storage.

Unknown files are ignored.

### Commands

`dispatch` mirrors the full native command registry: `load_save`, `solve`,
`solve_queue`, `cancel_solve`, `list_species`, `list_passives`,
`list_active_skills`, `get_world_options`, `list_breeding_boosts`,
`list_lab_research`, `paldex_species`, `paldex_species_detail`,
`breeding_child`, `breeding_parents`, `reverse_breeding`, `roster_counts`,
`dex_reachability`, `data_pack_info`, `get_map_state`. Save-dir arguments are
ignored and resolved to the cached bundle.

`watch_save`, `unwatch_save`, and `check_update` have no faithful browser
analogue and return a descriptive error.

## Testing

Native (no wasm) tests exercise bundle routing, dispatch arg parsing, and a full
`load_save_bundle` → `dispatch("roster_counts")` round-trip against the real
testdata save:

```sh
cargo test -p pal-web
cargo check -p pal-web --target wasm32-unknown-unknown
```

## Single-thread caveat

`solve`/`solve_queue` run synchronously in the Worker (no thread offload).
Cancellation is best-effort between chunk boundaries; the solver's built-in
search deadline (`SolverConfig::search_budget_secs`, default 120s) is the hard
stop. wasm threads / rayon-in-wasm are intentionally deferred.

> **Benchmarking note:** never measure this pkg under Bun — Bun/JSC runs this wasm ~140x slower than V8 (72s vs 0.5s for a full save load). Measure in Chromium or node.
