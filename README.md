# Pal Lab

**A save-aware Palworld breeding planner.**

Pal Lab reads your actual Palworld save and solves optimal breeding paths from
the pals you already own — accounting for passives, IVs, cakes, boosters, and
time estimates — so you get a concrete, do-this-next plan instead of a generic
breeding chart. Around the solver it wraps a full pal-dex, a world map with
fog-of-war reconstructed from your save, a palbox inspector, and an IV lab. Your
save is opened **read-only**; Pal Lab never writes Palworld save files.

Run it as a **Windows desktop app** (with a live save watcher), or with zero
install in your browser:

### ▶ [pal-lab.pages.dev](https://pal-lab.pages.dev) — the web app, no download

On the web your save is parsed **100% client-side** — it never leaves your
device.

## Screenshots

| Solver | Palbox |
|---|---|
| ![Breeding solver](docs/screenshots/solver.png) | ![Palbox inspector](docs/screenshots/palbox.png) |

| World map | Pal-dex |
|---|---|
| ![World map](docs/screenshots/map.png) | ![Pal-dex](docs/screenshots/dex.png) |

## Features

**Breeding solver**
- Optimal breeding paths from the pals you own, factoring passives, IVs, cakes,
  boosters, and time estimates. Probability model validated against palcalc's
  numeric test oracles.
- **Plan graph** (pannable/zoomable breeding-bracket flowchart) or **list**
  view, with rich per-step hover cards (odds, expected eggs, time, IV gates).
- **Multi-target queue** — plan several goals at once; later targets reuse the
  bred pals from earlier plans.
- Share and revisit: **PNG export**, copyable **plan codes**, and a **history**
  drawer of past solves.
- **No-path diagnostics** — when a target is unreachable, it tells you why
  instead of failing silently.
- **Surgery-table + gender-reverser cost options** — let the solver relax
  gender constraints via terminal implants; special lottery-tier passives
  (World-Tree, Rainbow) are correctly refused, and exact plans still win ties.
- **Honest mutations card** — mutations are ~1%/egg (code-verified), but the
  outcome pools are not publicly decoded, so Pal Lab says so rather than
  inventing odds.

**Save Inspector** — party, palbox, dimensional storage, global storage, and
cages, scoped per player.

**IV Lab** — inspect and compare individual values across your pals, and breed
for stat thresholds with best-donor rankings, cake floors, and the same
no-path diagnostics and session persistence as the solver.

**Pal-dex**
- Full species reference with **reverse breeding** (which parents produce a
  given child), drops, moves, active/partner skills, and deep filters.
- **Partner-skills tab** — all 299 partner skills with per-rank values.
- **Collection mode** — annotates each species as owned, breedable-in-k-steps
  (BFS min-steps reachability), or catch-only, with a **"breed missing"** queue.

**World Map** — fast-travel points, effigies, alphas, bounties, towers, and
bases, plus **spawn search**; fog-of-war is reconstructed from your save.

**Plan tracking (desktop)** — saved plans auto-check their steps as you breed
in-game: node status badges, progress %, and stale-parent warnings driven by
the live save watcher.

**Breeding setup** — boosters (auto-detected at your real condensation rank),
cakes, lab research (incubation acceleration), and egg-hatch time scanned from
your world options, all composing into the solver's effort math.

## Desktop vs Web

Both run the same Rust solver — the desktop app natively, the web app compiled
to WebAssembly and driven through a Web Worker. The differences:

| | Desktop (Windows) | Web ([pal-lab.pages.dev](https://pal-lab.pages.dev)) |
|---|---|---|
| Install | Installer from [GitHub Releases](https://github.com/Wire15/pal-lab/releases) | None — open the link |
| Save loading | Auto-detect, or point at your save folder | Drag-drop or folder picker |
| **Live save watcher** | ✅ auto-refresh + plan tracking | ❌ |
| Privacy | Local app | Parsed 100% client-side — your save never leaves the device |
| Save remembrance | Recent-saves profiles | **Restore on revisit** in all browsers (live folder handle on Chromium, plus a universal IndexedDB byte snapshot) |

On the web, Chromium blocks folder pickers inside `AppData` — use drag-drop or
the classic-dialog escape hatch instead (Pal Lab offers both and remembers your
picker location).

## Getting started

### Web

Open **[pal-lab.pages.dev](https://pal-lab.pages.dev)** and drop your world save
folder onto the page (see the save-location note below). Nothing is uploaded;
your save is parsed in the browser. Revisit later and click **Restore** to
reload the last save.

### Desktop

1. Download the latest **installer** or **portable ZIP** from the
   [Releases](https://github.com/Wire15/pal-lab/releases) page.
2. Launch Pal Lab and point it at your Palworld save (or let it auto-detect).

**SmartScreen note:** Pal Lab is an unsigned community build, so Windows
SmartScreen may warn on first run. Click **More info → Run anyway**. Every
release includes a **VirusTotal** link so you can verify the binary yourself.

### Where is my save?

Palworld world saves live in a folder like:

```
%LOCALAPPDATA%\Pal\Saved\SaveGames\<steam-id>\<world-id>\
```

Point the desktop app at it, or drop that world folder onto the web app.

### Supported saves

| Save type | Status |
|---|---|
| Steam (local co-op) | ✅ Supported |
| Dedicated server (local files) | ✅ Supported |
| Dedicated server (remote, SFTP) | ✅ Built in — live over SSH (desktop) |
| Xbox / Game Pass (PC) | ✅ Built in — no conversion needed |

**Xbox / Game Pass:** desktop app → **Xbox / Game Pass** button on the load
screen — it finds the Game Pass save store on your PC and reads it directly
(read-only, nothing is written). On the web app, drop the store folder itself:

```
%LOCALAPPDATA%\Packages\PocketpairInc.Palworld_ad4psfrxyesvt\SystemAppData\wgs
```

Chunked (CNK) saves are decoded natively. Xbox **console** saves must still
reach your PC first (play the world once on the PC Game Pass app so it syncs).

**Dedicated servers over SFTP:** desktop app → **Dedicated server (SFTP)**
button on the load screen. Pal Lab connects over SSH, scans for worlds, and
loads yours live — then polls for changes every 60s so the roster stays
current while you play. Read-only: nothing is ever written to the server.
Password or key-file auth; the host fingerprint is pinned on first connect
and passwords are never stored.

## What's new

The latest release is **v1.8.1**. See [`CHANGELOG.md`](CHANGELOG.md) for the
full history, and the [GitHub Releases](https://github.com/Wire15/pal-lab/releases)
page for downloads and VirusTotal links.

## Building from source

Prerequisites: **Rust (stable)** and **[Bun](https://bun.sh)**.

```sh
# Rust workspace tests (solver, save parser, data model)
cargo test

# Build the desktop app
cd app
bun install
bun run tauri build
```

## License

- Pal Lab is licensed under the **MIT License** — see [`LICENSE`](LICENSE).
  (The whole repo is MIT since the vendored C++ decompressor was replaced with
  the pure-Rust `oozextract`.)
- The **`pal-data`** and **`pal-solver`** crates each also carry their own MIT
  `LICENSE` for standalone reuse. Full third-party attribution is in
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Credits

- **[tylercamp/palcalc](https://github.com/tylercamp/palcalc)** — pioneered the
  save-aware Palworld breeding-planner niche, and provides the MIT-licensed
  breeding data files and probability test oracles Pal Lab builds on.
- **[oozextract](https://github.com/lvlvllvlvllvlvl/oozextract)** — the
  MIT-licensed pure-Rust Oodle Kraken decompressor that reads compressed save
  payloads.
- **[cheahjs/palworld-save-tools](https://github.com/cheahjs/palworld-save-tools)**
  — the reference documentation for the GVAS / `Level.sav` binary format.
- **[Pocketpair, Inc.](https://www.pocketpair.jp/)** — for Palworld.

See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for full attribution and
license texts.

## Disclaimer

Unofficial fan tool. Palworld is © Pocketpair, Inc. Not affiliated with or
endorsed by Pocketpair.

## Support

If Pal Lab is useful, **star the repo** — and file bugs or requests via
[GitHub Issues](https://github.com/Wire15/pal-lab/issues). No donation links yet.
