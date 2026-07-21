# Palbox Sort / Search Spec (Palworld 1.0)

Reverse-engineered spec of Palworld's **in-game Palbox** sort & search, precise enough to
clone for the Palbox view (grid + list). Target game version: **1.0** (update 1.100.427,
released 2026-07-10). A build agent follows this verbatim; where the game and our data
diverge, the "Our data mapping" section is authoritative for what we ship.

Sourcing note: the 1.0 official Steam changelog is the primary source; it is reproduced
verbatim by the DayOne mirror (playday.one, 2026-07-10) and summarized by NextTier
(2026-07-10/20). Fandom's Palbox page is pre-1.0 and stale for the UI; wiki.gg is current but
light on the sort menu. The base-game sort-dropdown enumeration comes from gamepressure's
launch guide (2024-01-30).

Sources:
- Official 1.0 changelog (mirror): https://playday.one/2026/07/10/palworld-1-0-is-now-live-full-patch-notes/ (lines 859-899, 912, 1044)
- NextTier 1.0 patch notes: https://nexttier.pro/guide/palworld-patch-notes
- gamepressure Palbox guide (2024-01-30): https://www.gamepressure.com/newsroom/palworld-pals-in-palbox-get-rid-of-them-and-find-pal-merchant-loc/za6875
- Steam "Sorting Palbox" / "Seriously needing better Palbox sorting": https://steamcommunity.com/app/1623730/discussions/0/574921762383452561/ , https://steamcommunity.com/app/1623730/discussions/0/4132683013930239016/
- wiki.gg Palbox: https://palworld.wiki.gg/wiki/Palbox ; Fandom Palbox: https://palworld.fandom.com/wiki/Palbox

---

## 1. Sort options

The list sorts from a control in the **top-right corner** of the Palbox management menu
(wiki.gg "Pal Management"; Fandom: "This list can be sorted in the top right corner").
On controller you open the Sort window and press **Y** to apply; on M&K you pick the
criterion and click **Sort** (Steam "Sorting Palbox", 2024-02).

| Sort key | Meaning | Our field | Source + date |
|---|---|---|---|
| **Paldeck No.** | Palpedia/paldex number | species paldex no (`Id.PalDexNo`) | gamepressure 2024-01-30; Steam 2024 |
| **Level** | Character level | `OwnedPal.level` | gamepressure 2024-01-30; Steam 2024 |
| **Element** | Groups by element type | `elements` (slice B, incoming) | gamepressure 2024-01-30 |
| **Alpha status** | Alpha/boss Pals grouped | `OwnedPal.is_boss` | gamepressure 2024-01-30 |
| **Name** | Alphabetical by (nick)name | nickname / species name | Steam 2024 (ambiguous — see note) |
| **Expedition Power** | NEW in 1.0. Composite expedition strength | NOT derivable (see gaps) | Official 1.0 changelog (DayOne L863); NextTier |

Note on **Name**: one Steam post lists "name, Paldex ID, level"; gamepressure lists "Paldeck
No., Level, Element or Alpha status" (no Name). Sources disagree on whether Name is a distinct
dropdown entry. **Recommendation:** include Name in our clone regardless — cheap, expected, and
at worst a superset of the game.

### Default & ordering
- **Default order = physical slot order** (box index, then slot within box). New captures fill
  the first empty slot; nothing is sorted until the player invokes Sort (Fandom: "New Pals are
  put into the first available slot"). Our "Slot order" pseudo-sort restores this and is the
  grid default (PALBOX-PLAN decision 5).
- **Direction toggle (asc/desc):** default **ascending** (Paldeck No. 1..n, Level low..high).
  [INFERENCE] — the exact toggle is not documented in a citable source; treat asc as default and
  expose a desc toggle in both views.
- The in-game sort is a **one-shot physical reorder** of box contents (rewrites slot positions;
  controller must press Y to commit). We are **read-only** over the save, so we reorder
  virtually (flatten -> sort -> repaginate) and never write slots.

### Tie-breaks
The game publishes no tie-break rules. Use a **stable sort** with these tie-breaks so results
are deterministic:

| Primary key | Tie-break 1 | Tie-break 2 |
|---|---|---|
| Paldeck No. | Level (desc) | physical slot order |
| Level | Paldeck No. (asc) | physical slot order |
| Element | Paldeck No. (asc) | Level (desc) |
| Alpha status | Paldeck No. (asc) | physical slot order |
| Name | Paldeck No. (asc) | physical slot order |
| Power (est.) [substitute] | Paldeck No. (asc) | Level (desc) |

Always append **physical slot order** as the final tie-break so every sort is fully stable.

---

## 2. Search / filter

### Palbox (this is what we clone)
1.0 added exactly **one** search affordance to the Palbox itself:

> "A search function has been added to the Pal Box ... making it easier to find specific Pals."
> — Official 1.0 changelog (DayOne L859)

- The Palbox has a **text search box** (Pal name query). No structured filter chips were added
  to the Palbox in 1.0 — the changelog lists only *search* + *Retrieve All* + *sort by
  Expedition Power* for the Pal Box (DayOne L859/L863/L897).
- Community confirms the Palbox has **no passive-ability filter and no work-trait filter** in
  vanilla ("no ability to search for specific passive abilities", Steam). Those exist only via
  mods (Palbox Sorter, Global Palbox Filter).

### Paldeck (Palpedia) — filters live here, NOT in the Palbox
The **element** and **capture-bonus** filters players associate with "filtering Pals" are a
**Paldeck** feature, not a Palbox feature:

> "Filter options have also been added to the Paldeck, allowing players to display Pals whose
> capture bonuses have not yet been completed, Pals with specific elements, and more."
> — Official 1.0 changelog (DayOne L861)

| Filter category | Where in-game | UI form | Notes |
|---|---|---|---|
| Text (Pal name) | **Palbox** search box | free-text input | name match; only Palbox filter |
| Element (9 kinds) | **Paldeck** | element-icon toggle row | not in Palbox; Paldeck-only |
| Incomplete capture bonus | **Paldeck** | toggle | not in Palbox |
| Element (as sort) | **Palbox** | Sort dropdown "Element" | grouping, not a filter |
| Alpha (as sort) | **Palbox** | Sort dropdown "Alpha status" | grouping, not a filter |

**Filter combination:** the Palbox exposes at most a single active text query; the Paldeck
filters combine as AND (element AND incomplete-bonus). There is no multi-facet AND/OR filter
panel inside the vanilla 1.0 Palbox.

### UI layout
- Palbox management menu: box grid (6x5 per page; 32 boxes x 30 = 960 slots, wiki.gg
  "Function"), a box pager (LB/RB on controller), the party rail, and the **sort control +
  search box in the top-right**. Selecting a Pal opens the right-hand detail panel (Work
  Suitability, Health, Sanity, Skills, Partner Skills). "Retrieve All", per-Pal Favorite toggle,
  and Partner Skill display were added to this UI in 1.0 (DayOne L897-L899).
- Reference images (URLs): wiki.gg icon https://palworld.wiki.gg/images/Palbox_icon.png ;
  Fandom overview https://static.wikia.nocookie.net/palworld/images/d/da/Palbox.png .

### Dimensional Pal Storage / Global Palbox
Both are alternate Pal-storage structures that reuse the **same list/management UI** as the
Palbox (same sort control + search). 1.0 touched them only cosmetically/technically:
"The appearance of Pal Dimensional Storage now changes when set to private" (DayOne L912) and a
Global Pal Box gamepad focus fix (DayOne L1044). No distinct sort/filter set — clone the same
controls for our dimensional-storage tab.

---

## 3. Text-search semantics

- **Scope:** Pal **name** (species display name; plus, in our clone, player-set nickname). The
  1.0 search is a name finder (DayOne L859). It does **not** search passive-skill names — the
  top community complaint (Steam).
- **Match:** case-insensitive substring/contains against the visible name. [INFERENCE] on the
  exact algorithm (undocumented); contains is the safe clone behavior.
- **Behavior in our views:** per PALBOX-PLAN decision 4, **HIDE** non-matching slots (do not
  dim). Grid: matching Pals collapse into the flattened/repaginated order; list: filter rows.
  Empty result -> empty page with a "no matches" hint.
- **Recommendation (superset):** also match nickname and species internal id, and optionally
  passive display names behind a toggle — closes the exact gap players complain about, at no
  data cost (we already carry passives).

---

## 4. Our-data mapping (capabilities -> fields, with gaps)

| In-game capability | Our field | Status |
|---|---|---|
| Sort: Paldeck No. | `PalSpecies` paldex no (`Id.PalDexNo`) | Have |
| Sort: Level | `OwnedPal.level` | Have |
| Sort: Element | per-species `elements: string[]` | **Incoming (slice B)** — see gap |
| Sort/group: Alpha status | `OwnedPal.is_boss` | Have (alpha == boss-prefixed instance) |
| Sort: Name | nickname / species name | Have |
| Sort: Expedition Power | none | **Cannot replicate** — see gap |
| Search: Pal name | species name + `OwnedPal.nickname` | Have |
| Filter: Element (Paldeck) | `elements` (slice B) | Incoming |
| Filter: Work suitability | `PalSpecies.work_suitability[12]` (WORK_KINDS) | Have (game lacks; we exceed) |
| Filter: Gender | `OwnedPal.gender: Option<Gender>` | Have |
| Filter: Passive | `OwnedPal.passives: Vec<PassiveId>` | Have (game lacks; we exceed) |
| Filter: Lucky/Alpha | `is_boss` (alpha); Lucky not parsed | Alpha have; Lucky = minor gap |
| Rarity | `PalSpecies.rarity` (u8) | Have (species-level, not per-instance) |
| IVs | `OwnedPal.ivs: IvSet` (hp/atk/def 0-100) | Have (game lacks IV sort; we exceed) |
| Condensation rank | `OwnedPal.rank` | Have |

### Gaps & recommendations
1. **Expedition Power (1.0 sort key) — CANNOT replicate.** A composite the game computes from
   level + IVs + passives + condensation + souls/awakening; the formula is not published and we
   derive none of it.
   - **Recommendation:** OMIT the "Expedition Power" label. Offer a **derived power proxy** sort
     computed from data we have (species base HP/Atk/Def scaled by level, rank, IVs), labeled
     honestly as **"Power (est.)"** — never "Expedition Power". If the proxy is judged too
     speculative, omit it and lean on Level + IV sorts (which vanilla lacks, so we stay a
     superset).
2. **Element data — GAP being closed by slice B.** The vendored `db.json` (v26) carries **no**
   element field (verified: species keys run Id, Name, ..., Rarity, ..., WorkSuitability with no
   element/type key; the NOTICE's "elements" claim is inaccurate). Element sort/filter/badges
   depend on slice B landing `elements: string[]` (1-2 of the 9 canonical kinds) into the pack.
   Gate the Element sort/filter behind data presence until then.
3. **Lucky Pals — minor gap.** Not currently parsed; Alpha is available via `is_boss`. Omit a
   Lucky filter for now; add later if the save flag is parsed.
4. **Rarity is species-level**, not per-instance — fine for a "Rarity" sort/badge, but it will
   not vary between two instances of the same species.

### Net: our superset
We reproduce every real Palbox sort (Paldeck No., Level, Element[pending B], Alpha, Name),
reproduce the name search, and **exceed** the game with work-suitability / gender / passive /
IV / rank filters (which vanilla lacks and players mod in). The only true loss is the exact
**Expedition Power** number, replaced by an honestly-labeled power estimate or omitted.
