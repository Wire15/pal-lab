# pal-extract

Dev-time tool that reads a local Palworld install (`Pal-Windows.pak`, UE 5.1) via
[CUE4Parse](https://github.com/FabianFG/CUE4Parse) and emits the game data our app lacks:
per-species elements, stats, partner-skill names, and the real `Combi_*` breeding weight arrays,
plus element icons. It is NOT part of the cargo/bun workspace and is never shipped.

Output: `out/extracted-game-data.json` + `out/icons/elements/<Kind>_{tile,glyph}.png`.

`Mappings.usmap` (gitignored) is the type-mapping file for the installed build; source:
https://github.com/PalworldModding/UsefulFiles (kept in sync with the installed game version).

## Run

Requires the .NET 10 SDK (CUE4Parse 1.2.2.202607 targets net10.0). Oodle is auto-downloaded.

```
dotnet run -c Release
```

Paths default to the standard Steam install and `./Mappings.usmap`; override with env vars
`PALCALC_PALWORLD_PAKS` (folder containing `Pal-Windows.pak`) and `PALCALC_MAPPINGS_USMAP`.
The run asserts validation gates (species >= 299, Lamball partner skill, Jormuntide elements,
non-empty Combi arrays) and exits non-zero if any fail.
