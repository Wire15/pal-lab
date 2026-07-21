# Pal Calc (Rust) — agent context

Rust + Tauri/TypeScript successor to tylercamp/palcalc: a save-aware Palworld breeding
solver with a paldb.cc-style reference layer. Read `DESIGN.md` first — it captures all
research, settled decisions, and provenance-rated breeding mechanics.

## Map
| Path | What's there |
|---|---|
| `DESIGN.md` | Settled decisions, mechanics ground truth, v1 scope, key references — read first |
| `crates/` | Rust workspace (save parser, solver, data model) — once created |
| `app/` | Tauri + TS frontend — once created |

## Guardrails
- Probability constants (Combi_* weight arrays) are EXTRACTED game data, never hardcoded in the solver.
- Save access is READ-ONLY, always. This tool never writes Palworld save files.
- Solver correctness is gated on palcalc's MIT test fixtures (probability oracles) — don't port the solver without porting the oracles.
- Mutation outcome tables are unknown publicly — keep stubbed, never fabricate (rate ~1%/egg is fine to model).
- palworld-save-tools (Python) is dead/stale — it is a format SPEC, not a dependency; build on the uesave-rs lineage.
