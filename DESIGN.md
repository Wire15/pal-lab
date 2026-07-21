# Pal Calc (Rust) — Design & Research Capture

Successor to [tylercamp/palcalc](https://github.com/tylercamp/palcalc) (MIT, C#/WPF):
a save-aware Palworld breeding solver, combined with a paldb.cc-style reference layer,
rebuilt as a Rust core + TypeScript UI. Research captured 2026-07-21 (Palworld 1.0 era,
game released 1.0 on 2026-07-10; palcalc v1.17.7).

## Decisions (settled)

| Decision | Choice | Why |
|---|---|---|
| Core language | **Rust** | Solver is CPU-bound combinatorics; palcalc fights C# GC with object pools + manual threads. Save-parsing lineage that is alive is Rust (`uesave-rs` → `palworld-save-pal`'s `psp-server`, self-reported 5× vs Python). |
| UI | **TypeScript web frontend in Tauri** | Full web UI toolbox, cross-platform (Linux was a recurring palcalc complaint), small binary, native FS access for save detection. |
| Startup perf | Game data embedded as **binary (bincode/rkyv)**, not JSON | palcalc's "slow load" = Newtonsoft reflection over 8.6 MB `breeding.json` + 1.6 MB `db.json`. Not a language problem; don't repeat it. |
| Probability constants | **Extracted from game files, never hardcoded** | The inheritance distributions are shipped DATA (see Mechanics below). Solver takes them as inputs. |
| Graph rendering | Web-side layout (elkjs/dagre) | Replaces defunct GraphSharp. |

## Mechanics ground truth (provenance-rated)

Key finding: inheritance roll distributions are **editable weight arrays on the native
game-settings class**, serialized in the Paks (Dumper-7 SDK dump, `Pal` module):

- `Combi_PassiveInheritNum` — # passives inherited from dedup'd parent-union pool. Shipped `[4,3,2,1]` → 40/30/20/10% for 1/2/3/4. **CODE-VERIFIED** (mgxts Feb-2024 disassembled `UPalCombiMonsterParameter::SetPassiveSkill`; palworld.wiki.gg 2026-07-16 confirms unchanged through 1.0).
- `Combi_PassiveRandomAddNum` — # random extras (same array; only added if Y > X, cap 4 slots; excludes non-random passives like Lucky/Legend). **CODE-VERIFIED.**
- `Combi_TalentInheritNum` — IV inheritance weights. **UNSETTLED**: palcalc models "N-of-3 IVs inherited" at 50/25/25 (manually sampled); wiki's measured model is per-stat 30% father / 30% mother / 40% random. → **Extract the CDO defaults to settle it.** Weakest parameter.
- Gender: per-species `MaleProbability` (data, `DT_PalCombiUnique` / pal table). Parent identity/gender does NOT affect passive odds (refuted folklore).
- Child species: `floor((rankA+rankB+1)/2)` nearest `CombiRank`, plus unique-combo overrides. 1.0 rewrote combos (44,851 pairs; ~180 pairings now break the old "child never rarer than rarest parent" rule).

The algorithm *consuming* the weights is native C++ (`Pal-Win64-Shipping`), not Blueprint —
no Kismet to decompile. Ground-truth paths, ranked: (1) CDO extraction of weight arrays via
CUE4Parse — hours; (2) UE4SS Lua runtime hook logging real breeding rolls at scale — days,
validates the algorithm end-to-end; (3) Ghidra on the binary — weeks, last resort.

### 1.0 mechanics palcalc does NOT model yet (our differentiators)

From `DA_BreedingItemEffectData` (datamined in palcalc #208, 2026-07-18 — open, unimplemented):

| Cake | Effect | Solver impact |
|---|---|---|
| Special (Cake05) | `PassiveInheritCountOverride=4`, `bInheritAllActiveSkills=true` | **Forces X=4** — 10% four-passive ceiling becomes 100%. Biggest lever. |
| Vegetable (Cake03) | `BreedCount=2` | Two eggs per breed — halves time/egg. |
| Mushroom (Cake02) | `TalentBonusMin/Max=1/5` | Raises offspring IV floor. |
| Deluxe Veg (Cake04) | TalentBonus 1–5 + `MutationRateBonusPercent=2.0` | IV floor + mutation rate. |

- **Mutations** (new in 1.0): ~1%/egg base (+2pp Deluxe cake), independent rolls, egg becomes a different stronger pal. Per-pairing outcome SET is not publicly reverse-engineered (palcalc #207 open). Model the rate; stub the outcome table — do not fabricate.
- **Surgery Table + Pal Reverser**: gender swappable, passives implantable at gold/item cost → these are path-cost options, not probability changes. (palcalc partially models these.)

## Solver (port target)

palcalc's algorithm (documented in `PalCalc.Solver/README.md`): iterative bottom-up DP over a
"working set" of pal references, ≤ MaxSolverIterations breeding steps; each pass breeds all
compatible pairs, keeps cheapest per (pal, gender, passive-subset, IV-relevance) key, prunes via
`MinBreedingSteps` reachability matrix + result-pruning pipeline. Effort (est. real time) is the
cost. Reference kinds: owned (0 effort), wild (catch estimate), bred (self + parents), surgery.

**Reusable MIT assets from palcalc:**
- `db.json` (1.6 MB: 299 pals, passives, gender probs) + `breeding.json` (8.6 MB: full table + min-steps matrix) — day-one data contract before we build our own extractor.
- ~115 KB of numeric probability test fixtures (`IVProbabilitiesTests`, `PassivesProbabilitiesTests_Final0-4`) — **regression oracle for the Rust port**.
- Worked probability derivations: `README-BREED-ESTIMATE.md`; constants in `PalCalc.Model/GameConstants.cs`.
- Rejected-optimization notes (`README-MISC.md`, issue #95: self-effort discriminator grew working set 10× for nothing).

## Save parsing

- Format: `.sav` = header (`PlZ1`/`PlZ2` zlib single/double, `PlM1` Oodle, `CNK0` Xbox chunked) → GVAS (magic `0x53415647`, SaveGameVersion 3) → UE property tree; pal stats are ORDINARY GVAS properties inside `CharacterSaveParameterMap.Value.RawData` (species `CharacterID`, `Gender`, `PassiveSkillList`, `Talent_HP/Shot/Melee/Defense`, `SlotID`, `OwnerPlayerUId`).
- cheahjs/palworld-save-tools (Python) is **dead since 2024-10**, can't read current saves. Treat as spec only.
- Build on the live Rust lineage: `trumank/uesave-rs`, `oMaN-Rod/palworld-save-pal` (active, tracks 1.0), `DKingAlpha/palworld-uesave-rs`.
- Must read ALL storage: party, palbox, bases, viewing cages, **dimensional storage, global palbox** (palcalc's #1 gap cluster: #178 #154 #145 #133 #129), plus Steam/Xbox/server save layouts.

## Game-data extraction

Own extractor (CUE4Parse — C# lib; or reuse `PalworldDataTools/PalworldDataExtractor`, MIT) reading
the user's installed Paks + version-matched `Mappings.usmap`: pal stats/CombiRank/gender probs,
passives, unique combos, cake effects (`DA_BreedingItemEffectData`), **GameSetting CDO weight
arrays** (the Combi_* distributions), icons, localizations (17 languages), map transforms.
Output: compact binary pack, versioned per game build. paldb.cc has no public API/dumps — not a dependency.

## v1 scope

1. Save import (all storage types, Steam + Xbox + server) → owned-pal roster.
2. Solver: passives + IVs + gender + time estimates; **cake-aware** (Special/Vegetable at minimum); surgery/reverser as cost options; validated against palcalc's test oracles.
3. Pal-dex reference layer (paldb-style): pal pages (stats, work suitability, partner skill, passives, spawn info), forward/reverse breeding lookup, passive browser — cross-linked with owned roster ("you own 2♂/1♀, best IVs …").
4. UX fixes palcalc deferred: clear "you already own this" flow (#151), force-specific-parent (#210), multi-target queue / collection completion (#183/#125), persistent UI state (#212).
5. Cross-platform: Windows + Linux.

Out of scope v1: items/tech/construction/merchant DBs, mutation outcome tables (rate modeled,
outcomes stubbed), active-skill solving, save editing (read-only always).

## Risks

- Save format churns every game patch (palcalc needed 5 hotfixes in a week after 1.0). Mitigation: build on maintained uesave-rs lineage; version-gate parsers; fail soft per-container.
- `Mappings.usmap` must match game version for extraction; wrong usmap = broken extract.
- Mutation outcome config still unknown publicly — deliberately stubbed.

## Key references

- palcalc solver docs: `PalCalc.Solver/README.md`, `README-BREED-ESTIMATE.md`, `README-MISC.md`
- palcalc issues: #185 (UI rewrite stance), #151 (UX), #178+ (storage), #186 (1.0 breakage), #207 (mutations), #208 (cakes)
- SDK dump: `NattKh/Palworld-SDK-Dump` (`Pal_classes.hpp` ~8609: Combi_* arrays; `Pal_structs.hpp` ~7007: `FPalCombiUniqueDatabaseRow`)
- Save format spec: `cheahjs/palworld-save-tools` (`palsav.py`, `gvas.py`, `rawdata/character.py`)
- Live Rust parsers: `trumank/uesave-rs`, `oMaN-Rod/palworld-save-pal`
- Mechanics: palworld.wiki.gg/wiki/Breeding (2026-07-16), mgxts reddit 1af9in7
- Data extraction: `PalworldDataTools/PalworldDataExtractor` (MIT), CUE4Parse, FModel
