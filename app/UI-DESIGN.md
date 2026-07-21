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
- **Passives** — `passiveView()` parses the id into `{label, dir, tone, tier}`.
  `dir up` → good/green, `dir down` → bad/red, `Rare/Legend` → special/amber,
  else neutral. Direction is shown as ▲/▼ **and** color (never color alone).
  Tier digit → roman numeral (`ROMAN`). Tones in `PASSIVE_TONE`.
- **Sources** — Bred = amber tag; Owned = neutral tag + location; Wild = leaf
  tag with capture count.

## 6. Component patterns

Primitives live in `components/primitives.tsx`; compose them, don't reinvent.

- **PalIcon** `{id,name,size}` — cel-shaded portrait keyed by internal species
  id, `rounded-md`, 1px `line` ring, `abyss` backing, lazy, falls back to
  `UNKNOWN_ICON` on error. Roster 34px, tree 30px, autocomplete/inline 26px.
- **PassiveChip** `{id}` — 11px, `rounded-sm`, tone border+fill+text, ▲/▼ arrow,
  truncated label (`max-w-[14ch]`), tier roman, `title` = raw id.
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

### Element data (correction to §2)
The shipped pack (`crates/pal-data`, built from palcalc's `db.json`) carries **no
per-species element/type field** — only a global list of the 9 element
definitions. Element badges and an element filter are therefore *not* shipped in
round 2 (the assignment gated them on "if available in data"). The element
tokens in §2 remain reserved for when a game-file extractor adds per-species
types; until then the dex draws its categorical color from the cel-shaded pal
art itself, and uses **rarity**, **variant**, and **owned** as the real
categorical/graded signals. When element data lands, re-enable the element badge
(primary-type tint) and element filter here.

### Index (grid)
- Responsive card grid, `auto-fill minmax(184px, 1fr)`, `gap-2` — ~5 columns at
  1280, ~3 at 1024. Dense and scannable, like the table but icon-first.
- **Species card** = `panel` + `line`, `hover:border-amber/40 hover:bg-hover`,
  the whole card a focusable `<button>` (global amber focus ring). Top row: mono
  dex `#NNN` (zero-padded) + variant `B` glyph (`el-dragon`), and — when a save
  is loaded — an owned split `♂N`/`♀N` (water/dragon glyphs, §2 semantic colors).
  Body: PalIcon 44px + name + mono `rank NNNN` (combi rank).
- **Controls:** search (name/id/dex #); a segmented **sort** control (`raised`
  active = amber + ▲/▼) over Dex # · Name · Combi rank; `Owned only` (disabled +
  faint until a save loads) and `Hide variants` toggles.
- **Roster source strip:** a `raised/60` bar with a mono `ROSTER` label, save
  path input, Browse, and Load — reuses the shared save dir (§— App state) so a
  save loaded in Roster/Solver auto-annotates the dex on arrival.

### Detail
- Sticky back bar (`← All pals`) + `Pal-dex` eyebrow.
- **Header card:** PalIcon 96 (`rounded-lg`), mono `#NNN · Rarity R`, display-2xl
  name, combi rank, and a **gender-ratio bar** — a split `el-water`(♂) /
  `el-dragon`(♀) fill from `male_probability` with mono % labels. Primary CTA
  `Solve for this pal` (amber) jumps to the Solver pre-filled (shared state).
- **Panels** use one `Section` shell: `panel/40` + `line`, mono-eyebrow header on
  `raised` with an optional right-aligned mono stat/link. Sections: Base stats
  (4 mono stat wells), Guaranteed passives (`PassiveChip`s or empty line), **Your
  roster** (owned count + ♂/♀ split + best-IV bars via `ivBand`/`QUALITY_*`, with
  a `View in Roster →` link), and **Breeding**.
- **Breeding** is two panels: *reverse* ("How to breed this pal") lists parent
  pairs — total count in the header, first 12 as `icon+name × icon+name` cells,
  then "and X more pairs"; *forward* ("Breed with…") is a species autocomplete
  that resolves the child inline (`A + B → child`). Gender-locked combos, when
  the pack pins them, get their own panel.
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

### Species hover card (`<PalHoverCard speciesId>`)
A transient, paldb-inspired info panel that wraps any single trigger element and
attaches anywhere a species id is known (dex cards; every breeding parent /
child / gender-locked cell in the detail). It reads the game's **dark
info-panel** voice through our tokens:

- **Surface:** `bg-panel/95` (a slight, deliberate translucency — the nod to the
  game's translucent panel, *not* glassmorphism: no blur, no glow) over a `line`
  border and a dark `abyss/70` ring. Separation comes from the surface step +
  border + ring, per §4 — the one sanctioned floating overlay, still flat.
- **Layout:** header (PalIcon 40, display name, mono amber `#NNN`, rarity,
  `Variant`); an optional **partner-skill** row (mono eyebrow + amber-bright
  name, wraps, *omitted entirely when null* — the shipped pack has none yet); a
  **work-suitability** block (nonzero only, glyph + label + mono `Lv n`, two
  columns past six rows); and a footer with a 10-slot amber **food meter**, a
  `☾` **nocturnal** marker (`el-dark`), and the mono **wild-level** range
  (hidden when `(0,0)` = not wild-catchable).
- **Behavior:** opens ~250 ms after pointer-enter, positions itself with
  hand-rolled `fixed` + measured geometry (no portal lib), prefers the anchor's
  right and **flips left / clamps vertically** to stay in the viewport, never
  captures the pointer (`pointer-events: none`), and closes on leave, scroll, or
  resize. Species data comes from a module-cached `paldex_species` fetch, so the
  card is self-sufficient.
