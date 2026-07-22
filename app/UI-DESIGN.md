# Pal Calc — UI Design Contract

Binding reference for every view. Round 2 (Pal-dex grid, breeding-tree
extensions) MUST follow this verbatim. The source of truth for values is
`src/index.css` (`@theme` block) — this document explains intent and usage.

## 1. Brief & direction

**Job:** a fast, data-dense desktop companion that makes multi-step breeding
plans legible at a glance.
**Audience:** Palworld players engineering perfect pals.
**Direction:** a dark **breeder's field terminal**. The chrome is quiet gunmetal
slate; vibrancy comes from the cel-shaded pal art and the categorical element
colors, never from the UI itself. Warm ancient-tech **amber** is the single
brand accent (Palworld ruins / breeding-cake glow). This is deliberately
game-adjacent and utilitarian — not a corporate dashboard, not kitsch.

Non-negotiables: never indigo-on-white cards, never Inter-everywhere, never a
gradient-metric hero, never glassmorphism. Spend boldness only on the signature.

## 2. Color tokens

All colors are `--color-*` custom properties consumed as Tailwind utilities
(`bg-panel`, `text-ink`, `border-line`, `text-amber`, …). Never hardcode hex in
components; if a new color is needed, add a token here first.

### Surfaces (cool slate, blue-green tint, never pure black)
| Token | Hex | Use |
|---|---|---|
| `abyss` | `#0d1117` | App background, input wells, icon backing |
| `panel` | `#151c26` | Cards, sidebar, view headers |
| `raised` | `#1d2733` | Table header, sticky bars, secondary buttons |
| `hover` | `#232f3d` | Hover fill on interactive surfaces |
| `line` | `#2b3746` | Primary borders, tree connectors |
| `line-soft` | `#212c39` | Row dividers, hairlines |

### Ink (cool off-white ramp, never pure white)
| Token | Hex | Use |
|---|---|---|
| `ink` | `#e7ecf2` | Primary text, values |
| `ink-dim` | `#9dabbb` | Secondary text, labels |
| `ink-faint` | `#63717f` | Tertiary, captions, disabled, eyebrow meta |

### Accent & status
| Token | Hex | Use |
|---|---|---|
| `amber` | `#f0a94a` | Brand accent, primary CTA, active nav, focus ring |
| `amber-bright` | `#ffbe63` | CTA hover, special-passive text |
| `amber-deep` | `#c17f2c` | Reserved (pressed/deep amber) |
| `good` | `#57cf8b` | High quality, high odds, positive passive |
| `fair` | `#e7c34a` | Mid-high quality, even odds |
| `warn` | `#f0983f` | Low odds, parser warnings |
| `bad` | `#ef6a6a` | Low quality, rare odds, negative passive, errors |

### Element accents (categorical; 9 Palworld types)
`el-fire #ff7043` · `el-water #4aa8e0` · `el-leaf #6ec25a` ·
`el-electricity #f2c744` · `el-ice #74d3e6` · `el-earth #cc9a5a` ·
`el-dark #8a68d6` · `el-dragon #d264b0` · `el-normal #b7b1a4`

Mapping from element name → token is case-insensitive and already handled in
`lib/assets.ts` (Ground→Earth, Grass→Leaf, Electric→Electricity, Neutral→Normal).
Round 2 uses these as the accent for a species' primary element (badge tint,
card top-rule, dex filters). In the current views two element colors do
double duty as *semantic* glyph colors: **water = male ♂**, **dragon = female ♀**
(chosen for contrast and legibility, not to imply element).

### Rarity tiers (categorical; 4 bands)
`rarity-common #7e7e7e` · `rarity-rare #6a92ff` · `rarity-epic #b963ff` ·
`rarity-legendary #ff9557`. Bucketed by combi-rank in `lib/ui.ts::rarityTier(n)`
(`≤4` Common, `5–7` Rare, `8–10` Epic, `>10` Legendary); consume as
`var(--color-rarity-<tokenKey>)` or `text-rarity-*`. Never hardcode the hex.

## 3. Typography

Three self-hosted faces (woff2 in `public/fonts`, `@font-face` in `index.css`;
the app is offline-first, so no runtime font network).

| Role | Face | Token | Where |
|---|---|---|---|
| Display | **Chakra Petch** (600/700) | `font-display` | Wordmark, view titles, plan/section labels. Angular HUD voice. |
| Body | **IBM Plex Sans** (var 100–700) | `font-sans` | All prose, names, controls. Engineered, high x-height. |
| Numeric | **IBM Plex Mono** (500/600) | `font-mono` | IVs, times, %s, counts, eyebrows, paths. Always `tabular-nums`. |

Chakra Petch is the deliberate risk — used *sparingly* and with tracking so
headings read like an in-game terminal, never as body text.

### Type scale
| Step | Size / tracking | Token pattern |
|---|---|---|
| View title | 20px / bold / `tracking-wide` | `font-display text-xl font-bold` |
| Eyebrow | 11px / uppercase / `tracking-[0.24em]` amber | `font-mono ... text-amber` |
| Column / field label | 11px / uppercase / `tracking-wider` faint | `font-mono ... text-ink-faint` |
| Body | 13–14px | `font-sans` |
| Data value | 13px mono tabular | `font-mono tabular-nums` |
| Chip / meta | 11px (9px for tier/arrow) | — |

Eyebrows use mono uppercase because they encode a *system section*, not decoration.

## 4. Spacing, radius, elevation

- **Spacing:** 4px base grid (Tailwind default scale). View padding `px-6 py-5`;
  card inner `p-3`/`px-2.5 py-2`; control padding `px-2.5–3 py-1.5`.
- **Radius tokens:** `--radius-xs 3px` (chips, focus), `sm 5px` (badges),
  `md 8px` (controls, cards, icons), `lg 12px` (plan containers). Crisp, small —
  a terminal, not a pillow. Fully-round only for the offline dot and IV bars.
- **Elevation:** flat. Depth is expressed by *surface step* (abyss → panel →
  raised) and 1px `line` borders, **not** drop shadows. No glow, no blur.
- **Borders:** 1px `line` for structure, `line-soft` for row dividers.

## 5. Color semantics (data coding)

Encoded once in `lib/ui.ts`; reuse those helpers, don't re-derive thresholds.

- **IV talents (0–100)** — `ivBand()` → `good ≥90`, `fair ≥70`, `mid ≥50`,
  `low <50`. Rendered as a right-aligned mono numeral tinted by band with a thin
  quality bar (`QUALITY_TEXT` / `QUALITY_FILL`).
- **Breeding success rate (0–1)** — `probBand()` → `high ≥75%` good, `even ≥50%`
  fair, `long ≥25%` warn, `rare <25%` bad. Rendered as an outlined mono pill.
- **Passives** — rendered as the in-game **strip** (`components/passive-strip.tsx`,
  §12): a full-width horizontal bar, bold name left, a rank **icon cluster** right,
  on a tier/rank-colored border+fill. Coloring is **sign-then-magnitude/tier**
  (`stripBand(rank, tier)`): `rank < 0` = **red** (`bad`, down chevrons); `tier
  "worldtree"` **or** `rank ≥ 5` = **green→deep-purple** World Tree (teal border,
  pine glyph); `tier "rainbow"` **or** `rank === 4` = **green→blue iridescent**
  (teal border); else **gold** (`amber`). The cluster caps at **3 chevrons** and
  appends a **`+`** for `|rank| ≥ 4` — the game never shows 4–5 chevrons.
  Direction is shown by chevron orientation **and** color (never color alone).
  Name/rank/tier resolve from the cached `list_passives` payload, falling back to
  id-humanization (`passiveView`) for ids the pack lacks.
- **Sources** — Bred = amber tag; Owned = neutral tag + location; Wild = leaf
  tag with capture count.

## 6. Component patterns

Primitives live in `components/primitives.tsx`; compose them, don't reinvent.

- **PalIcon** `{id,name,size}` — cel-shaded portrait keyed by internal species
  id, `rounded-md`, 1px `line` ring, `abyss` backing, lazy, falls back to
  `UNKNOWN_ICON` on error. Roster 34px, tree 30px, autocomplete/inline 26px.
- **PassiveStrip** `{id, size?}` — the in-game passive strip (name left, stacked
  rank chevrons right, tier/rank-tinted border+fill); `sm` for dense contexts
  (solver tree, hover card, roster), `md` for detail/browser. See §5 + §12.
  **PassiveChip** `{id}` is a thin **alias** of `<PassiveStrip size="sm">`, kept
  so legacy callsites render the strip without churn.
- **Tag** `{tone}` — neutral/amber/boss outline badge for categorical metadata
  (containers, cake, "Fastest", "Alpha").
- **Buttons:** primary = solid `bg-amber text-abyss` → `hover:bg-amber-bright`,
  `disabled:opacity` + `cursor-not-allowed`, busy shows verb-in-progress
  ("Solving…"). Secondary = `bg-raised border-line text-ink-dim` →
  `hover:bg-hover hover:text-ink`.
- **Inputs:** `bg-abyss border-line`, `focus:border-amber/60`; paths/numerics in
  mono. Composite fields (target species) wrap icon+input in one bordered well
  with `focus-within:border-amber/60`.
- **Tables:** `sticky top-0` header on `raised`, mono uppercase sortable headers
  (active = amber + ▲/▼), `line-soft` row dividers, `hover:bg-panel/70` rows,
  numerics right-aligned. Built to stay scannable at 1000+ rows.
- **Cards / panels:** `panel` fill, `line` border, radius `md`/`lg`; section
  headers sit on `raised` with a bottom `line`.
- **Chips vs Tags:** chips carry *graded* data (passives); tags carry *flat*
  categories. Keep them visually distinct (chip = data tone, tag = neutral).

## 7. Signature element — the Lineage Ladder

The breeding plan tree is the hero and the thing the app is remembered by.
(`TreeNode` in `views/Solver.tsx`.)

- Each step is a compact **node card**: chevron · PalIcon · species + ♂/♀ · then
  right-aligned source tag, color-coded probability pill, per-step time.
- The **target root** is emphasized with an `amber/45` border and amber tint,
  under a mono "TARGET" eyebrow.
- Children hang off a vertical `line` **connector rail** with short horizontal
  elbows — an ancestry/tech-tree read, not default disclosure triangles.
- Collapsible via `<details open>`; the chevron rotates on open
  (`group-open/n:rotate-90`). Stays legible past depth 4 because the card is
  self-contained and only the rail indents.
- Wild leaves read as capture goals (leaf tag, no odds); owned leaves are
  terminal facts (neutral tag, 100%/instant).
- Each plan is wrapped in a container with a summary header: plan number,
  "Fastest" tag on the quickest, big amber total time, then mono stats
  (steps · wild · cake).

## 8. Window chrome & quality floor

- **Scrollbars:** thin, `line` thumb on transparent track, rounded, brighten on
  hover (`index.css` base layer, WebKit + Firefox).
- **Selection:** amber at 34% over `ink`.
- **Focus:** one global `:focus-visible` — 2px amber outline, 2px offset — on
  every control. Mouse focus suppressed (`:focus:not(:focus-visible)`).
- **States:** every view ships loading (verb-in-progress CTA), empty
  ("No save loaded" / "Plan a breeding path" / "No path found" — each an
  invitation to act), no-match ("No pals match …"), and error (bad-toned banner)
  states. Empty states guide the next action; errors state what happened.
- **Reduced motion:** `prefers-reduced-motion` collapses transitions.
- **Copy:** sentence case, active-voice verbs ("Load save", "Solve breeding
  path"), no filler. Interface voice in errors/empties, not an apology.

## 9. Round 2 — Pal-dex reference layer

The dex is the reference differentiator: paldb-style browsing of all 299 species
annotated with **your** roster. Two views inside one `Paldex` container (index ⇄
detail), composing the existing tokens and primitives — no new visual language.

### Element types (`components/element.tsx`)
The pack now carries per-species **element types** — `elements: string[]`, 1–2
canonical kinds ("Normal", "Fire", "Water", "Leaf", "Electricity", "Ice",
"Earth", "Dark", "Dragon") in primary-then-secondary order — so the element
badges and filter reserved in §2 are **live**. The visual language is one
primitive, no new tokens:

- **`ElementIcon`** — the bundled full-color type tile
  (`public/elements/<Kind>.png`, keyed case-insensitively via
  `lib/assets.ts::elementIconUrl`; `elementTokenKey` resolves the matching
  `el-*` token). The icon already carries the categorical color, so it needs no
  extra tint; `rounded-sm`, lazy, sized per context (13px card, 15px detail,
  16px hover/filter).
- **`ElementChip {element, label?}`** — icon-only by default; with `label` it
  becomes a quiet `bg-abyss/70` pill (matching the work-badge treatment) whose
  name text is tinted with the element's `--color-el-<key>` token — never a
  hardcoded hex. `ElementBadges {elements}` maps the 1–2 types.
- **`ElementBanner {element, size?}`** — the loud **detail-header** variant
  (in-game/paldb-style): the flat **white in-game glyph**
  (`public/elements/glyph/<Kind>_glyph.png`, via `lib/assets.ts::elementGlyphUrl`)
  beside the element name on a chip whose border and background are the element's
  own `el-*` token via `color-mix` (`50%` border, `22%` over `abyss` fill — never
  a hardcoded hex), name in `font-display` uppercase tinted the same token. The
  dark-tinted surface keeps the white glyph and colored name legible where a
  fully-saturated bar would fail contrast for the light types (ice, electricity,
  normal). Falls back to the full-color `ElementIcon` tile when a glyph is
  missing (unknown element / absent asset). `ElementBanners {elements, size?}`
  maps the 1–2 types (null when empty). One banner per type, sized for the hero
  header (default `20px` glyph), not dense card/hover contexts.
- **Placement:** icon-only near the dex `#` on the card face and in the hover
  card header (compact, siblings to the work badges); **banners** on their own
  row in the detail hero header (§Detail).
- **Element filter (index):** a labelled row of 9 icon toggles under the search
  row. Multi-select with **OR** semantics (a pal matches if *any* of its types
  is selected), **AND**-combined with owned-only / hide-variants / search.
  Inactive toggles are muted (`grayscale opacity-45`, color-preview on hover);
  active toggles get an `amber/70` border on `raised`. A `Clear` affordance
  appears once any type is on. The element color pop is the categorical signal
  the dex previously borrowed from the pal art alone.

### Index (grid)
- Responsive card grid, `auto-fill minmax(184px, 1fr)`, `gap-2` — ~5 columns at
  1280, ~3 at 1024. Dense and scannable, like the table but icon-first.
- **Species card** = `panel` + `line`, `hover:border-amber/40 hover:bg-hover`,
  the whole card a focusable `<button>` (global amber focus ring). Top row: mono
  dex `#NNN` (zero-padded) + variant `B` glyph (`el-dragon`) + compact
  element-type icon(s), and — when a save is loaded — an owned split `♂N`/`♀N`
  (water/dragon glyphs, §2 semantic colors). Body: PalIcon 44px + name + mono
  `rank NNNN` (combi rank), then the work-suitability badges.
- **Controls:** search (name/id/dex #); a segmented **sort** control (`raised`
  active = amber + ▲/▼) over Dex # · Name · Combi rank; `Owned only` (disabled +
  faint until a save loads) and `Hide variants` toggles; then a 9-type
  **element filter** row (see Element types above).
- **Roster source strip:** a `raised/60` bar with a mono `ROSTER` label, save
  path input, Browse, and Load — reuses the shared save dir (§— App state) so a
  save loaded in Roster/Solver auto-annotates the dex on arrival.

### Detail
- Sticky back bar (`← All pals`) + `Pal-dex` eyebrow. Content is centered in a
  `max-w-5xl` column inside the view's own `overflow-auto` scroller.
- **Hero header card** (`panel` + `line`): PalIcon 120 (`rounded-lg`); a meta row
  of mono amber `#NNN`, the **rarity badge**, a **size chip** (`XS–XL` class — a
  quiet `raised`/`line` pill with a faint `Size` label), a `Variant` tag, and —
  for nocturnal species — a `☾ Nocturnal` pill (`el-dark`, `border/12` tint);
  `font-display` 3xl name; an **element-banner** row (§Element types, one
  `ElementBanner` per type); and a **gender-ratio bar** — a split `el-water`(♂) /
  `el-dragon`(♀) fill from `male_probability` (0–1 fraction) with mono % labels.
  Primary CTA `Solve for this pal` (amber) jumps to the Solver pre-filled (shared state).
- **Rarity badge (`RarityBadge`):** `rarityTier(rarity)` → the tier **name**
  (Common/Rare/Epic/Legendary) loud, on a chip whose text, border, fill, and
  leading dot are the `rarity-<key>` token via `color-mix` (never a hardcoded hex,
  never the raw number as the label); the raw `Rarity` integer lives only in the
  chip's `title` tooltip.
- **Partner skill** is a full-width `Section`; the ground-truth pack now carries a
  partner-skill **name for every species**, so it renders for all — name in
  `amber-bright` `font-display`. The **description is optional** (authored text
  for ~169 species, else null): when present it sits below in `ink-dim`,
  `whitespace-pre-line`; when absent the name-only layout stands on its own under
  the eyebrow — intentional, never a placeholder. (Still guarded on non-null for
  any species the pack lacks entirely.)
- **Panels** use one `Section` shell (`panel/40` + `line`, mono-eyebrow header on
  `raised`, optional right-aligned mono stat/link). Sections, in order:
  - **Base stats** — `StatRow` per combat stat (Health, Attack, Defense): mono
    label + right-aligned value + a thin `amber/80` bar normalized to the pack's
    observed per-stat caps (`STAT_MAX` HP 180 / ATK 150 / DEF 200), floored at 4%.
    Paired two-up with **Movement**.
  - **Movement** — the five ground-truth speeds (`MoveRow`: Walk, Run, Ride
    sprint, Transport, Slow walk) as mono label + value + a thin **cool
    `ink-dim/70`** bar (deliberately distinct from the amber combat bars),
    normalized to soft ~p95 caps (`MOVE_MAX`), floored at 4% and clamped so the
    fastest legendaries (Jetragon) saturate. A `-1` value (not rideable / can't
    haul) shows an em dash and no bar — never a faked `0`.
  - **Field data** — a spec-sheet grid (`FactCell`, 2→3 columns): the
    **game-style food meter** (10 pips, `food_amount` filled amber, rest `abyss` +
    `line` ring — spans full width), then **Stamina**, **Breeding power**
    (`combi_rank`), **Craft speed**, **Price** (amber gold value), **Wild level**
    range (hidden when `(0,0)` = not wild-catchable), and **Activity** (`☾
    Nocturnal` `el-dark` / `☀ Diurnal`).
  - **Work suitability** — every nonzero suitability (`nonzeroWork`), highest
    first, as `WorkGlyph` 22 + label + mono `Lv n` in a 2→3 column grid, with a
    `N jobs` count; empty line when the species is not a base worker.
  - **Guaranteed passives** (`PassiveChip`s or empty line) and **Your roster**
    (owned count + ♂/♀ split + best-IV bars via `ivBand`/`QUALITY_*`, with a
    `View in Roster →` link) share a two-column row.
- **Breeding** is two panels: *reverse* ("How to breed this pal") lists parent
  pairs — total count in the header, first 12 as `icon+name × icon+name` cells,
  then "and X more pairs"; *forward* ("Breed with…") is a species autocomplete
  that resolves the child inline (`A + B → child`). Gender-locked combos, when
  the pack pins them, get their own panel.
- **Omitted, never faked:** active skills by level, drops, and tribes are **not**
  in the pack, so the detail page carries no section for them — no placeholders,
  no invented numbers. (Size class and movement/utility stats, once omitted, are
  now real ground-truth data and shown above.)
- **In-dex navigation:** every species cell anywhere in the detail (parent
  pairs, forward child, combos) is a button that reselects that species — the dex
  browses itself; cross-view jumps go through the lifted App state.

### Lifted App state (`src/state.tsx`)
A single small context (`AppStateProvider`/`useAppState`), no store: shared
`saveDir` (Roster · Solver · Pal-dex read/write one path), the active `view`, and
a one-shot `solveTarget` the Solver consumes on arrival. `requestSolve(name)`
sets the target and switches view; `View in Roster` just flips `view`.

## 10. Round 2 — Work suitability & the species hover card

Two additions carry the species' **work profile** — the twelve Palworld job
ratings — plus a paldb-style at-a-glance info panel, without a new visual
language: they compose the existing surfaces, ink ramp, amber accent, and mono
labels.

### Work-suitability data & glyphs
The pack carries a compact `work_suitability` per species — a 12-int array in a
fixed canonical order (`Kindling, Watering, Planting, GenerateElectricity,
Handiwork, Gathering, Lumbering, Mining, MedicineProduction, Cooling,
Transporting, Farming`), mirrored by `pal_data::gamedata::WORK_KINDS` and the
`WORK_META` table in `components/work-suit.tsx`. Levels run 0–5 in-game (the
pack tolerates higher). The categorical **glyphs** are palcalc's own job icons,
bundled under `public/work/<Kind>.png` (see `vendor/NOTICE`;
`GenerateElectricity` is palcalc's `ElectricityGeneration.png`). `WorkGlyph`
degrades to a tinted mono **two-letter code chip** (`bg-raised`, `text-ink-dim`)
if an icon fails to load — never an emoji.

### Work badges on the dex card (`CardWorkBadges`)
The card face shows the species' **nonzero** suitabilities, highest first, as up
to four compact chips (`bg-abyss/70`, glyph + mono level) with a faint mono
`+n` overflow. Capped deliberately: the grid stays scannable and the badges
read as a dense sparkline of what a pal is *for*, not a full table. Zero-work
species render nothing (no empty row).

### Pal hover card (`<PalHoverCard speciesId pal?>`)
A transient, paldb-inspired info panel that wraps any single trigger element and
attaches anywhere a species id is known. It reads the game's **dark info-panel**
voice through our tokens and comes in **two variants driven by one prop**:

- **Species-only** (`speciesId` alone) — dex cards; every breeding parent /
  child / gender-locked cell in the detail. Species reference material.
- **Owned-instance** (`speciesId` + the `pal: OwnedPal`) — every occupied Palbox
  slot (party rail, box grid, base strips, dimensional). Adds a per-instance
  strip above the species sections; the species rows stay identical, so the two
  variants read as one card that simply grows a "your pal" band.

Shared voice:
- **Surface:** `bg-panel/95` (a slight, deliberate translucency — the nod to the
  game's translucent panel, *not* glassmorphism: no blur, no glow) over a `line`
  border and a dark `abyss/70` ring. Separation comes from the surface step +
  border + ring, per §4 — the one sanctioned floating overlay, still flat.
- **Rarity accent:** the header's rarity reads as its **tier name** (`rarityTier`
  → Common/Rare/Epic/Legendary) tinted with `var(--color-rarity-<tokenKey>)`
  (§2.Rarity), never the raw integer. **Epic/Legendary** are "prized": the whole
  card swaps its quiet ring for a 1px rarity-token border **plus a soft outer
  glow** in the same token, and the display name gets a matching `text-shadow` —
  the game's rarity-color cue, done with tokens (no hardcoded hex).
- **Header:** PalIcon 40; **display name** (an owned pal's *nickname* wins the
  title line, the species name drops to a faint subtitle); mono amber `#NNN` +
  rarity tier + `Variant`; compact **element-type icon(s)** (`ElementBadges`
  size 16) at the right edge.
- **Instance strip** (owned variant only, on `bg-abyss/30`): a wrap row of
  **`Lv n`** pill, **gender** glyph+label (`genderView`), the real **Alpha**
  marker (`alphaIconUrl`) when `is_boss`, **condensation** `★n` when `rank>0`,
  and right-aligned **IVs** (HP/ATK/DEF, `ivBand`-colored, hidden when all 0);
  then a wrap of **passive chips** (`PassiveChip`), omitted when none.
- **Partner skill** (species): mono eyebrow + amber-bright **name**, with the
  effect **description clamped to two lines** (`line-clamp-2`, `ink-dim`) when
  present. The whole row is *omitted entirely when the pack has no partner skill*
  (~130 species) — never a placeholder.
- **Work suitability** (species): nonzero only, glyph + label + mono `Lv n`, two
  columns past six rows.
- **Footer** (species): 10-slot amber **food meter**, a `☾` **nocturnal** marker
  (`el-dark`), and the mono **wild-level** range (hidden when `(0,0)`).
- **Behavior:** opens ~250 ms after pointer-enter, positions itself with
  hand-rolled `fixed` + measured geometry (no portal lib), prefers the anchor's
  right and **flips left / clamps vertically** to stay in the viewport, never
  captures the pointer (`pointer-events: none`), and closes on leave, scroll, or
  resize. Species data comes from a module-cached `paldex_species` fetch;
  instance data rides in on `pal`, so the card renders its instance band even
  for a pal absent from the pack (fallback: character id as the name).

## 11. Palbox — full-screen layout & the game-style slot

The Save Inspector's grid view clones the in-game Palbox screen. The composition
(party rail + box grid + bases) **fills the content area** and grows with it;
once the fluid slots hit their `160px` cap on wide screens it stops growing and
**centers** its intrinsic width (`mx-auto` on an inner wrapper) instead of
hugging the left edge — the palbox is a centered composition, never a small
island, never a left-clung block. Owned by `components/palbox/**` +
`views/SaveInspector.tsx`.

### Layout
- **Vertical party rail (left).** `PARTY_SIZE` (5) fluid slots stacked
  top-to-bottom under a mono `PARTY` eyebrow, mirroring the game. `shrink-0` so
  it never collapses; the box grid takes the remaining width to its right
  (`flex items-start gap-6`). The surface toggle (Palbox / Dimensional) sits
  above the row, left-aligned to the composition's left edge (the party rail).
- **Box grid (right).** The paged 6-wide game box (`GRID_COLS = 6`,
  `PAGE_SIZE = 30` → 6×5), left-aligned (`justify-start`), packed. Physical
  layout renders trailing empty slots (faint dashed circles); compact/filtered
  and dimensional pages are gap-free.
- **Bases (full width, below).** One row per base; see base scoping below.

### Fluid slot sizing scale
Slots are **fluid, not fixed**. `SaveInspector` measures the (stable) content
wrapper width with a `ResizeObserver` and packs the party column + 6 box columns
into it: `size = clamp(56px, floor((contentW − rowGap − 5·gap) / (COLS+1)), 160px)`
with a fixed `12px` grid gap. Driving the size off the wrapper — not the flex-1
box column — avoids a size↔layout feedback loop. The single `size` flows to
`PartyRail`, `BoxGrid`/`PalGrid`, and `BaseStrip` (base slots stay compact:
`clamp(44, size, 56)`). Result: the grid **grows on wider screens** (≈132px at
1280, filling the width edge-to-edge → the `160px` cap at 1600, where the now
intrinsic-width composition centers in the surplus). The `contentRef` wrapper it
measures stays full-width (the centered inner wrapper is a separate child), so
centering never perturbs the measurement loop.

### Gender glyph badge (replaces the colored dot)
Gender is shown as a **glyph, never a bare colored dot**: the Mars/Venus glyph
(`genderView`, `♂`/`♀`) on a small dark circular chip (`bg-raised`, `border-abyss`)
at the slot's bottom-right, tinted with the §2 semantic colors (**water = ♂**,
**dragon = ♀**). The badge and its glyph scale with the slot
(`≈0.3·size` / `≈0.22·size`, floored at 15px / 10px) so it stays legible from the
smallest to the largest slot. Genderless entities render no badge. List rows
(`Sex` column) and the filter bar use the same glyph + tint; the dot is retired
everywhere.

### Human slot treatment
Captured humans (`OwnedPal.is_human`, `selectors.ts::isHuman`) read as
**intentional, not broken**: instead of a portrait/`?`, the slot shows a muted
neutral **humanoid silhouette** (`HumanGlyph`, `text-ink-faint` on `bg-abyss/50`
with a softer `line-soft` ring). This is distinct from the `?` `UNKNOWN_ICON`
fallback, which stays reserved for genuinely unknown pals (missing art). The
alpha badge is the real in-game marker (`assets.ts::alphaIconUrl`,
`public/ui/alpha.png`), corner-anchored and slot-scaled. Human slots carry **no
hover card** (a human has no species row to look up) — `SlotCell` renders the
bare `Slot`, never a broken species tooltip; pals get the full instance card
(§10).

### Base scoping (per selected player)
The Bases section is scoped to the selected player tab's **guild**:
`guildBases(summary)` reads the additive `SaveSummary.bases` contract
(`{container_id, guild_name, member_uids}`, all lowercase-hex), and
`scopeBasesToPlayer` keeps bases whose `member_uids` include the active player's
`PlayerRef.uid`, relabeling each with its `guild_name`. Bases shared by a guild
appear on **every** member's tab (correct). **Graceful fallback:** when the
backend hasn't published `bases` (stale fixture / pre-contract), every base is
shown as the combined view with the default `Base N` labels — nothing is hidden.

## 12. Round 3 — Passive-skill browse & partner-skill icons

The Pal-dex gains a second reference browser (passive skills) alongside the
species grid, and the partner-skill surfaces gain an icon. Both compose the
existing tokens, ink ramp, and amber accent — no new visual language.

### Section switcher (`components/dex-tabs.tsx`)
The Pal-dex is now two browsers behind one container (`views/Paldex.tsx`): a
segmented **`DexTabs`** `[Pals | Passives]` control sits beside the `Pal-dex`
eyebrow/title in each index header, styled exactly like the sort control (§6):
active = amber on `raised`, inactive = muted `ink-faint` with a hover lift.
Selecting a species always drops into the shared detail view and snaps the tab
back to **Pals** (a species detail has no passive-browse context).

### Passive browse (`views/paldex/passives-view.tsx`)
A paldb-style card grid of **only pal-facing passives** — the ones a pal can
actually roll, the same split paldb makes (114, matching their count). The
`pal_facing` flag is the pack's (`is_pal` lottery pools **or** any species'
guaranteed passives); the view filters `list_passives` to it, sorts
strongest-rank-first then alphabetical, and offers a name/effect **search**
(matches the name, the humanized effect labels, and the authored description)
with a **Reset**. Header count reads `N / 114 pal passives` while filtering,
`114 pal passives` otherwise. Grid is **centered** (`mx-auto max-w-[1160px]`) at
**up to 3 columns of wide cards** (`grid-cols-1 md:grid-cols-2 xl:grid-cols-3`),
matching paldb's wide 3-column layout. Empty/loading/no-match states per §8.

### The passive strip (`components/passive-strip.tsx`)
`PassiveStrip {id, size?}` is the in-game passive from Palworld's Pal Stats
screen, rendered as a true **STRIP**: a **block-level, full-width horizontal bar**
(clearly wider than tall) with the **name** pinned left (`font-semibold`,
truncating) and a rank **icon cluster** pinned right, on a tier/rank-colored
**border + dark fill**. Heights: **`md` ≈ 30px** (`min-h-[30px]`, detail/browser),
**`sm` ≈ 22px** (`min-h-[22px]`, dense — solver tree, hover card, roster, the
`PassiveChip` alias). It is the single source of passive coloring — the browse
card composes its exports too. Callers lay strips out in a **grid** (the strip
fills its cell), never inline pills. Name/rank/tier come from a **module-cached
`list_passives` fetch** (one shared request behind every strip), falling back to
id-humanization (`ui.ts::passiveView`) before it resolves or for unknown ids.
`title` = the raw id.

- **Grid contract.** Callers wrap strip lists in a grid, not `flex-wrap`:
  detail-view + solver nodes use `grid grid-cols-2 gap-1.5`; narrow containers
  (hover card 268px, roster cell) use `grid-cols-1`.
- **Band tints (`stripBand(rank, tier)` → `stripTint`).** Every color is a
  `--color-*` token composed via `color-mix` (never a hardcoded hex); all tokens
  used are emitted as utilities elsewhere so the raw `var()`s resolve. Derivation
  is **sign first, then magnitude/tier**:
  | Band | Trigger | Border | Fill | Name | Accent |
  |---|---|---|---|---|---|
  | **negative** | `rank < 0` | `bad` 50% | `bad` 16%→5% over abyss | `bad` | `bad` (down chevrons) |
  | **worldtree** | `tier "worldtree"` **or** `rank ≥ 5` | teal (`el-ice`×`good`) | `good` 26% → `el-dark` 48% (green→deep-purple) | `ink` | light lavender (+pine glyph) |
  | **rainbow** | `tier "rainbow"` **or** `rank === 4` | teal (`el-ice`×`good`) | `good`→`el-ice`→`el-water` iridescent (30–34% over abyss, green→blue) | `ink` | bright teal |
  | **positive** | else (`rank ≥ 0`) | `amber` 52% | `amber` 17%→6% over abyss | `amber-bright` | `amber` |

  This mirrors paldb.cc: rank-4 legendaries a green→blue shimmer with a teal
  border, rank-5 World Tree green→deep-purple, ordinary passives our gold/red.
- **Icon cluster (`RankCluster {rank, band, size}`).** Right-edge anatomy,
  paldb's `[tree][chevrons][+]`: an optional **pine glyph** (World Tree tier
  only) + **`min(|rank|, 3)` vector chevrons** (`PassiveChevrons`, `currentColor`,
  stacked, **up** positive / **down** negative) + a **`+` marker** when
  `|rank| ≥ 4`. The game caps the chevron column at 3, so we **never draw 4–5
  chevrons** — the `+` carries the overflow. Rank 0 draws no chevrons.
- **Left accent.** A thicker left border rail (`sm` 2px / `md` 3px / card 4px)
  echoes the in-game strip's colored edge.

### Passive browse card (`components/passive-card.tsx`)
A **wide** card whose header **is** the strip look, sharing
`stripBand`/`stripTint`/`RankCluster` from the strip so rainbow/worldtree
passives read as special here too, over an unchanged structured body:
- **Banner header** — the passive **name** (`font-display`) + the rank **icon
  cluster** (pine glyph on World Tree, `min(|rank|, 3)` chevrons, `+` past rank 3)
  on the tier/rank-tinted banner (gold / red-down / green→blue rainbow /
  green→deep-purple World Tree), a 4px left accent. Name color and cluster accent
  come straight from `stripTint`.
- **Effect lines** — one per effect: a humanized **label**
  (`ui.ts::effectLabel` — explicit map for the common combat/work/util enums,
  derived `<Element> Attack`/`<Element> Resistance` for the element families,
  and a humanized enum fallback so an effect is **never hidden**), a signed
  **value** (`formatEffectValue`: `%` for stat multipliers, bare `+N` for the
  count/level enums, and **omitted for flag effects** whose value is 0, e.g.
  Nocturnal / Toxic Gas Immunity — the label stands alone), and a quiet
  `(self)`/`(party)`/`(player)` **scope** annotation (`effectTarget`, omitted
  for `None`). The value is **neutral bright `ink`, not green/red**: the `+/-`
  sign carries direction and the banner carries good/bad valence, so a
  "lower is better" effect (SAN Loss −20% on a beneficial gold passive) never
  reads as a red penalty. Passives with no stat effects show a quiet "No stat
  effects" line.
- **Authored description** — the game's own text (`ink-faint`,
  `whitespace-pre-line`, under a `line-soft` divider) when the pack carries one;
  absent otherwise, never a placeholder.

### Partner-skill icon (`components/partner.tsx`)
`PartnerIcon {iconId, size}` renders the species' bundled partner glyph
(`public/partner/<textureId>.png`, via `assets.ts::partnerIconUrl`) as a
`rounded-md` `abyss` chip with a `line` ring; its padding **scales with `size`**
(`≈0.1·size` past 32px, `2px` below) so the tile reads the same tight glyph at
every scale. Left of the skill name in both the **detail** Partner-skill section
— a large **~96px** tile scaled to the section, the glyph filling it with
padding beside the multi-line `whitespace-pre-line` description — and the
**hover card** partner line (26px, `line-clamp-2`).
When `partner_skill_icon` is null (a bespoke texture not yet
resolved to a PNG) or the image fails, it degrades to a neutral inline-SVG
**bond glyph** (`assets.ts::PARTNER_FALLBACK_ICON`) — never a broken `<img>`.
