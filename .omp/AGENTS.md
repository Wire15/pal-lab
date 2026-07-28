# Pal Lab — agent context

Save-aware Palworld breeding solver + paldb.cc-style reference layer, successor to
tylercamp/palcalc (MIT C#/WPF), rebuilt as a Rust core + React/TS UI. Ships as a
Windows desktop app (Tauri) and a zero-install web app. MIT throughout.
Published at https://github.com/Wire15/pal-lab, web at https://pal-lab.pages.dev.

Read `README.md` (what it does) + `CHANGELOG.md` (shipped reality) first.
`DESIGN.md` is a pre-v1.0 research snapshot — provenance, not current truth.

## Map
| Path | What's there |
|---|---|
| `crates/pal-data` | Extracted game-data pack (species, breeding combis, moves, skills) |
| `crates/pal-save` | Read-only `.sav` parser + WGS/Xbox Game Pass save reader (CNK chunks) |
| `crates/pal-solver` | Breeding solver: passives, IVs, cakes, boosters, surgery table, gender reverser, required moves, skill fruits, IV-threshold breeding |
| `crates/pal-web` | wasm-bindgen bridge exposing solver/parser to the web build |
| `app/` | React 19 + TS (strict) + Tailwind v4 + Vite UI; `src-tauri/` = desktop shell |
| `app/UI-DESIGN.md` | Binding per-view design contract |
| `testdata/` | Gitignored personal saves + regeneration fixtures |

## Build / release
- App: `cd app && bun install`, then `bun run dev` / `bun run tauri dev` / `bun run tauri build` (desktop), `bun run build:web` (wasm + web bundle). Rust tests: `cargo test`.
- Desktop exes MUST be built via the Tauri CLI (`bun run tauri build`, CI=true) — plain `cargo build --release` on src-tauri yields a dev-flagged exe that loads localhost:1420 instead of embedded assets.
- Releases: push a `vX.Y.Z` tag → GitHub Actions builds → draft release + VirusTotal scan → publish. Web auto-deploys to Cloudflare Pages from `master`.
- WGS test fixture: regenerate via `cargo run -p pal-save --bin make-wgs-fixture -- <save_dir> <out_wgs_user_dir>`.

## Invariants
- Save access is READ-ONLY, always — never write Palworld save files.
- Honest UX copy: estimates are labeled as estimates; never fabricate game mechanics or odds (e.g. mutation outcome pools are undecoded — say so, don't invent).
- Probability/breeding constants are EXTRACTED game data in `pal-data`, never hardcoded in the solver; solver correctness is gated on palcalc's MIT probability oracles.
- Provenance comments cite their source; doc-comments explain WHY.
