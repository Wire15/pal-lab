# English / French display translations

The sidebar language selector changes the UI without remounting views. Its
choice is stored in `pal-lab.language`. A French browser initially uses French;
other browser languages fall back to English. Both dictionaries ship with the
app, with no runtime calls to external catalogues or translation services.

- `ui-fr.json`: French translations of English UI strings.
- `game-fr.json`: localized game display names, descriptions and rank templates.
- `game-ids-fr.json`: game names indexed by stable passive / active-skill IDs.

English source strings are the fallback for missing translations. Calls to `t`
normalize whitespace for lookup while preserving surrounding whitespace;
numbered `{0}` parameters insert values without translating user input.
`tr` handles labels which may also be booleans or React nodes. Components using
these helpers subscribe through `useLocale()`, including memoized roster rows.
`matchesText()` searches English and French names with case and accent folding.

Translate presentation text only. Keep species IDs, passive IDs, request fields,
solver inputs, player names, nicknames, world names and custom plan names intact.
For new UI strings, add an English source key and its French value to
`ui-fr.json`. For game data, match EN/FR reference entries by internal IDs or
identical species slugs, then add aliases for the current pack's display names.
Preserve every numbered slot in partner rank templates, including repeated
slots. The unit test checks these against the bundled game pack.

French names and descriptions correspond to Palworld’s in-game terminology.
The reference snapshot dates from 2026-09-30. Map item and landmark names were
checked against the game files from Steam build 25246127 on 2026-10-01. EN/FR
location rows are matched by their internal row keys; the dictionary also keeps
the previous map names `Eternal Pyre Tower Entrance` and `Within the Seal` as
aliases. It covers all named fast-travel points and towers, thirteen effigy
item names, and the World Tree arena labels.

Compose map statuses with translated names, for example
`t("Tower · reached · {0}", [tr(name)])`. Translating an already-interpolated
English sentence cannot look up its template or its game name independently.
Canonical actor GUIDs, item IDs and save keys must remain unchanged. The unit
test checks every named POI in the shipped map manifest and the browser smoke
test checks live language switching of hover labels.

Rights attribution is in the root
`THIRD-PARTY-NOTICES.md`.

Validation from `app/`:

```sh
bun test
bunx tsc --noEmit
bunx vite build
# With the normal generated wasm package present:
bunx vite build --mode web
```

The optional browser smoke test uses the existing fixture backend, so it needs
no private save or running game server. Start `bun run dev`, install Playwright
in your test environment, then run from the repository root:

```sh
node scripts/test-i18n.cjs http://localhost:1420
```

`PAL_LAB_PLAYWRIGHT_MODULE` and `PAL_LAB_CHROMIUM` can select an existing
Playwright installation and Chromium executable. They are optional.

The game dictionary also contains the official French observation-tower names, outdoor NPC names and journal headings extracted from the installed game localization tables. Additional map-category, collection-status and clustering labels are included for the map coverage changes in the separate POI PR.

Map encounter controls also include the wild/Alpha selector, day/night periods,
Alpha profile links and the empty-location message used by the separate map
coverage change. Interpolated wild/Alpha counts retain both numbered slots.
