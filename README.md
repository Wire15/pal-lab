# Pal Lab

**A save-aware Palworld breeding planner.**

Pal Lab reads your actual Palworld save and solves optimal breeding paths from
the pals you already own — accounting for passives, IVs, cakes, and time
estimates — so you get a concrete, do-this-next plan instead of a generic
breeding chart. Around the solver it wraps a full pal-dex, a world map with
fog-of-war reconstructed from your save, a palbox inspector, and an IV lab.
Your save is opened **read-only**; Pal Lab never writes Palworld save files.

## Screenshots

| Solver | Palbox |
|---|---|
| ![Breeding solver](docs/screenshots/solver.png) | ![Palbox inspector](docs/screenshots/palbox.png) |

| World map | Pal-dex |
|---|---|
| ![World map](docs/screenshots/map.png) | ![Pal-dex](docs/screenshots/dex.png) |

## Features

- **Breeding solver** — computes optimal breeding paths from the pals you own,
  factoring passives, IVs, cakes, and time estimates, with a **multi-target
  queue** for planning several goals at once.
- **Pal-dex** — full species reference with **reverse breeding** (which parents
  produce a given child).
- **World map** — fast-travel points, effigies, alphas, bounties, towers, and
  bases, plus **spawn search**; fog-of-war is reconstructed from your save.
- **Save inspector** — party, palbox, dimensional storage, global storage, and
  cages.
- **IV lab** — inspect and compare individual values across your pals.
- **Auto-reload** — watches your save and refreshes automatically when it
  changes on disk.
- **Read-only guarantee** — Pal Lab only ever reads your save; it never writes
  Palworld save files.

## Getting started

1. Download the latest **installer** or **portable ZIP** from the
   [Releases](https://github.com/Wire15/pal-lab/releases) page.
2. Launch Pal Lab and point it at your Palworld save (or let it auto-detect).

### SmartScreen note

Pal Lab is an unsigned community build, so Windows SmartScreen may warn on first
run. Click **More info → Run anyway**. Every release includes a **VirusTotal**
link so you can verify the binary yourself before running it.

### Supported saves

| Save type | Status |
|---|---|
| Steam (local co-op) | ✅ Supported |
| Dedicated server | ✅ Supported |
| Xbox / Game Pass (CNK) | ⚠️ Convert first — see below |

Xbox / Game Pass saves use the packed **CNK** format. Convert them with
[palworld-save-pal](https://github.com/oMaN-Rod/palworld-save-pal) first; Pal Lab
detects a CNK save and explains what to do.

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
