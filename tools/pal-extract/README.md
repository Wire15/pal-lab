# pal-extract

Dev-time tool that reads a local Palworld install (`Pal-Windows.pak`, UE 5.1) via
[CUE4Parse](https://github.com/FabianFG/CUE4Parse) and emits the game data our app lacks:
per-species elements, stats, partner-skill names/descriptions/icons, full passive-skill data,
active-skill (waza) stats (element/power/cooldown/description), and the
real `Combi_*` breeding weight arrays, plus element icons. It is NOT part of the cargo/bun workspace
and is never shipped.

Output: `out/extracted-game-data.json` (species + passives) + `out/icons/elements/<Kind>_{tile,glyph}.png`
and `out/icons/partner/<textureId>.png`. Partner-skill descriptions come from `DT_PalFirstActivatedInfoText`;
passives from `DT_PassiveSkill_Main` (names/descs via `DT_Skill{Name,Desc}Text_Common` `PASSIVE_*` keys);
partner icons keyed by `DT_partnerSkillIconDataTable` `TextureID` (glyphs resolved from
`T_icon_skill_pal_<NNN>` where a numbered texture exists; TextureIDs 0-20). Run `--discover` to
full-text search the `L10N/en` text tables for a UI string and report its table + row key.

Active skills (`active_skills`, keyed by the save-side waza id) come from
`Pal/Content/Pal/DataTable/Waza/DT_WazaDataTable`. Each row is keyed generically (`NewRow_N`); the
save-side id is the row's `WazaType` enum (`EPalWazaID::<id>`, prefix stripped). Per skill we emit
`{ name, element, power, cool_time, description }`: `element` is the `EPalElementType` enum name
(same strings as species elements — `Normal/Fire/Water/Leaf/Electricity/Ice/Earth/Dark/Dragon`, plus
`None` for the two name-only fallbacks below); `power` is the `Power` field (null when 0/non-damage);
`cool_time` is `CoolTime` rounded to whole seconds (null when 0); `description` and `name` come from
`DT_Skill{Desc,Name}Text_Common` under the `ACTION_SKILL_<id>` key, `Clean()`ed with embedded rich
tags (`<characterName>`/`<itemName>`/…) resolved to English text. Rows without a resolvable name are
skipped. To preserve the old `active_names` coverage set, every `ACTION_SKILL_<id>` name lacking a
waza row is folded in as a name-only entry (`element:"None"`, null stats), matched case-insensitively
against waza keys so a casing drift (`WazaType Railbolt` vs text `RailBolt`) never emits a duplicate.
This replaces the former flat `active_names` map.

Partner-skill descriptions embed `{templates}` the game fills per partner-skill *level* (rank
1..N). They are resolved from `DT_PartnerSkillParameter` (under `.../PassiveSkill/`, keyed by
species internal name) + `DT_PassiveSkill_Main` + `DT_PartnerSkillAppendText`:
`{PassiveN_EffectValueM}` / `{ReferencePassiveN_EffectValueM}` -> the rank-r passive N's
`EffectValueM`; `{ActiveSkillMainValueByRank}` / `{ActiveSkillOverWriteEffectTime}` -> the
rank-scaled active-skill arrays; `{ReferenceMsgId_X}` -> append-text row `X_Rank_1` (the game's
Lv.1 message, blank today; resolved recursively + cycle-guarded). Each numeric value is computed
at every rank and emitted as a single number if constant across ranks, else `(min~max)` — matching
paldb (e.g. Cattiva carry capacity `(100~200)`). Element-swap variants carry stub param rows and
inherit the base pal's data. Any template that cannot be resolved from static data is left verbatim
and reported (`[partner-template UNRESOLVED]`); the run gates on zero unresolved `{` placeholders.

Run `--export-named-partner-icons` for the bespoke follow-up: it exports every
`T_icon_skill_pal_<Name>` texture (the non-numbered glyphs) to `out/icons/partner-named/<Name>.png`
with a JSON manifest, and where a texture name exactly matches a `DT_partnerSkillIconDataTable` row
key it copies the PNG to `app/public/partner/<TextureID>.png` so that numeric key resolves. Most
bespoke row keys (species names, TextureID 21+) have no individual texture in this build — only shared
category glyphs plus a few species-specific ones (KingWhale, SwordCutlassfish, ThunderDragonMan) exist,
so this resolves only those. No fuzzy number->glyph guessing (no authoritative ordering exists).

`Mappings.usmap` (gitignored) is the type-mapping file for the installed build; source:
https://github.com/PalworldModding/UsefulFiles (kept in sync with the installed game version).

## Run

Requires the .NET 10 SDK (CUE4Parse 1.2.2.202607 targets net10.0). Oodle is auto-downloaded.

```
dotnet run -c Release
```

Paths default to the standard Steam install and `./Mappings.usmap`; override with env vars
`PALCALC_PALWORLD_PAKS` (folder containing `Pal-Windows.pak`) and `PALCALC_MAPPINGS_USMAP`.
The run asserts validation gates (species >= 299, Lamball partner skill + "becomes a shield"
description, Jormuntide elements, non-empty Combi arrays, `Legend`/`Lucky` passives with effects,
a negative-rank passive, partner coverage, zero unresolved `{` template placeholders across all
partner descriptions, Cattiva's resolved carry-capacity range `100~200`, and active skills:
`active_skills` count >= 300 with zero coverage regressions vs the old name set, `AirCanon`
resolving to name "Air Cannon"/element `Normal`/power > 0, and `Unique_SheepBall_Roll` resolvable)
and exits non-zero if any fail.
