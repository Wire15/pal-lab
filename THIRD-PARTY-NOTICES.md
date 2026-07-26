# Third-Party Notices

Pal Lab bundles or derives from third-party material. This file lists that
material, its origin, and its license. It supplements — and does not replace —
the per-directory `NOTICE`/`README.md` files vendored alongside the code and
data (referenced below); consult those for the fuller, file-level detail.

The distributed Pal Lab desktop binary combines these components. Because one of
them (powzix/ooz, below) is licensed under the GNU GPL v3, the combined binary
is distributed under **GPL-3.0-or-later** (see the root `LICENSE`). The
`pal-data` and `pal-solver` crates are separately available under the MIT
License (see each crate's `LICENSE`) for reuse outside the combined binary.

---

## 1. tylercamp/palcalc — MIT

- Upstream: https://github.com/tylercamp/palcalc
- License: MIT
- What we use:
  - **Vendored data files** `db.json` and `breeding.json`
    (`crates/pal-data/vendor/`), included unmodified from `PalCalc.Model/` as a
    day-one data contract (species, passives, active skills, elements, gender
    probabilities; full breeding table + minimum-breeding-steps matrix). These
    are converted to a compact binary pack at build time.
  - **Numeric probability test oracles** used to gate solver correctness
    (palcalc's MIT breeding-probability fixtures).
  - **Icon assets** (pal icons, element/passive-rank icons, work-suitability
    icons) sourced from `PalCalc.UI/Resources/`, renamed but with image bytes
    unchanged.

For the authoritative per-file breakdown of exactly which palcalc files are
vendored, how they were renamed, and the game-data provenance, see
[`crates/pal-data/vendor/NOTICE`](crates/pal-data/vendor/NOTICE). That NOTICE is
the source of truth; this section summarizes it.

Note: palcalc's bundled icons and the vendored data are ultimately game data /
assets from Palworld © Pocketpair, Inc., included for personal, non-commercial
use. All rights to the underlying data and artwork remain with Pocketpair.

### palcalc MIT license text

```
Copyright 2024, Tyler Camp

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 2. powzix/ooz — GPL-3.0-or-later

- Upstream: https://github.com/powzix/ooz (`master`; the repo has no
  tags/releases)
- License: GPL-3.0-or-later (declared via in-file headers; upstream has no
  separate `LICENSE` file)
- What we use: an Oodle **Kraken** decompressor reimplementation, vendored at
  [`crates/pal-save/vendor/ooz`](crates/pal-save/vendor/ooz)
  (`kraken.cpp`, `lzna.cpp`, `bitknit.cpp`, plus MSVC support headers).
  `pal-save` uses **decompression only** to read Palworld `Level.sav` payloads
  (saves are read-only for us). `kraken.cpp` was modified for library linkage
  (CLI `main`/DLL-loader removed, a small `extern "C"` entry point added); see
  [`crates/pal-save/vendor/ooz/README.md`](crates/pal-save/vendor/ooz/README.md)
  for the exact modifications.

**This is why the combined Pal Lab binary ships under GPL-3.0-or-later.** ooz is
strong copyleft: statically linking it into `pal-save`, and thence into the
desktop app, makes the combined work subject to GPL-3.0-or-later. The root
`LICENSE` and the `pal-save` / `app` crate license fields reflect this.

Per-file header (verbatim from the vendored sources):

```
Copyright (C) 2016, Powzix

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.
```

The full GPL-3.0 text is in the root [`LICENSE`](LICENSE).

---

## 3. cheahjs/palworld-save-tools — MIT (format-documentation reference only)

- Upstream: https://github.com/cheahjs/palworld-save-tools
- License: MIT
- What we use: **nothing is vendored or ported.** This project is used purely as
  a *format specification reference* for GVAS property encoding and Palworld
  `Level.sav` `RawData` layouts. `pal-save`'s parser was written independently in
  Rust; several source comments cite the corresponding Python modules as the
  spec they follow, e.g.:
  - `archive.rs` — "Mirrors the primitive readers in cheahjs/palworld-save-tools
    `archive.py`"
  - `gvas.rs` — "Property encoding follows cheahjs/palworld-save-tools
    `gvas.py`/`archive.py`"
  - `characters.rs` — "Field layout follows cheahjs/palworld-save-tools
    `rawdata/character.py`" (and `rawdata/worker_director.py`, `rawdata/group.py`)
  - `map_objects.rs` — cites the `rawdata/map_object` lineage for the fixed
    header layout

  These are documentation citations describing where the binary format is
  documented, not copied code. No Python was translated line-for-line and no
  files were vendored. (Verified by grepping `crates/pal-save` for
  save-tools/cheahjs references: all matches are `//!`/`//`/`///` comments.)

---

## 4. oMaN-Rod/palworld-save-pal — MIT

- Upstream: https://github.com/oMaN-Rod/palworld-save-pal
- License: MIT
- What we use: the alpha (field-boss) marker icon at `app/public/ui/alpha.png`,
  transcoded from that project's `ui/src/lib/assets/img/alpha.webp` (WEBP → PNG,
  pixels unchanged). Detailed in
  [`crates/pal-data/vendor/NOTICE`](crates/pal-data/vendor/NOTICE) (Alpha / UI
  marker icon section). The icon is ultimately a Palworld game asset ©
  Pocketpair, Inc.

---

## Palworld

Palworld and all related data, names, and artwork are © Pocketpair, Inc. Pal Lab
is an unofficial fan tool and is not affiliated with or endorsed by Pocketpair.
