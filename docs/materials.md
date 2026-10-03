# Material reference

The Materials view answers “which Pal drops this resource, how much, and where
can I obtain it?” Search accepts English and native French item names, internal
IDs and unaccented input. It works without a save; with a save, owned counts and
the owned-species filter follow the application's player scope. Clicking a
Pal-dex drop opens its material record. Ingredient links navigate between records.

The distributed `app/public/data/materials.json` contains 738 materials,
crafting ingredients and obtained items from installed Steam build 25246127.
It is extracted from the game's data tables and actor components, with English
and French names from its localization tables. No save data is included.

## Units and encounter variants

- Combat drops retain every native level threshold, quantity range and chance.
  Ordinary, Alpha, predator, tower and raid encounters remain separate.
- Battle completion rewards come from `BP_PalBossBattleManager.BossInfoMap`.
  A victory reward belongs to the whole encounter, not every participating Pal.
  For example, the three World Tree middle-boss battles award 60–80 Holy Water
  at level 78; ordinary level-70+ Alphas have a separate 20–30 drop table.
- The average comparison assumes a uniform roll between minimum and maximum
  and multiplies by the drop chance. It is not an hourly production estimate.
  First-victory rewards are labeled. Server modifiers and player bonuses are
  not applied to these reference quantities.
- Ranch production joins each actor's `SpawnItem.FieldLotteryNameByRank` to
  `DT_ItemLotteryDataTable`. Select a farming suitability level from 1 to 10,
  or each species' native base level. This selector is not a condensation-star
  selector and does not infer an individual saved Pal's effective farming level.
- Fishing and expedition odds combine the reward slot's activation probability
  with the item's normalized weight within that slot. These are conditional
  on obtaining the named reward pool, not on an entire fishing trip. Slot
  numbers distinguish repeated rewards; no slot independence is assumed.
- Merchant offers use item-shop catalogs, their price overrides and currency
  definitions. Identical offers are collapsed; catalog prices do not imply a
  merchant currently has stock. Roaming merchant inventories can vary.
- Item recipes retain quantities and reverse ingredient uses. Building recipes,
  all quest rewards and live shop inventory are outside this reference.

## Map links

Links use exact encounter IDs and overlapping spawn level ranges. Alpha links
target field-boss pins; ordinary species links enable spawn heat. No fixed
location is claimed for predators or raids. Victory rewards link to an arena
landmark only through its exact `boss_type` field, or fall back to a matching
placed field-boss entry at the encounter's level. Older manifests without these
identifiers do not produce an inferred arena location.

Resource links use optional `points_of_interest` categories in the map manifest.
Older manifests without these entries still support the material reference and
ordinary spawn/boss links, and show a message for unmapped gathering sources.
Resource pins locate sources; they do not promise current harvest availability.
The map's existing fog and spoiler preferences are preserved.

## Regeneration and checks

With local game assets and the extractor's mappings configured:

```sh
PALCALC_GAME_BUILD=25246127 dotnet run -c Release --project tools/pal-extract -- --export-materials
cd app
bun test src/lib/materials.test.ts
bunx tsc --noEmit
```

The exporter checks coverage and the World Tree Holy Water drop/reward tiers.
Tests cover bilingual search, chance-aware ranking, precise map joins, random
predator behavior, native ranch yields, merchant deduplication, recipe
references, reward-pool labels and French UI strings.

The reference is static and independent of save parsing. It never writes saves.
Game names and data belong to Pocketpair; see the project's existing notices.
