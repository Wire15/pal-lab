# Vendored: powzix/ooz (Kraken decompressor)

Palworld `Level.sav` payloads are compressed with Oodle **Kraken**. This
directory vendors the open-source **ooz** reimplementation to decompress them.
The crate uses **decompression only** (Palworld saves are read-only for us).

## What was vendored

- Upstream: <https://github.com/powzix/ooz>, `master` branch.
  The repo has no tags/releases; the sole version marker is the per-file header
  `Copyright (C) 2016, Powzix`. The exact commit was not recorded when these
  files were first added to the repo; the vendored contents match upstream
  `master` (the file set below).
- Files:
  - `kraken.cpp` — **modified** (see below)
  - `bitknit.cpp`, `lzna.cpp` — verbatim
  - `stdafx.h`, `stdafx.cpp`, `targetver.h` — verbatim (MSVC support headers)

### Modifications to `kraken.cpp`

Upstream `kraken.cpp` is a standalone CLI tool. For linking into a Rust library
the following were **removed**:

- `int main(...)` (the `ooz` command-line driver),
- the `oo2core_*.dll` loader (`LoadLib`, `OodLZ_*` typedefs/globals),
- CLI-only helpers (`error`, `load_file`, `ParseCmdLine`, `Verify`).

and the following was **added** at the end of the file:

```cpp
extern "C" int ooz_kraken_decompress(const unsigned char *src, size_t src_len,
                                     unsigned char *dst, size_t dst_len) {
  return Kraken_Decompress(src, src_len, dst, dst_len);
}
```

`Kraken_Decompress` handles the internal 256 KB multi-block framing. The decoder
may write up to `SAFE_SPACE` (64) bytes past `dst_len`; the Rust caller
(`compress::oodle_decompress`) over-allocates the destination accordingly.

Compiled by `build.rs` via the `cc` crate (MSVC `/EHsc`, warnings silenced).

## LICENSE STATUS — FLAGGED, UNRESOLVED

**The vendored sources are GPL-3.0-or-later. This is INCOMPATIBLE with
pal-calc's MIT license and must be resolved before any distribution.**

- `kraken.cpp`, `bitknit.cpp`, and `lzna.cpp` each begin with a header reading:
  *"This program is free software: you can redistribute it and/or modify it
  under the terms of the GNU General Public License ... version 3 ... or (at
  your option) any later version."*
- The upstream repository has **no separate `LICENSE` file**; the in-file GPL-3.0
  headers are the only license statement.
- GPL-3.0 is strong copyleft. Statically linking this decompressor into the
  MIT-licensed `pal-save` crate makes the **combined binary** subject to
  GPL-3.0. Shipping pal-calc as MIT while linking this code would be a license
  violation.

### Options to resolve (pick before shipping)

1. **Replace** the decompressor with a permissively-licensed Kraken/Oodle
   implementation, or the official Oodle SDK under its own terms.
2. **Isolate** ooz behind a process/dylib boundary and distribute that
   component under GPL-3.0 separately (careful: mere aggregation vs. derived
   work is fact-specific — get legal review).
3. **Relicense** the affected pal-calc distribution (or its save-import path)
   under GPL-3.0.

### On "palcalc ships it too"

palcalc (MIT) bundles a Kraken decompressor for the same purpose. That does not
cure the GPL obligation for pal-calc or for palcalc — an upstream project's
license choice does not relicense GPL code. Recorded here for transparency, not
as a clearance.
