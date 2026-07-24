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
  (teal border); `rank === 1` = **plain silver/white** (`neutral`, not gold);
  else (`rank 2–3`) = **gold** (`amber`). The cluster is the game's own masked
  rank-glyph texture (chevrons capped at 3, `+`/star fused in for rank 4/5).
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
- **PassiveStrip** `{id, size?}` — the in-game passive strip (name left, the
  game's masked rank-glyph texture right, tier/rank-tinted border+fill); `sm` for
  dense contexts
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

## 7. Signature element — the breeding plan

The breeding plan is the hero and the thing the app is remembered by. The
Solver results area offers **two renderers behind a `Graph | List` toggle**
(top-right of the tabs row, default **Graph**). Plans surface as a **tab row**
(`Plan 1`, `Plan 2`, … with a compact `Fastest` badge on the quickest); a slim
`raised` header under the tabs carries the active plan's big amber total time
then mono `steps · wild · cake` stats. The **List** view is the original
Lineage Ladder (below); the **Graph** view is the pannable breeding-bracket
flowchart (further below). (`TreeNode` + `PlanGraph` in the Solver;
`views/Solver.tsx` owns the tabs, toggle, and node-selection state.)

### List view — the Lineage Ladder

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
- **Wild / CATCH leaves** — a wild-caught source renders as a **catch step**,
  not a breed step. Same node chassis, but with an **`el-leaf` accent** (green
  border + `el-leaf/[0.06]` fill) — deliberately the leaf/green family, distinct
  from the amber bred-root tint and the neutral owned tag. Its right cluster is a
  mono-uppercase **`CATCH`** badge (`el-leaf`; `\u00d7N` appended only when more
  than one capture is needed to concentrate passives) plus a mono **`Lv N+`**
  pill sourced from the species' `min_wild_level` (omitted when `0`/unknown).
  **No odds pill and no step time** — a catch is a goal, not a breed. It is
  always a **leaf** (no children, no connector below it), like an owned pal.
  Read from the externally-tagged `source.Wild: {captures, min_wild_level}`.
- Owned leaves are terminal facts (neutral tag, 100%/instant).
- Each plan is wrapped in a container with a summary header: plan number,
  "Fastest" tag on the quickest, big amber total time, then mono stats
  (steps · wild · cake).
- **Source pool** control (solver form) — a stacked segmented control (the §6
  segmented treatment: active = `amber` on `raised`, muted `ink-faint`
  otherwise, each row led by a radio dot) toggling **Only pals I own** (default)
  vs **Include pals I don't own**. The second mode sets `include_wild: true` on
  the solve request and reveals a one-line `ink-faint` hint ("Plans may include
  pals you'd need to catch first."). It is what surfaces the CATCH leaves above.

### Graph view — the breeding bracket

The default renderer: a pannable / zoomable flowchart of one plan's tree
(`PlanGraph` in `components/plan-graph.tsx`; pure layout in
`plan-graph-layout.ts`). No graph/layout dependency — a hand-rolled recursive
tidy-tree over the strict binary plan tree (a bred node has exactly two parents;
leaves are Owned/Wild). Rendering is real DOM: HTML pal nodes absolutely
positioned inside a single CSS-transformed viewport (`translate(x,y) scale(k)`)
over **one SVG underlay** for the edges, so hover cards, focus, and click all
keep working.

- **Layout** — a left→right breeding bracket. Column x is a pure function of a
  node's depth from the root: **leaves in the leftmost columns, the target root
  rightmost** (`x = (maxDepth − depth)·COL_W`). Leaves claim sequential rows in
  traversal order; each bred node sits at the vertical **midpoint of its two
  parents**. Constants `COL_W 220`, `ROW_H 128`, node circle `R 34`. The
  degenerate single-node plan (owned/catch target, zero steps) renders as one
  centered node with no edges.
- **Pal nodes** — the circular Palbox **Slot idiom** (portrait clipped to a
  circle, gender dot), source-tinted ring: **neutral** owned, **amber** bred,
  **`el-leaf`** wild-catch, **amber (2px)** when selected. The plan payload
  carries no level/rank/alpha/instance, so — unlike the roster Slot — there is
  **no level pill** (nothing to fabricate); detail lives in the side panel.
  Below the circle: species name + the §7 status chip — `Owned · <location>`
  (neutral `Tag`), `Bred` (amber `Tag`), or the `CATCH`/`CATCH ×N` + `Lv N+`
  cluster (`el-leaf`) for a wild leaf. Species-only `PalHoverCard` on hover.
- **Junction chips** — one per breeding pair, on the convergence point midway
  between the two parent edges and the bred child (`x = child.x − COL_W/2`). A
  compact `panel`/`line` chip: egg glyph (amber) + the color-coded odds pill
  (§5 `probBand`) + mono step time (`formatDuration`). **All step math lives
  here, never on the pal nodes.**
- **Edges** — SVG underlay in the same transformed coordinate space. Each
  parent's right edge → horizontal-then-vertical cubic bezier → junction →
  child's left edge. Stroke is the subtle `line` token; the **junction→child**
  segment of a breed step carries the **`amber/70`** bred accent.
  `vector-effect: non-scaling-stroke` keeps hairlines crisp under zoom.
- **Interaction** — wheel **zooms to the cursor** (clamped `0.4–2.5`, native
  non-passive listener so page scroll is suppressed, cursor point stays fixed);
  a left-drag on the background **pans** past a **4px threshold**
  (`grab`/`grabbing` cursor); nodes `stopPropagation` on pointer-down so a click
  **selects** instead of panning. The view **fit-to-views on mount and on every
  plan switch** (bounding box + ~48px padding, centered). A bottom-right control
  cluster does **− / + / fit**. Nodes are `tabIndex=0` and **Enter/Space** select
  (keyboard a11y); **Escape** clears the selection.
- **Selection** — clicking a pal node lifts a `PlanNodeSelection` (the flattened
  plan-node fields; see §16) into `Solver.tsx`, which mounts the
  `PlanNodePanel` inspector on the right. Switching plans or re-solving clears
  the selection.

### Catching mode & the required-catches callout (Round 8)

When solving with **"Include pals I don't own"**, two surfaces govern and explain
how wild catches enter a plan (`views/Solver.tsx` only; backend policy in §15).

- **`CATCHING` control (left briefing).** A second segmented radiogroup directly
  under `SOURCE POOL`, sharing its exact anatomy (stacked full-width rows, leading
  dot, `bg-raised`+amber active, `role="radiogroup"`). **Rendered only when the
  pool is "Include pals I don't own"** — hidden for owned-only, where the policy
  is meaningless. Options: **`Breeding only`** (default) and **`Catching
  allowed`**, with a microcopy line describing the active mode (breeding-first
  auto-fallback vs. catches filling ingredient gaps). The `SOURCE POOL` microcopy
  is reworded to describe pool **scope** only. Selection rides the `solve` request
  as `catching: "breeding_only" | "allowed"` (only meaningful with `include_wild`).
- **Required-catches callout.** A slim `el-leaf`-tinted banner (`border-b
  border-el-leaf/25 bg-el-leaf/[0.06]`, mono uppercase eyebrow) for the **active
  plan**, rendered **once, below the plan tabs and above the stats header /
  canvas / cards** so it reads in **both Graph and List** views. Catches are
  derived **client-side** from the active plan's tree Wild leaves (`catchChips` in
  `Solver.tsx`): captures summed per species, the highest `min_wild_level` floor
  kept. Three states:
  - **Fallback** (`SolveResponse.fallback_used`): eyebrow `NEEDS CATCHING`, copy
    "No pure-breeding path from your pals — this plan needs catches:", then one
    chip per species — `[PalIcon] Name[ ×N] · Lv M+` in the shared `el-leaf`
    catch-chip style (mirrors the graph/ladder `CATCH`/`Lv N+` cluster).
  - **Catch-only** (a lone plan whose root is a 0-step Wild catch): eyebrow
    `CATCH ONLY`, copy "{Target} can't be bred from any other species — catch it
    in the wild (Lv N+)."; the single `CATCH` node still renders below.
  - **No banner** otherwise (active plan has no Wild leaves and `fallback_used` is
    false) — e.g. a normal `Catching allowed` plan whose catches already show as
    node badges and in the stats-header `N wild` count.

### Required-passives picker (`components/passive-picker.tsx`)

The left briefing's **Required passives** field is a **rarity-legible picker**,
not a bare `<datalist>`: it feeds only the passives a pal can roll (matching the
§12 browse split), each shown in its own tier/rank band so a user picks by
color. `PassivePicker {selected: string[], onAdd, onRemove}` owns its own
`list_passives` fetch and name↔entry map; the selected value stays the **frozen
`string[]` of passive NAMES** `runSolve` sends as `required_passives` (the
picker never touches that shape).

- **Filter.** Rows are `pal_facing === true` **and** not already selected —
  1905 raw passives (player/weapon/tech bloat, `en Text` junk) collapse to the
  **114 pal passives**. The old datalist fed all 1905.
- **Search input.** A `combobox` well (`bg-abyss`, amber focus) that opens the
  popover on focus/typing; typing filters by **case-insensitive substring on the
  name** (not effects — effect search stays a §12 browse affordance).
- **Row anatomy.** Each row is the §12 `PassiveStrip size="sm"` (full band:
  gold positive / silver neutral / red-down negative / green→blue **rainbow** /
  green→purple **worldtree** + pine glyph) over a one-line **dim effect gloss**
  (`ink-faint`, humanized labels + signed values, or the first description line
  for flag-only passives). Highlighted/hovered row lifts to `bg-hover`.
- **Sort.** Tier + high rank first (worldtree > rainbow > gold, penalties last),
  then alphabetical — the browse ordering, guaranteeing the special pools crown
  the list.
- **Popover.** Portaled to `<body>` (`position: fixed`, `z-70`) so the form
  column's overflow never clips it; anchored under the input, flipping above
  when the space below is tight, `max-height` capped with its own scroll. Mirrors
  the §10 hover-card portal escape. Outside-`mousedown` or Escape closes.
- **Keyboard.** ArrowDown/Up move the highlight (ArrowDown also opens),
  **Enter** adds the highlighted row, **Escape** closes; the highlight scrolls
  into view. Adding clears the query and re-focuses the input for rapid multi-add.
- **Selected chips.** Replace the old flat amber chips with **band-tinted chips**
  (`PassiveChipRemovable`, same `stripBand`/`stripTint`/`RankCluster` tokens as
  the strip): a compact pill in the passive's own tier color, name + `sm` rank
  cluster, and an integrated **× remove** carrying `aria-label="Remove {name}"`.

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
  - **Learnable moves** — the species' level-up learnable active skills
    (`learnset: {id, level}[]`, sorted ascending by level; pack ground-truth,
    DataRank-owned). Rendered directly under Work suitability, one row per move
    reusing the **`ActiveSkillRow`** strip (§— equipped actives: dark bar,
    element left-accent + right power segment, `CT Ns` chip, collapsible
    description button) in the same `grid-cols-1 sm:grid-cols-2` 2-column grid as
    the equipped-actives list. Each row carries a leading **`Lv N` condition
    chip** — mono, `bg-abyss/70`, matching the CT-chip treatment exactly — so the
    unlock level reads before the skill name (`Lv 1` for starter moves up through
    the species' top level). Header shows an `N moves` count. Rows resolve stats
    via the cached `list_active_skills` map (`lib/active-skills.ts`), falling back
    to the humanized name (no stats) for any id the map lacks — never a fabricated
    value. **Empty learnset omits the whole section** (no empty shell). The list
    runs 10–20+ rows for many species; it flows in the page's own scroller (no
    nested scroll trap). `ActiveSkillRow` gained one additive optional `level?`
    prop for the chip — equipped-skill call sites omit it and render unchanged.
  - **Guaranteed passives** (`PassiveChip`s or empty line) and **Your roster**
    (owned count + ♂/♀ split + best-IV bars via `ivBand`/`QUALITY_*`, with a
    `View in Roster →` link) share a two-column row.
- **Breeding** is two panels: *reverse* ("How to breed this pal") lists parent
  pairs — total count in the header, first 12 as `icon+name × icon+name` cells,
  then "and X more pairs"; *forward* ("Breed with…") is a species autocomplete
  that resolves the child inline (`A + B → child`). Gender-locked combos, when
  the pack pins them, get their own panel.
- **Omitted, never faked:** drops and tribes are **not** in the pack, so the
  detail page carries no section for them — no placeholders, no invented numbers.
  (Size class, movement/utility stats, and level-up learnable moves, once
  omitted, are now real ground-truth data and shown above.)
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
  marker (`alphaIconUrl`) when the pal is an Alpha (`isAlpha` = `is_boss` field-boss
  origin OR `is_lucky` IsRarePal instance; both +20% HP), **condensation** `★n` when `rank>0`,
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
  | **positive** | else (`rank 2–3`) | `amber` 52% | `amber` 17%→6% over abyss | `amber-bright` | `amber` |
  | **neutral** | `rank === 1` | `ink-dim` 42% | `ink-dim` 14%→5% over abyss (barely-there cool) | `ink` | `ink`×`ink-dim` (bright silver) |

  This mirrors paldb.cc: rank-4 legendaries a green→blue shimmer with a teal
  border, rank-5 World Tree green→deep-purple, rank-2/3 our gold — and **rank 1 a
  plain silver/white chevron, never gold** (matching the game's lone-chevron
  banner), so single-rank passives don't over-read as premium.
- **Icon cluster (`RankCluster {rank, band, size}`).** Right-edge anatomy,
  paldb's `[tree][rank-glyph]`: an optional **pine glyph** (World Tree tier only,
  `TreeGlyph`) + **one masked rank glyph** (`RankGlyph`) — the game's own 24px
  white-on-alpha texture (`assets.ts::passiveRankGlyphUrl`, `Passive_Positive_1..5`
  / `Passive_Negative_1..3`) painted as a **CSS mask over `currentColor`** so it
  tints per band and stays crisp at any size. The chevron stack (up positive /
  down negative) is **capped at 3 in the source**, with the **`+`** (rank 4) and
  **star** (rank 5) **fused into the texture** — so we draw ONE element, never a
  separate mark. Sizes ≈ **17px** `md` / **14px** `sm`. Rank 0 draws nothing.
- **Left accent.** A thicker left border rail (`sm` 2px / `md` 3px / card 4px)
  echoes the in-game strip's colored edge.

### Passive browse card (`components/passive-card.tsx`)
A **wide** card whose header **is** the strip look, sharing
`stripBand`/`stripTint`/`RankCluster` from the strip so rainbow/worldtree
passives read as special here too, over an unchanged structured body:
- **Banner header** — the passive **name** (`font-display`) + the rank **icon
  cluster** (pine glyph on World Tree, then the game's masked rank-glyph texture)
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

## 13. Round 4 — Equipped active-skill rows (`components/active-skill.tsx`)

The your-pal detail section's **Equipped active skills** are the in-game strip
from Palworld's Pal Stats screen, a sibling to the passive strip (§12) but tinted
by **element** instead of passive rank. `ActiveSkillRow {id, skill}` takes a
prefix-stripped waza id and its resolved {@link ActiveSkill} (`lib/active-skills.ts`:
`{name, element, power, cool_time, description}`, from the `list_active_skills`
command / `active-skills.json` fixture).

### Row anatomy
A block-level, full-width dark bar (`bg-raised`, `border-line`, `rounded-sm`,
`min-h-30px`) with a **3px element-colored left accent** (`--color-el-<key>`, or
`amber` when the element is unknown — the rail never disappears). The **name** is
pinned left (`font-display font-semibold`, `ink`), truncating. The right cluster,
right to left:
- **Element segment** — an element-tinted block
  (`color-mix(el 72%, abyss)`) carrying the flat **white in-game glyph**
  (`elementGlyphUrl`, white-on-alpha so it reads white on the tint; falls back to
  the full-color type tile) and the **power** numeral (`font-display font-bold
  tabular-nums`, `ink`). Shown only when the element resolves to a known type.
- **Cooldown chip** — a compact `bg-abyss/70` mono chip reading `CT Ns`
  (`font-mono tabular-nums`, `ink-dim`), left of the element segment.

### Description reveal
When the skill carries a description, the whole row is a **button**
(`aria-expanded`, `focus-visible` amber ring, hover lift) with a small caret
(`▸`→`▾`) beside the name; clicking toggles a **collapsible line under the row**
(`bg-abyss/40`, `border-line-soft`, `ink-dim`). Keyboard-reachable, no tooltip
that leaves the page. No description → the row is a plain non-interactive `div`
with no caret.

### Null-stat handling
Every stat is independently null-safe: **no element** hides the whole segment
(and its power numeral), **null power** shows the element glyph alone, **null
cool_time** hides the CT chip, **null description** makes the row static. An
**unknown id** (absent from the map) resolves via the humanizer to a stats-less
skill — a plain name row, name derived by stripping `Unique_<Species>_` and
title-casing camelCase/underscores. Never a raw id, never a fake number.

### Layout
`grid grid-cols-1 gap-1.5 sm:grid-cols-2` in the your-pal section — one column on
narrow, two on `>=sm` where the short rows stay legible side by side.

## 14. Round 5 — Partner-skill per-level values (`components/partner-value.tsx`)

Partner-skill descriptions now show the **actual per-rank numbers** instead of a
baked `(100~200)` range. The pack ships two additive fields per species
(`partner_skill_template: string|null`, `partner_skill_values: string[][]`); the
template carries `{0}`..`{N}` slots **only where a value varies across the five
partner-skill ranks** (constants stay literal in the text, units like `%`/`x`
stay in the template beside the slot). `partner_skill_values[slot][rank]` is the
display string per rank, ascending (rank 1 first). `partnerLevels(entry)` reads
both off any species entry/detail.

### Value token
Each slot renders as its **Lv 1 (first) value** in a quiet **water-element**
token (`text-el-water`, background `color-mix(--color-el-water 14%, transparent)`,
`rounded-sm px-1`, `font-mono`) — blue per the round brief, distinct from the
`ink-dim` body text but never shouty. Numeric, so it wears the mono face like
every other value in the app. Literal template text (newlines included) renders
under `white-space: pre-line`, so multi-line descriptions keep their breaks.

### Per-level tooltip (detail page)
Hovering (250ms delay, matching §10's hover card) or **focusing** the token
(keyboard focus opens immediately — a deliberate act) reveals a small fixed
tooltip: a mono `PER LEVEL` eyebrow over `Lv n — value` rows for every rank, the
current **Lv 1** row marked (water text + faint water tint). Placed below the
token, flipped above when it would overflow, clamped horizontally; dismissed on
scroll/resize. Fully keyboard-accessible — token is `tabIndex=0`, `role=button`,
`aria-describedby` the live tooltip, `Escape`/blur closes. Each slot owns its own
token and tooltip.

### Hover card (compact)
In the §10 pal hover card the tokens still highlight the Lv 1 value, but grow
**no tooltip** (`interactive={false}`): the card is itself a pointer-inert
tooltip, so a nested one would be unreachable and noisy. The partner line keeps
its `line-clamp-2`, so a token is visible only when its value falls within the
first two lines.

### Fallback (zero regression)
When `partner_skill_template` is null (the ~130 templateless species, and any
with no authored description) the original resolved `partner_skill_desc` renders
exactly as before — plain `whitespace-pre-line` `ink-dim` text, no tokens. Values
are never fabricated: the token set comes straight from the pack's rank tables.

## 15. Round 6 — Solver wild-pal seeding & catch-effort model (backend)

"Include pals I don't own" (`SolverConfig.include_wild`, default off; the Solver
form's toggle → Tauri `solve` `include_wild` param). When on, the search is
seeded with one hypothetical to-be-caught pal per **wild-spawnable** species
(`PalSpecies.wild_levels.0 > 0`), wildcard gender, no guaranteed passives beyond
the species' innate ones, random IVs. This is a data note, not a visual one — it
explains which plans the Lineage Ladder (§7) shows.

**Catch effort** (`refs.rs::catch_secs`, mirroring palcalc `PalReference` /
`GameConstants`): `CATCH_MIN_SECS(180) + rarity·30 + variant?300`, divided by the
wild random-passive probability `0.2·(num_random+1)` (palcalc
`PassivesWildAtMostN`). Palcalc scales catch time off the pal's sell price; our
pack carries none, so rarity is the documented stand-in. A gender-specific catch
multiplies by the captures needed to hit that gender (`1/genderProb`, rounded).

**Budget** (`SolverConfig.max_wild_pals`, default 10 — only consulted when
`include_wild` is set; owned-only forces it to 0). palcalc's UI default is a
conservative 1; we raise it because a same-species-only legendary (Jetragon,
Frostallion, …) breeds *exclusively* from a same-species pair, so any plan that
concentrates it needs ≥ 2 catches. Owned pals are always preferred at equal
effort (zero-effort owned refs dominate wild seeds of the same key).

**What the tree shows, and why.** A directly wild-catchable target (Jetragon,
`wild_levels 60–70`) resolves to a **single catch** — strictly cheaper than
catch-two-then-breed, so no chain. The multi-catch **catch→breed chain** appears
for targets that are *not* wild-catchable but *are* breedable from catchable
parents (e.g. Icelyn ← catch Mycora + catch Smokie → breed), where breeding is
the only route. Targets that are both non-catchable *and* same-species-only
breeders (raid/quest pals: Blazamut Ryu, Bellanoir, the Xeno line, …) stay
"no plan" even with wild on — they are genuinely unobtainable by catch+breed.
Wild plan nodes carry `source:{Wild:{captures,min_wild_level}}`; owned/bred node
shapes are unchanged.

**Catching modes (Round 8 — breeding-first policy).** The `solve` command grew a
`catching` param (`"breeding_only"` default | `"allowed"`, only meaningful when
`include_wild` is on) and now returns a `SolveResponse {plans, fallback_used}`
wrapper instead of a bare plan array. Orchestration lives in `pal_solver`
(`solve_with_catching` → `ModeResult`); the engine `solve` stays single-mode.
  - **`breeding_only`** runs an **owned-only pass first**; if it yields any plan
    those are returned untouched (`fallback_used=false`). Only when the target is
    unreachable owned-only does it rerun with wild seeding and return the
    catch-assisted plans with `fallback_used=true` (the UI's honest "no pure
    breeding path" callout). This is why a directly-catchable target like Anubis
    still shows its owned breeding chain first rather than a one-tap catch.
  - **`allowed`** is a single wild-enabled pass; catches fill ingredient gaps
    freely, `fallback_used` always false.
  - **Trivial-catch filter** (`results::filter_trivial_wild`, both modes): a plan
    whose root is a `Wild` source with `total_steps==0` (just catch the target)
    is **dropped whenever any other plan survives**, so real breeding chains are
    never buried under a 0-step catch. When such a catch is the *only* plan (a
    catchable same-species-only legendary with no owned pair, or a 1-wild-pal
    budget), it is returned as the sole plan and the UI renders the catch-only
    callout from it. The CLI mirrors all of this via `--catching breeding-only|allowed`.

## 16. Round 7 — Solver graph node inspector (`components/plan-node-panel.tsx`)

The Solver graph view (§7) pairs its pannable canvas with a **right-side node
inspector**: click any pal node and `PlanNodePanel` slides in as a fixed
`w-[340px]` column, `border-l border-line bg-panel`, full height, its **own
`overflow-auto` scroll container** so long passive lists never clip the canvas.
It reuses the pal-dex detail chassis — a `raised` eyebrow header, `Section`
blocks (mono `text-[10px]` uppercase eyebrow over a `panel/40` body), and the
shared `PalIcon` / `PassiveStrip` / `PalHoverCard` / `Tag` primitives — so the
panel reads as the same surface as everything else. Zero new tokens.

**Data honesty.** The panel shows only what a `PlanNode` actually carries
(`species_name`, `gender`, `passives`, `source`, `probability`,
`est_time_secs`). The solve payload has **no IVs, level, owner, or instance id**
for owned nodes — only `Owned:{location}` — so the panel never fabricates stat
bars; it presents each node's real fields and nothing more.

**Header.** A mono `text-amber` eyebrow (`Plan N · {bred|owned|wild} node`) with
a `line`-bordered close `×` button on the right. Focus moves to the close button
on open and whenever the selected node changes (keyboard lands somewhere
actionable); Escape is handled by the parent (§7), the button calls `onClose`.

**Identity row.** `PalIcon 56` (wrapped in `PalHoverCard` + a dex-nav button
when the species id resolved) beside the `font-display` name, the §2 gender
glyph (water ♂ / dragon ♀ / faint dash), and a **kind chip**: `Bred` amber `Tag`,
`Owned` neutral `Tag`, or the `el-leaf` `Catch ×N` chip matching the list
renderer.

**Per-kind body.**
- **Bred** — a *Breeding step* `Section` with the `probBand` odds pill in the
  header (same tinting as the tree card) and a fact list: `Odds` (band label +
  `%`) and `Est. time` (`formatDuration`).
- **Owned** — an *Owned pal* `Section`: `Location` (the `Owned.location` string)
  and a `good`-tinted "In your box — no breeding" ready note.
- **Wild** — a *Wild capture* `Section` with the `el-leaf` `Lv M+` pill in the
  header, `Catches ×N` + `Min level` facts, and the one-line microcopy
  "Catch in the wild at level M or higher."

**Passives (all kinds).** A *Passives* `Section` renders every passive as a `sm`
`PassiveStrip`; the `(random)` sentinel shows as the neutral "random roll" strip
(like the list renderer) and adds the note "One passive slot rolls at random
each time this pair breeds." An empty list reads "No passives carried."

**Dex action.** A footer "View in Pal-dex →" button (shown only when the species
id resolved) calls `onNavigateDex(species)`, reusing the shared `requestDex`
state path (§9) — the same navigation the palbox slots and dex cells use.

## 17. Wave 2 — Breeding Setup panel (`components/breeding-setup.tsx`)

A section in the Solver's left briefing, **below `CATCHING`**, that surfaces the
three farm knobs bending a plan's real-world time and composes them into the
shared `useBreedingSetup` store (`state.tsx`) the solve request and the IV Lab
both read. It is set apart by a `border-t border-line-soft` rule and the mono
amber eyebrow `BREEDING SETUP`, under a single honesty line: every value here is
an **estimate** from extracted game data.

- **Egg hatch time.** On save load the panel calls `get_world_options`. A scanned
  value renders as a big mono `Nh` in a `bg-abyss` well with an amber
  `SCANNED FROM WORLD` chip (dot + mono microcaps). A `null` result (dedicated
  server / no `WorldOption.sav`) becomes a mono numeric `hours per egg` input
  (default 72) with the microcopy "Dedicated servers keep this in
  PalWorldSettings.ini — enter your world's Egg Incubation setting." Either way it
  feeds `setup.egg_hatch_hours`.
- **Boosters.** One toggle row per effort-affecting booster **source**, from
  `list_breeding_boosts`. `alpha_egg_chance` sources are NOT toggles — they change
  no breeding effort — so they render at the list tail as read-only **info rows**
  (Broncherry, Broncherry Aqua) showing the display name, owned state, and a range
  like `+35–45% Alpha-egg chance`, plus one caption: raises the chance the hatched
  Pal is an Alpha (+20% HP, larger size), doesn't affect breeding steps or passives.
  For the real toggle rows, a source's effects toggle together (Babysitter carries
  both farm + incubation), so each row is one
  `role="switch"`: a `PalIcon` (partner) or an amber diamond **band** (passive),
  the display name, and a mono effect summary tinted `good` (idle) / `amber-bright`
  (on) — `-33% breed time` (farm speed as `1 − 1/(1+v)`), `-40% hatch time`
  (incubation), `+75% eggs` (extra-egg). Ownership comes from the loaded roster:
  partner sources match `character_id` (case-insensitive) and use the owner's best
  condensation rank; passive sources match any pal carrying the passive. **Unowned**
  rows are grayed (`opacity-55`), marked `not owned`, and stay toggleable as
  max-rank **what-ifs** (`N★ max` / `what-if`). Toggling composes fractions
  additively per effect into the store; a mono `APPLIED` line echoes the running
  total, and one line of microcopy warns that mixed-source stacking is untested
  in-game. The selected set persists in localStorage, but on a roster change any
  selected booster whose owned-state flipped is dropped (owned uses the real rank,
  unowned a max-rank what-if, so a silent switch would change its value) — the user
  re-toggles deliberately.
- **Cake.** The §6 stacked segmented control (leading dot, `bg-raised`+amber
  active, `role="radiogroup"`) over None / Mushroom / Vegetable / Deluxe Veg /
  Special (mapping to the `CakeToken`s), with the selected option's one-line effect
  note below (Vegetable → two eggs per cycle; Mushroom/Deluxe → +IV floor; Special
  → all passives inherit). Writes `cake` on the shared store.
- **Solve summary strip.** When the setup+cake are non-neutral, a slim
  `border-amber/20 bg-amber/[0.05]` band renders **once** below the plan tabs and
  above the stats header / canvas / cards (like the §8 catch callout, so it reads
  in **both Graph and List**): a mono `SETUP` eyebrow, the `describeSetup` parts
  joined with ` / ` (`-33% breed time / +60% eggs / 1h hatch / Vegetable cake`),
  and a trailing `· est.` — so a plan's time is always explainable. `describeSetup`
  / `isNeutralSetup` are shared by the panel's applied line and this strip.

## 18. Wave 2 — IV Lab (`views/IvLab.tsx`, `views/ivlab/donors.ts`)

A dedicated **stat-breeding** companion to the passive Solver, reached from a new
sidebar nav entry (`IV Lab` · `STAT BREEDING`, a three-slider mixer glyph). Same
`solve` backend and the same **read-only** `PlanGraph` + `PlanNodePanel` hero, but
the briefing is IV-shaped and the workspace is a **three-column lab bench**:
briefing · your stock · the plan.

### Layout

- **Left briefing** (`w-80`, `bg-panel`, the §6 form treatment shared with the
  Solver): target species well (the Solver's icon+`datalist` autocomplete),
  **Target IVs** (three sliders), Required passives (the §17-referenced
  `PassivePicker`, reused verbatim), Max steps, Breeding cake, an **Advanced**
  disclosure, then the amber Solve CTA.
- **Middle donors column** (`w-72`, `bg-panel/60`, `border-r`) — the **BEST
  DONORS** scan. Rendered only when a save is loaded **and** a target is set, so
  it never shows an empty rail.
- **Right results** (`flex-1`) — the plan tabs, the IV results header, and the
  `PlanGraph`/`PlanNodePanel` pair, or the empty/edge states.

### IV threshold sliders

Three native `range` inputs (`accent-amber`, `bg-line` track), one per breedable
talent (HP/ATK/DEF, 0–100). Each carries a mono value **chip**: `0` renders as
`any` in `ink-faint`; a set value renders in its §5 `ivBand` color
(`good`/`fair`/`ink-dim`/`ink-faint`). All-zero shows an inline `ink-faint` hint
("Set at least one stat floor above 0…") — the IV Lab optimizes for floors, so
all-zero is called out as a degenerate passive-only solve rather than blocked.

### Breeding cake + IV-floor note

A 5-cell grid (`None`/`Mushroom`/`Vegetable`/`Deluxe Veg`/`Special`) writing the
**shared** `cake` (`useBreedingSetup`, §17) — source of truth, so the Solver and
IV Lab always agree. Cake is **never** silently mutated: the note beneath adapts.
- **Floor-covered** (`good`): when the cake grants a +5 IV floor (Mushroom /
  Deluxe Veg — mirrors `CakeKind::iv_floor_bonus`) **and** any threshold is 1–5,
  "This cake guarantees a +5 IV floor, so your 1–5 thresholds are already covered
  — the solver drops them." (matches backend `apply_iv_floor`).
- **Suggestion**: when cake is `None` and any threshold is set, a one-click amber
  CTA "Mushroom adds a +5 IV floor — use it" writes `mushroom` explicitly (no
  surprise cross-view flip).
- **Generic** otherwise: a one-line reminder of each cake's effect.

### Advanced disclosure

A `line-soft`-topped `> ADVANCED` toggle (chevron rotates on open) reveals:
- **IV MODEL** — an `empirical | cdo` segmented control (§6) with honest
  microcopy: empirical = community-measured 50/25/25 (the safe default); cdo =
  game-data 50/33/17, "Unverified consumption — experimental." Rides the request
  as `iv_model`.
- **FARM SETUP** — a compact mono readout of the shared `setup`
  (farm speed / incubation / extra egg as `±N%`, hatch time as `Nh`). **Read-only
  here** — a `ink-faint` line points to the Solver's Breeding Setup panel (§17)
  as the editor; the value stays live via the shared store.

### BEST DONORS panel (`views/ivlab/donors.ts`)

The owned parents most worth breeding from. **Pool** = owned pals (excluding
humans) whose `character_id` is the target's internal id **or** appears in the
returned plans (each plan node's `species_name` → internal id via `nameToId` →
matched against owned `character_id`), so before a solve it's the target species,
after a solve it grows to the plan's kin. **Ranking** (`rankDonors`): four
buckets — **Top HP / ATK / DEF** (by that IV) and **Top overall** (by IV sum) —
each the best 3, ties broken by IV sum then level so a well-rounded pal outranks
a one-trick one. Each **donor row** is a clickable card (`hover:border-amber/40`):
`PalIcon 26`, display name + §2 gender glyph, `Lv N` mono, then the three IVs as
mono numerals with the **ranked stat highlighted** in its `ivBand` color (the
overall bucket highlights an amber `sum` instead). Click → `requestDex(character_id,
hexGuid(instance_id))`, the same dex navigation the roster slots use. No owned
stock → a single `ink-faint` "catch or breed one to seed the line" note.

### Results — IV-focused header

Plan tabs read `Line 1…` (a `Fastest` badge on the quickest). The active plan's
`raised` header leads with the big amber total time, then mono
**`~N eggs`** · steps · cake stats, and a right-aligned `ink-faint`
**`ESTIMATES · <model> IV MODEL`** footnote. Expected eggs is derived
client-side — `Σ round(1/probability)` over the plan's bred nodes (the geometric
eggs-to-success expectation, mirroring the solver's internal `num_eggs`, which
the frozen plan payload doesn't surface) — so it is always labelled an estimate.
The graph/inspector below are the untouched §7/§16 components.

### States

No save → the Solver's "Load a save…" hint (CTA disabled). Thresholds all 0 →
the inline set-a-floor hint (solve still allowed). No plan → "No line found"
with loosen-threshold / raise-steps / try-a-cake guidance. Pre-solve → an
"Engineer an IV line" invitation. All follow §8's guide-the-next-action voice.

## Wave A — Pal-dex deeper filters (`views/paldex/dex-filters.tsx`)

The dex index toolbar gains four deeper filters behind a single **FILTERS**
button + popover, so search / sort / element / owned stay on the first rows and
the toolbar never wraps into chaos at 1280. All new data was already served by
`paldex_species` (`work_suitability`, `stats.rarity`, `guaranteed_passives`,
`nocturnal`) — no backend or fixture change. Every value is a `--color-*` token.

- **FILTERS trigger.** A mono-microcap button (`\u25a4` glyph) matching the sort
  segment voice; **active-count badge** (amber pill, `text-abyss`) sums the
  selected deeper filters. Amber-tinted (`bg-amber/15`) while open or when any
  deeper filter is set. Popover: `absolute right-0` panel (`w-[344px]`, `panel`
  fill, `line` border, `z-50`), closed by outside-`mousedown` or **Escape** —
  same dismissal contract as the §-11 passive picker.
- **WORK.** A 6-col grid of the 12 work-suitability glyphs (`WorkGlyph`, greyed
  until picked, amber border when active). Each selected kind spawns a **min-level
  stepper** row (glyph + label + `\u2212 / Lv N / +`, clamped **1-5**). Semantics:
  **AND across kinds** — a species must clear every chosen kind's level (an
  `all required` hint appears past one kind). Filters on `work_suitability[i]` in
  `WORK_META` canonical order.
- **RARITY.** Four tier chips (Common / Rare / Epic / Legendary), each tinted
  with its own `--color-rarity-<key>` token when active (border + `color-mix`
  fill + text). **OR within the group.** Buckets via `lib/ui.ts::rarityTier(
  stats.rarity)` — the same helper the hover card and detail badge use.
- **GUARANTEED PASSIVE.** A compact, **data-derived** list (not the full solver
  picker): only the guaranteed passives actually present across the dataset,
  each rendered as a §-12 `PassiveStrip size="sm"` in its own tier band, in a
  scrolling `max-h-44` well, strongest rank first. Selecting rings the strip in
  `amber/60`. **OR within the group** — a species matches if any of its
  `guaranteed_passives` names is picked.
- **TIME.** A single **Nocturnal only** toggle (`\u263e` moon glyph, amber-active),
  matching the alpha-toggle chassis.
- **Composition.** Groups are **ANDed** with each other and with the existing
  search / element / owned / hide-variants filters (within-group semantics as
  above). The pure predicate is `matchesDexFilters(species, filters)`.
- **Clear.** A toolbar **CLEAR FILTERS** button appears whenever any filter
  (element, work, rarity, passive, night, owned, variants) is active and resets
  them all in one click; it also fronts the **empty state** ("No pals match the
  active filters. Loosen a level, tier, or passive." → CLEAR FILTERS), which
  generalizes the prior owned-only / no-match copy per §8.

## Wave A — Saved plans, compare & export (`components/plans-drawer.tsx`, `components/plan-export.ts`)

Plans become durable, comparable, and shareable. The solve results header
(§7) gains a right cluster next to the `Graph | List` toggle: **Save plan**,
**PNG**, **Copy code** (all the §6 secondary button — `raised`/`line`/`ink-dim`)
and **Plans** (amber-tinted `bg-amber/10 border-amber/40 text-amber`, the drawer
trigger). A transient `good` confirmation ("Plan saved", "PNG exported", "Plan
code copied") shows inline in the cluster for ~2.2s. All persistence is
client-side localStorage; nothing touches the backend.

- **Save plan.** Opens an inline **naming bar** below the plan tabs (mono
  `NAME THIS PLAN` label + a `bg-abyss` amber-focus input pre-filled with the
  default `"<Target> - <steps> steps - <time>"`, then amber **Save** / secondary
  **Cancel**; Enter commits, Escape cancels). Stores to `pal-calc.savedPlans`
  (frozen contract: `{id, name, created, saveDir, request, response, activePlan}`,
  cap 50). Eviction is **oldest default-named first, else oldest** — "unnamed" is
  inferred by re-deriving the default name, since the frozen shape has no flag.
- **PLANS drawer.** A right-slide panel (`fixed right-0`, `w-[400px]`, `panel`
  fill, `border-l`, `translate-x` in/out `duration-200 ease-out`) over an
  `abyss/60` backdrop; Escape or backdrop-click closes. Header = the standard
  mono `PLANS` eyebrow + `Saved plans` display title. Top: an **import-code**
  field (below). Then the saved list: each row is a compact card — compare
  **checkbox**, target `PalIcon 34`, name (inline-rename input on the pencil), a
  mono chip line (`amber` time · steps · `el-leaf` wild · relative time), a
  `warn` triangle glyph when `saveDir` differs from the live save, and a
  **Load** (amber) / rename / delete action row. Empty state follows §8's
  guide-the-next-action voice.
- **Load.** Rehydrates the saved `plans`/`activePlan` into the view exactly as a
  live solve (via `useSolve.rehydrate`, which carries the saved tab across the
  reset-to-0 effect on a ref), and raises an **amber staleness banner** at the
  top of results: `SAVED <date>` eyebrow + "Loaded from "<name>" — your roster
  may have changed since. Re-solve for a fresh plan." It clears on the next live
  solve (honesty rule: saved trees may be stale against the current roster).
- **Compare.** Selecting **exactly two** checkboxes opens a **stat comparison**
  panel in the drawer (dual-graph rendering intentionally NOT shipped — kept to a
  scannable table): a `[label | A | B]` grid of **Time / Steps / Wild / Overall
  odds** (overall = product of breed-step probabilities), the **better value per
  row tinted `good`** (lower time/steps/wild, higher odds), plus each plan's
  **per-step odds chain** as §5 `probBand` pills. **No winner is declared** — a
  footnote states the tinting rule and that a faster plan may carry worse odds;
  the user judges.
- **Export — PNG.** A **hand-rolled canvas serializer** (`renderPlanPng`), not a
  DOM/SVG scrape and **no dependency**: it re-renders the plan onto a fresh 2x
  canvas from the *same* `plan-graph-layout` geometry the live graph uses, so the
  bracket is identical but taint-free (external pal PNGs `drawImage`'d after
  preload, `document.fonts.ready` awaited for the self-hosted faces). The frame
  bakes the `abyss` background, a `font-display` amber **target header** + mono
  stat subline, and a `PAL-CALC` watermark. Edges use the `line`/`amber-70`
  tokens, junction chips the §5 odds colors, nodes the source-tinted rings and
  status chips — one consistent read with the on-screen graph. Saved via a
  download anchor (`pal-calc-<slug>.png`), which the Tauri webview's download
  handler also honors.
- **Export — plan code.** **Copy code** writes a base64url `{request, planIdx}`
  to the clipboard; the drawer's **Import** field decodes it and **re-solves via
  the normal solve path** (not a frozen-tree paste), so a shared plan reflects
  the importer's *own* current save — honest over stale. A malformed code shows a
  friendly `bad`-toned inline error.

## Wave A — Pinned parents & the breeding queue (`components/pin-picker.tsx`, `components/queue-panel.tsx`, `views/Solver.tsx`)

Two Solver-only briefing extensions that ride the frozen `SolveRequest`. Both
are client-state + localStorage; the pins field flows to the backend verbatim,
the queue drives the `solve_queue` command.

### Pin parents (below REQUIRED PASSIVES)

Rendered **only when a save is loaded and a target is set** (meaningless
otherwise). A mono-microcap `PIN PARENTS` label over a compact `+ Pin a parent…`
affordance (§6 input well — `bg-abyss`/`line`, amber-focus).

- **Popover.** An **anchored** panel (`absolute` under the affordance, `panel`
  fill, `line` border, `max-h-72`) — deliberately not a modal (§AI-slop: "modals
  for everything"). A `bg-abyss` search input filters the owned roster live by
  **name / nickname / species**. Each row: `PalIcon 26`, display name (**nickname
  italic** when present, else species), the §5 gender glyph, then a mono meta line
  — `Lv N`, the three IVs **tinted by `ivBand`** (`QUALITY_TEXT`), and a passive
  count (`Np`). Clicking a row pins that exact instance; the row then renders
  **disabled** (already pinned). Closes on outside-click or Escape.
- **Chips.** Pinned instances render below as amber pills (`amber/10`,
  `border-amber/40`): `PalIcon 16` + name (nickname italic) + mono `Lv N` + an
  `×` remove (aria-label **Remove**). Distinct from the neutral passive tags.
- **Cap: 4.** Solver pairs are binary trees, so more pins is nonsense. At cap the
  affordance disables and reads `Max 4 pins`, with an `ink-faint` hint ("Pin cap
  reached — remove one to pin a different parent.").
- **Wire-through.** The pins are the verbatim `OwnedPal.instance_id` arrays
  (`Guid[]`); the Solver passes them as `SolveRequest.pinned_parents` inside its
  built spec — no reshaping. Saved-plan and imported requests carry pins through
  the drawer for free (it stores the whole request).
- **Pins-unsatisfied banner.** When a response has `pins_satisfied === false`
  (pins eliminated every plan; `plans` is empty), a `warn`-toned banner
  (`border-warn/30 bg-warn/[0.08]`, mono `PINS UNSATISFIED` eyebrow) renders
  **above the empty state**: "No plan uses all pinned parents — unpin or raise
  Max steps." Shared verbatim by the single-solve empty state and any
  no-plan queue item.

### Breeding queue (form tail)

A **collapsible** section under the solve button, headed by the mono-microcap
`BREEDING QUEUE` (§4 chevron rotates on open) + a count badge.

- **Add current target to queue** (§6 secondary) snapshots the **current full
  spec** — target / passives / max-steps / source pool / catching / pins — by
  reusing the same `buildSpec` a single solve sends. The shared setup/cake are
  **not** frozen in; they inject at queue-solve time, so a re-solve always uses
  the live BREEDING SETUP.
- **Queue rows.** An ordered list; each row: index, `PalIcon 22` + target name,
  a mono chip line (`Np` passives, an amber `N pins` chip when pinned, `N steps`),
  a stacked ▲/▼ **reorder** pair (disabled at the list edge), and an `×` remove.
- **Solve queue (N)** — the amber CTA (§6 primary) → `solve_queue` with
  `stop_on_failure=false`. Busy state reads "Solving queue…".
- **Persistence.** The queue writes to `pal-calc.solverQueue` and survives
  restarts. Entries store the **request only** (never a frozen result), so
  solving is always an honest re-solve against the live save.

### Queue results view (replaces single-solve results)

When a queue is solved, `queueResult` flips the results pane from the single
plan to the queue view (single-solve state is left untouched underneath).

- **Combined header.** A `panel` bar: mono `QUEUE` eyebrow · `combined ~<time>`
  (amber total from `combined_effort_secs`, honestly an estimate) · `N targets`,
  with an `ml-auto` **← Back to single solve** (§6 secondary) that clears the
  queue result.
- **Seeding note.** A quiet `ink-faint` line under the header — "Each target's
  plan assumes the previous targets were bred first." — the honesty caption for
  the left-to-right pool seeding.
- **Per-item accordion.** One `panel`/`line` card per target. The `raised` header
  row: chevron, index, `PalIcon 26` + target name, then a right-aligned **status
  chip** — `plans[0]` time (amber) · `NO PLAN` (faint) · `NEEDS CATCHING`
  (`el-leaf`, on `fallback_used`) · `PINS UNSATISFIED` (`bad`), in precedence
  order pins → no-plan → catching → time. Expanding a solved item mounts the
  **shared `PlanResults`** (extracted from the single-solve view) at a fixed
  height — its own plan tabs, `Graph | List` toggle, catch callout, setup banner,
  and `PlanGraph` + node inspector, identical to single results. A no-plan item
  expands to the pins-unsatisfied banner or a plain "no chain" note.

### Dev fixture (`dev-fixtures/solve-queue.json`)

Browser dev mode (no backend) routes `solve_queue` through the static fixture in
`lib/tauri.ts` (a code-split JSON in the `simple` command map, mirroring `solve`).
Two items over existing fixture species: **Anubis** carries the full
`solve-result.json` plans (demoing an expandable multi-tab item); **Mycora** has
empty `plans` + `pins_satisfied:false` (demoing the `PINS UNSATISFIED` status
chip and the shared banner). `combined_effort_secs` sums the best-plan effort.

## Wave B — Solve progress, cancel & reset (`components/solve-progress.tsx`, `lib/use-solve.ts`, `views/Solver.tsx`)

While a solve or queue-solve is in flight the results pane is replaced by the
**in-flight panel** — an honest, live readout of the solver's own
`solve-progress` event stream — with a **CANCEL** escape hatch. The solver form
header also gains a **RESET** affordance that clears the current *query* without
disturbing the *farm*.

### In-flight panel anatomy (`SolveProgress`)

A single `panel`/`line` card (`rounded-lg`, `m-6 p-5`) — the §6 raised-surface
treatment, one **amber** accent, **mono** labels, matching the SETUP strip and
queue-header voice. No spinner, no glow, no second color. Top to bottom:

- **Queue line** (queue mode only) — `QUEUE` mono eyebrow (amber) +
  `Target {i+1} of {n} — {name}` from `queue_index`/`queue_len` (the target name
  is passed in from the Solver's live queue specs, not the event).
- **Phase line** — a pulsing amber dot + a `font-display` phrase mapped from the
  contract's four phases: `Seeding working set…` / `Breeding step 2 of 5` /
  `Retrying with catching allowed…` / `Finalizing plans…`. Right-aligned on the
  same row: the **elapsed timer** (`0:03`), ticking client-side on a 100ms
  interval but resynced to each event's authoritative `elapsed_ms` so it never
  drifts.
- **Progress bar** — the current **step's** pair batch. During phase `step`
  (`pairs_total > 0`): an amber fill whose width animates
  (`transition-[width] duration-200 ease-out`) to `pairs_done / pairs_total`.
  During seeding/finalizing (no pair batch to measure): an **indeterminate**
  pulsing `amber/40` bar — never a fake percentage.
- **Counts + rate** — under the bar, mono `tabular-nums`:
  `1.4M / 3.2M pairs · 210k pairs/s`. Counts humanized (k/M/B); the rate is
  computed from **event deltas within the same step** (a step boundary rebaselines
  rather than reporting a negative), lightly EMA-smoothed so it doesn't jitter.
- **Remaining estimate** — right of the counts, the honesty centerpiece (below).
- **Working set** — a subtle `working set: N` stat (humanized), and the
  danger-outline **Cancel** button on the same row.

### Honesty rule for estimates

The panel shows a remaining estimate for the **current step only**
(`~Ns left in this step`, or `step est.…` before a rate is known) — derived from
`(pairs_total − pairs_done) / rate`. It **never** fabricates a total-solve ETA:
cross-step working-set sizes are unknowable in advance, so any whole-solve
countdown would be a guess dressed as a fact. The elapsed timer is real;
the only forward-looking number is scoped to the batch we can actually measure.

### Cancel semantics

Each solve/queue mints a monotonic **generation token** (`use-solve`), which (a)
rides the request as `progress_token`, (b) tags every emitted event so the hook
**filters stale generations** (a superseded solve's late events are dropped), and
(c) is the cancel handle. **Cancel** calls `cancel_solve(token)`; the backend
resolves the in-flight solve to `Err("cancelled")`, which the hook recognizes and
treats as a **quiet return to idle** — no error banner, just a small
`Solve cancelled.` inline note (`raised` surface, `ink-dim`) until the next solve.
The `solve-progress` listener is unsubscribed on every settle (success, error, or
cancel). In browser dev (fixture mode, no backend) `lib/tauri.ts` synthesizes the
event stream — seeding → steps 1..3 with pairs ramping → finalizing over ~3s,
delaying the fixture resolve behind it — and honors `cancel_solve`, so the whole
panel and cancel path are reviewable in the screenshot loop. This is gated
strictly on fixture-mode detection and never affects real mode.

### Reset scope

The header **RESET** (subtle ghost button, top-right of the SOLVER eyebrow,
away from Solve to avoid misclicks; keyboard-reachable; `hover`/`focus` tint to
`bad`) is confirm-free and clears the current **query**: target species, required
passives, pinned parents, plans/queue results + restored/naming bar, and restores
`max steps → 5`, `source pool → Only pals I own`, `catching → breeding only`. It
deliberately **keeps** everything that describes the *farm* rather than this one
query: the whole BREEDING SETUP (boosters / cake / hatch time) and the saved
BREEDING QUEUE item list. The results half of the reset lives in
`useSolve().reset()` (shared with the save-switch invalidation); the form half
lives in the view.

## Wave B — IV Lab ⇄ Solver parity (`views/IvLab.tsx`, `components/plan-actions.tsx`)

The IV Lab is the stat-breeding companion to the passive Solver; both fire the
same `solve` backend through `useSolve()` and render the same `PlanGraph`. This
wave brought the IV Lab to full result-side parity with the Solver so a plan is
equally actionable from either view — same in-flight panel, same RESET, same
save/export/plans cluster, same owned-instance hover — without duplicating the
logic across the two views.

### Shared plan-actions cluster (`usePlanActions`)

The single-solve results-header cluster — **Save plan** (with its inline naming
bar), **PNG** export, **Copy code**, the **PLANS** drawer, and the "loaded from a
saved plan" **staleness banner** — was extracted verbatim from the Solver into
`components/plan-actions.tsx` as the `usePlanActions` hook, so the two views can't
drift. It drives the view-agnostic saved-plan store (`plans-drawer`) and
plan-export codec; only the briefing form a loaded/imported request is applied
back into differs, supplied by each view as an `applyRequestToForm` callback.
The hook returns three placement slots because the pieces live in three spots of
a results pane: `headerButtons` (the plan-tabs row's right slot), `banners`
(staleness + naming bar, above the plan results), and `drawer` (mounted once at
the section end). A `closeNaming()` handle lets a view RESET dismiss the naming
bar so the next solve starts clean. The Solver's DOM/classes are unchanged by the
extraction — the same markup, now sourced from the hook.

### In-flight panel & cancel

While solving, the IV Lab replaces its results area with the same
`SolveProgress` panel and quiet `Solve cancelled.` note as the Solver (§ In-flight
panel / Cancel semantics above) — `useSolve` already mints the token and listens,
so this is a render branch, not new wiring. The IV Lab has no breeding queue, so
it passes no `queueTargets` (single-solve mode only).

### Reset scope (IV-shaped)

The header **RESET** matches the Solver's affordance (subtle ghost button,
top-right of the IV LAB eyebrow, `hover`/`focus` tint to `bad`, confirm-free) but
its query differs: it clears the **target species**, the three **IV floor
thresholds → 0/0/0**, **required passives**, **`max steps → 5`**, and the
plans/restored/naming state (`useSolve().reset()`). It deliberately **keeps**
everything that describes the *farm* rather than this one query — the shared
BREEDING SETUP and **cake** (both live in `useBreedingSetup`, shared with the
Solver) and the **IV model** — so a reset never disturbs the Solver's farm state.

### Donor instance hover

Each **BEST DONORS** row is wrapped in the owned-instance `PalHoverCard`
(`<PalHoverCard speciesId={pal.character_id} pal={pal}>`), so hovering a candidate
parent surfaces its full per-instance card — level, gender, alpha, quality-colored
**IV bars**, and passive strips — above the species sections. Donors already hold
the `OwnedPal`, so the object is passed directly; no instance lookup is needed.

## Palbox polish round (`views/SaveInspector.tsx`, `components/palbox/*`)

A review-driven polish pass over the Palbox surface (dev fixture mode, screenshot
loop at 1280 and 1600). Every change is visual/interaction-level — no data-flow,
selector, or payload edits.

### Audit findings

| # | Issue | Severity | Disposition |
|---|-------|----------|-------------|
| 1 | Slots carried `outline-none`, which overrode the global `:focus-visible` amber ring — Tab-focusing a box/party/base slot showed **no** focus indicator (keyboard focus invisible). | High (a11y) | **Fixed** |
| 2 | Physical palbox always opened on **Box 1**; when a player's pals sit only in later boxes (sparse `slot_index`), the view loaded onto a field of empty dashed slots and looked broken. | Medium | **Fixed** |
| 3 | No-match empty states (grid + list) were dead-ends — bare "No pals match your filters." with no one-click escape, unlike the Pal-dex which offers **Clear filters**. | Medium | **Fixed** |
| 4 | Slot `PalHoverCard` never passes the optional `location` line, so the card doesn't label a slot as Party/Palbox/Base. | Low | **Left** — additive nice-to-have; `pal-hover-card.tsx` is owned by the hover-unification work, out of this slice's file scope. |
| 5 | Fluid slots balloon to the 160px clamp on wide screens (1600), so a lightly-filled box reads as a large sparse field. | Low (taste) | **Left** — the fluid "fill the viewport / grow on wider screens" sizing is a deliberate prior decision; reducing the clamp contradicts documented intent. |
| 6 | Players with no party show five large empty dashed circles in the party rail. | Low | **Left** — the rail intentionally always renders `PARTY_SIZE` fixed slots (mirrors the in-game screen); a conditional hint would break that 1:1 mapping. |
| 7 | Header mode toggle "Palbox / List" and the surface toggle "Palbox / Dimensional" both say "Palbox". | Low (copy) | **Left** — "Palbox" is the established name for the grid view; renaming risks churn against the PALBOX-PLAN vocabulary. |
| 8 | Wheel over the grid should not scroll the page. | — | **Not an issue** — the document is non-scrollable (`h-full` shell); only the inner `overflow-auto` scrolls, so there is nothing to leak into. |
| 9 | Hover card near the right viewport edge. | — | **Not an issue** — `PalHoverCard` already portals to `<body>`, measures, and flips left; verified on a right-edge boxed slot. |

### What was fixed

1. **Focus-visible on slots** (`components/palbox/slot.tsx`). Dropped `outline-none`
   from the slot `<button>` so the app-wide `:focus-visible` rule (2px amber
   outline, 2px offset, follows the circular `rounded-full`) applies. Keyboard Tab
   now paints a circular amber ring; mouse focus stays ring-free via the base
   `:focus:not(:focus-visible)` rule. The inset amber **selection** ring
   (`ring-2 ring-amber`, driven by the arrow-key cursor) and the outset amber
   **focus** outline are visually distinct and coexist.
2. **Land on the first populated box** (`views/SaveInspector.tsx`). The paging
   reset now seeks the first box that actually holds a pal
   (`pages.findIndex(pg => pg.some(c => c.pal))`) instead of hard-resetting to 0.
   Compact/dimensional pages are gap-free so this is box 0 there; physical layout
   skips leading empty boxes (e.g. opens on "Box 13 / 20" for a player whose pals
   live in later boxes). No-op when box 1 is already populated.
3. **Clear-filters escape** (`components/palbox/surfaces.tsx` `BoxGrid`,
   `views/SaveInspector.tsx` list branch). Both no-match empty states now render a
   **Clear filters** button (same styling as the Pal-dex empty state) when a query
   is active; it resets search + element/gender/alpha/passive filters via
   `patchQuery` while keeping the sort. `BoxGrid` gained an optional `onClear` prop
   (undefined ⇒ button hidden, e.g. the genuinely-empty "no boxed pals" case).

## Wave — Pal-dex MOVES reference (`views/paldex/moves-view.tsx`, `lib/learnset-index.ts`)

A third Pal-dex browser beside the species grid and passive grid: the paldb-style
**active-skills reference**, cross-linked both ways with the dex. Composes
existing primitives end to end — the `ActiveSkillRow` strip (§13), the element
filter (§9 index), the sort control (§6) — and adds one small reverse-index
helper. No new Rust: everything reads commands the dex already serves.

### Section switcher (extends §12 `components/dex-tabs.tsx`)

`DexTabs` grows a third tab so the control reads `[Pals | Passives | Moves]`,
same segmented treatment (active = amber on `raised`). `views/Paldex.tsx` routes
`tab === "moves"` to `MovesIndex`; PALS stays the default and is untouched. The
existing one-shot `dexTarget` consume still snaps back to PALS (a species target
is never a move), so the MOVES tab is only ever reached by the switcher or a
detail cross-link (below).

### Moves index

- **Data source:** `list_active_skills` (the same `id → {name, element, power,
  cool_time, description}` map the detail view resolves equipped/learnable skills
  against, loaded once via the module-cached `loadActiveSkills`). All 332 skills
  list; each row is an `ActiveSkillRow` **verbatim** (§13), so the element-tinted
  left rail, right-pinned element/power segment, `CT Ns` chip, and collapsible
  description read identically to the detail's ACTIVE SKILLS rows. Rows stack
  single-column in a `max-w-3xl` centered column (expansion makes a multi-column
  grid awkward).
- **Filters:** the §9 element chip row (9 canonical types, `ElementIcon`,
  grayscale→color on select, OR semantics) + a name/effect text search (matches
  name, id, or description) + a `Power | Cooldown | Name` sort control (§6). Power
  defaults strongest-first, name/cooldown ascending; re-click toggles direction.
  Nullable stats (non-damage / no-cooldown skills) always sort **last** regardless
  of direction, so meaningful values lead. Count reads `N moves` or `N of 332`
  when filtered; both no-match and no-data empty states offer a **Clear filters**
  escape (matching the dex index).

### Learned-by list + reverse index (`lib/learnset-index.ts`)

Learnsets live **only** in the per-species detail payload
(`paldex_species_detail → SpeciesDetail.learnset: {id, level}[]`), never in the
lightweight grid rows, and there is no bulk command (Rust out of scope). So
`loadLearnerIndex(species)` fans the detail fetch across every species **once**,
concurrently, and caches the built `Map<wazaId, {species, level}[]>` module-wide:
the MOVES tab pays a single up-front cost the first time it opens (instant in
fixture mode — every detail is bundled), then every row reads the map for free.
One learner per species per move at its **lowest** level; each move's learners
sort by level then name.

Per move (when it has learners) an expandable **`LEARNED BY N`** disclosure (mono
microcap toggle with the §13 caret) reveals an `auto-fill minmax(158px)` grid of
learner chips — `PalIcon` + truncated name + a mono **`Lv N`** chip (the §13 chip
treatment). Clicking a chip navigates to that species' dex detail (the same
in-dex `navigate` the parent/child cells use; back returns to MOVES).

### Cross-link back (extends §13 `ActiveSkillRow`)

`ActiveSkillRow` gains one **optional, backward-compatible** prop `onOpenMove`;
the detail's LEARNABLE MOVES rows pass it so each move **name becomes a link**
(hover amber + underline) that jumps to the MOVES tab focused on that skill. In
that mode the row is a plain div and the description caret is its own sibling
button (never nested); every existing call site omits the prop and renders
exactly as before. On arrival `MovesIndex` clears filters so the target is
guaranteed visible, auto-expands its learners, scrolls it to center, and flashes
a brief **amber ring** (`ring-1 ring-amber`, ~2s). The scroll is deferred past
layout (keyed on the async move-list load) so a link armed before the list
resolves still lands.

## Wave — App-wide player scoping (`state.tsx`, `App.tsx`, `lib/use-solve.ts`, `solver.rs`)

A shared save can hold several players' pals (the real save: 1669 pals across 4
players + 76 null-owner base/guild-stock pals). **Player scope** narrows the
whole app to one player's pals so the solver, IV-Lab donors, and Pal-dex owned
counts speak for a single person instead of the whole world.

### State + persistence

`AppState` gains `playerScope: string` — a lowercase 32-char player-uid hex, or
`"all"`. It is persisted **per save dir** under the localStorage map
`pal-calc.playerScope` (`canonDir -> scope`, the same canon as the recent-saves
list), so each world remembers who you play it as. Default `"all"` — behavior
identical to no scoping. Switching or clearing a save resets the live scope; a
silent watcher reload keeps it.

### The prompt (extends the §modal patterns)

On the first load of a **multi-player** world with no persisted choice, a
`ScopeModal` auto-opens: an amber **`PLAYER SCOPE`** eyebrow over **"Who plays
this world?"**, then one row per player — name, short uid hex (`uid.slice(0,8)`,
mono microcap), and that player's **owned-pal count** — plus an **All players**
row carrying the full pal count. The active scope's row is amber-tinted
(`border-amber/50 bg-amber/10`). Picking a row persists + closes. Single-player
worlds (and any world with a stored scope) never prompt.

### The scope pill (sidebar save chip)

Under the save-name chip, a mono pill **`SCOPE: <name>`** / **`SCOPE: All`**
(only shown when the world has >1 player) reopens the `ScopeModal` on click. The
`SCOPE:` prefix is uppercased; the player name renders normal-case so
`ThatOneChad` stays legible.

### Filter semantics (frontend + backend agree)

- **Backend** (`solver.rs`): `SolveRequest` gains `player_uid?: Guid`
  (`#[serde(default)]`). `scope_owned(&save.pals, uid)` restricts the owned pool
  to `owner_player_uid == Some(uid)` before solving (both `run` and the queue,
  which scopes once for the whole run). **Null-owner pals are excluded under a
  scope** — they are base-camp worker / guild-stock records that belong to no
  individual player (the 76 Base-container pals in the real save). `None` uid =
  every player (borrowed, zero-copy). The Solver pin-picker + queue seeding
  inherit this automatically.
- **Frontend**: `use-solve` injects `player_uid` (hex → 16-byte array via
  `hexToGuid`) into every outgoing solve/queue request at the single assembly
  point when scope ≠ `"all"`. The scoped `roster` memo (`state.tsx`) drops
  non-matching + null-owner pals, shrinking every Pal-dex owned count. IV-Lab
  donors filter the same way before `rankDonors`. Under `"all"` no `player_uid`
  rides and nothing is filtered — byte-for-byte the pre-scope behavior.

## Wave — Breed-step hover card (`components/breed-hover.tsx`, `components/plan-graph.tsx`)

The plan-graph egg-junction chip (odds pill + step time between two parents and
their bred child) gains a rich hover briefing — the "what does this one breed
step actually take" card — via the new `BreedHoverCard`. It reuses
`pal-hover-card`'s positioning machinery verbatim: a `position: fixed`, measured,
viewport-edge-flipping card **portaled to `document.body`** so it escapes the
plan-graph `translate+scale` containing block (a fixed element resolves against
the nearest transformed ancestor, not the viewport — an inline card would offset
by the canvas transform). 250 ms open delay, `pointer-events: none`, closes on
scroll/resize, `z-index` 60.

### The junction chip is now a trigger

The chip becomes focusable (`role="button"`, `tabIndex=0`, a descriptive
`aria-label`, `cursor-help`, amber `focus-visible:ring-2`). `BreedHoverCard`
clones it and wires **both** hover (`onPointerEnter`/`Leave`) **and** keyboard
(`onFocus`/`onBlur`) to the same delayed open/close, so tabbing to a step opens
the card exactly like hovering it. The chip keeps its `onPointerDown`
stop-propagation so a click never starts a background pan.

### Anatomy (top → bottom)

- **Header** — amber egg glyph + `BREED STEP` microcap, then
  `parentA × parentB → child` (parents from the bred node's two `children`).
- **Odds per egg** — the per-egg success split `passives N% · IVs M% · = Z%`
  from `prob_passives` / `prob_ivs` / `probability` (`probability` is exactly
  `prob_passives * prob_ivs`; the combined `= Z%` is `probBand`-tinted like the
  chip). Legacy plans without the factors show only `= Z%`.
- **Step** — `~N eggs · time/egg · total` where eggs = `expected_eggs` (the
  engine's authoritative per-node breeding count, not `ceil(1/prob)`) and
  time/egg = `est_time_secs / expected_eggs` (`est_time_secs` is this node's own
  self-effort, not cumulative). When `expected_eggs` is absent, only the honest
  `<total> total` step time is shown (no fabricated egg count).
- **IV gate** — shown only when any `iv_targets` stat is nonzero: one row per
  constrained stat `HP ≥ 40` with an `ivBand`-tinted `QUALITY_FILL` bar (the
  instance-card IV-bar idiom). The "minimum IVs you must carry before continuing
  the chain" ask.
- **Passive pool** — the parents' combined, de-duped passive pool as
  `PassiveStrip` rows. **Owned** parents resolve their *real* passives from the
  live save via `usePalByInstance` (the `instance_id` now in the plan payload);
  **bred** parents (and synthetic/legacy/unresolved ones) fall back to the
  node's own passives. The child's must-inherit passives (its non-`(random)`
  passives) get an amber ring, and — when `prob_passives` is present and at
  least one is highlighted — an `these must all pass: N% per egg` line sits
  under the pool.

### Degradation matrix

Every field beyond `probability`/`est_time_secs` is an optional StepData
addition (`prob_passives`, `prob_ivs`, `expected_eggs`, `iv_targets`), absent on
owned/wild nodes and on legacy `localStorage` plans. The card shows only what
exists: a legacy-shaped plan degrades to header + `= Z%` + `<total> total` +
pool (from node passives, highlights preserved), dropping the split, the egg
breakdown, the IV gate, and the inheritance line. Queue synthetic seeds and the
no-save case take the same node-passives fallback.

## Wave — Pal-dex PALS grid → circular Palbox tiles (`views/paldex/index-view.tsx`)

The PALS grid (grid section only; the header/search/sort/filter toolbar and the
empty states are unchanged) is redrawn from the square card face (§9 grid,
`[minmax(184px,1fr)]` auto-fill of `PalIcon 44` + text rows + `CardWorkBadges`)
into a **fixed 5-wide grid of circular Palbox-style tiles**, adopting the Slot /
plan-graph `PalCircle` visual language (§6, §7 Graph view). This is a *dex of
species*, not instances, so the tile carries species-level chrome only. The old
square-card face — including `CardWorkBadges` on the card (§ "Work badges on the
dex card") — is superseded here; work suitability stays fully reachable in the
`PalHoverCard`, which is still wired on every tile.

### Layout

- Container unchanged: `flex-1 overflow-auto px-6 py-5`. Inner grid is
  `grid grid-cols-5 gap-x-4 gap-y-6` — exactly five per row at every width, with
  generous gaps so the circles breathe.
- Each tile is a centered column (`flex flex-col items-center gap-2`,
  `rounded-2xl px-1 py-2 text-center`). The portrait is
  `relative mx-auto aspect-square w-full max-w-[104px]` — it scales down with the
  column on narrow windows and caps at 104px, giving ~80–104px circles across the
  1280–1600 range.

### Tile anatomy (top → bottom)

- **Circular portrait (hero)** — `DexPortrait` (local to the view): the pal art
  clipped to `overflow-hidden rounded-full bg-abyss/70` with a `ring-1`, the same
  `group-hover:-translate-y-0.5` lift and `transition-[box-shadow,transform]` as
  the Slot. It holds its own icon-`failed` state (so the `UNKNOWN_ICON` fallback
  works inside the grid `.map`, where a hook per row is illegal).
- **Owned vs unowned ring/saturation (dex-completion read)** — driven by roster
  state: **owned** (`total > 0`) = amber ring (`ring-amber/55 group-hover:ring-amber`)
  at full saturation; **unowned with a save loaded** = quiet ring
  (`ring-line/50 group-hover:ring-amber/40`) plus a desaturated portrait
  (`opacity-60 saturate-[0.45]`, restored to full on hover); **no save loaded** =
  neutral ring (`ring-line/70 group-hover:ring-amber/50`), no dimming (there is no
  ownership concept yet). Owned pals visibly pop against the dimmed field.
- **Element chip** — an `ElementBadges size={13}` cluster on a dark
  `bg-abyss/90 border-line` pill, absolutely positioned as a **bottom-center
  overlay** on the ring (the Palbox badge idiom — mirrors the Slot's level pill
  slot). Carries the 1–2 categorical element colors.
- **Name** — centered directly below the circle, `text-[13px] font-medium text-ink`,
  truncated.
- **Identity line** — one centered mono `text-[10px] tabular-nums text-ink-faint`
  row: `#NNN` (dex number, zero-padded), the variant **`B`** marker in `el-dragon`
  when `is_variant`, a faint `·` divider, then `rank {combi_rank}` (combi rank is
  **not** in the hover card, so it stays on the tile — nothing shown before became
  unreachable).
- **Owned counts** — when a roster is loaded and `total > 0`, a centered mono
  `text-[11px]` row: `♂N` in `el-water`, `♀N` in `el-dragon` (§2 male=water /
  female=dragon glyph coding, unchanged).

### Interaction & a11y

- Each tile is a real `<button>` (the `PalHoverCard` trigger it clones), `onClick`
  → `onSelect(id)` (unchanged). `aria-label` is `"{name}, #NNN"`.
- Keyboard parity with the Palbox wave: `outline-none` + a visible
  `focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2
  focus-visible:ring-offset-abyss` on the tile box (rounded amber halo on Tab
  focus).
- `PalHoverCard` stays wired per tile (species-only variant): hover after the
  250 ms delay opens the full species briefing (elements, partner skill, work
  suitability, food, wild levels), so every datum — including the work profile
  dropped from the tile face — remains reachable.

## Wave — Breeding Setup LAB RESEARCH group (`components/breeding-setup.tsx`)

Adds a **LAB RESEARCH** group to the Solver's BREEDING SETUP panel, between BOOSTERS
and CAKE. It surfaces the game's research-lab incubation buff so a player can tell the
planner their researched rank — save files don't expose completed research, so this is
manual entry, stated honestly.

### Data

- Sourced from the own-install extraction (`tools/pal-extract`, `DT_LabResearchDataTable`)
  → pack `lab_research` → `list_lab_research` command → `LabResearchEntry[]`. Never
  fabricated. Build 24181527 ships exactly one breeding-relevant research —
  **Incubation Acceleration** (`EPalPassiveSkillEffectType::PalEggHatchingSpeed`), a
  4-rank chain cumulative to **−30%** (`+5/+15/+20/+30%`).
- The table carries this line **twice** (once per work-suitability tree it's researched
  in: Kindling/`EmitFlame` and Cooling/`Cool`) with identical name + effect + curve. The
  UI **dedupes by `(name, effect, curve)`** → one selectable row, so it never double-counts
  to a fictional −60%. If a future build makes the branches diverge they re-split into
  distinct rows automatically.
- The selected rank's cumulative fraction composes **additively into
  `incubation_reduction`** — the same store channel booster incubation effects use. No new
  solver channel (contract). Persisted per line key in
  `localStorage["pal-calc.setup.research"]` (`{ [key]: rank }`, `0` = not researched).

### Layout & tokens

- Group header `LAB RESEARCH` — mono `text-[11px] uppercase tracking-wider text-ink-faint`,
  matching BOOSTERS / CAKE / EGG HATCH TIME.
- One **line row** per deduped research: a `rounded-md border border-line bg-panel px-2 py-1.5`
  card holding two stacked rows.
  - **Top row**: a 26×26 amber-tile glyph (`border-amber/40 bg-amber/10 text-amber`) carrying
    the alembic **⚗** (`&#9879;`, the lab idiom, distinct from the passive booster's `◆`);
    then the line name (`text-[13px] font-medium text-ink`, truncated) over a mono status
    line — `-{n}% hatch time` in `text-amber-bright` when a rank is set, else `Not researched`
    in `text-ink-faint`; a right-aligned mono `LV {rank}/{maxRank}` counter.
  - **Bottom row**: a horizontal **segmented rank selector**, `role="radiogroup"`, one button
    per rank `0..maxRank`. Active = `bg-raised text-amber` (the CAKE-radio active idiom);
    inactive = `bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim`. Buttons flex-fill,
    `border-r border-line` dividers (`last:border-r-0`). `0` = not researched (neutral).
- Honest microcopy below the group (`text-[11px] text-ink-faint`): "Set to your lab's
  researched rank — save files don't expose research yet. Each rank speeds egg incubation,
  up to −30%."

### Reflection into the SETUP strip

Because research folds into `incubation_reduction`, the shared `describeSetup` (panel's
**APPLIED** line + the Solver's above-plan summary) automatically gains a `-{n}% incubation`
part the moment a rank changes — e.g. rank 3 → `APPLIED  -20% incubation / 1h hatch`,
rank 4 → `-30% incubation`. One source of truth; the strip never drifts from the selector.

## Wave — Pal-dex BRED FROM reverse-breeding (`components/reverse-breeding.tsx`)

Adds a **BRED FROM** section to a pal's dex detail (mounted right after LEARNABLE MOVES,
before the forward "BREED WITH…" resolver). It answers "what parents make this pal?" —
every unordered parent pair whose bred child resolves to the current species. Supersedes
and replaces the old `breeding_parents`-driven parent list and the separate "Gender-locked
combos" section (one reverse surface, one source of truth).

### Data

- Sourced from the pack breeding table via the `reverse_breeding(species) -> ReversePair[]`
  command — the same rows `child_of` resolves forward, never fabricated. The enumeration,
  dedup (canonical species pair), deterministic ordering (parent1 dex → id → parent2), and
  gender pins live in `pal_data::GameData::reverse_breeding`, unit-tested against the forward
  function. `ReversePair { parent1, parent2, kind: "unique" | "rank", parent1_gender,
  parent2_gender }`; parents are internal ids resolved to display names via a module-cached
  `paldex_species` fetch (shared across mounts). Lazily fetched on mount so detail stays snappy.
- `kind: "unique"` = a gender-pinned 1.0 combo (the two extant: CatMage×FoxMage → Katress
  Ignis / Foxparks Noct); `"rank"` = the combi-rank majority (null genders). A valid self-pair
  (`X × X → X`) is included and reads as a rank pair.

### Layout & tokens

- Panel matches the shared detail `Section`: `rounded-lg border border-line bg-panel/40`,
  `bg-raised` header with a mono `BRED FROM` eyebrow (`tracking-[0.18em] text-ink-dim`) carrying
  a 16px child glyph, and a right-aligned mono `N pairs` count (`text-ink-faint`, hidden at 0).
- **Unique combos surface FIRST** under a `text-amber` sub-eyebrow with a `gender-locked` badge
  (`border-amber/40 bg-amber/10 text-amber`); rank pairs follow under a faint `Standard combos`
  label. Two-column grid (`sm:grid-cols-2`) of compact pair rows.
- **Pair row**: `parentA × parentB → child` — each parent a clickable `PalHoverCard` chip
  (22px `PalIcon` + name), unique pins shown as gender glyphs (♂ `text-el-water` / ♀
  `text-el-dragon`); a mono `×` separator, an amber `→`, and an 18px dimmed child glyph.
- **Owned highlight** (save loaded): a pair whose BOTH parents are owned gets an amber glow
  (`border-amber/40 bg-amber/[0.07]` + faint ring) and sorts to the front of its group (stable
  otherwise, so dex order holds); an individually-owned parent's name tints `text-amber`. Roster
  read from `useAppState().roster` (same channel/derivation as the PALS grid).
- **Search filter** appears once a species has > 30 pairs — a full-width `bg-abyss/50` input
  (`focus:border-amber/50`) matching either parent's id or display name; a no-match state reads
  "No parents match …".

### Empty state

A non-breedable pal (0 parent pairs — wild-only) renders a single faint line inside the section:
"No breeding pair produces {name} — catch it in the wild." No bare shell, no crash; this is the
load-bearing wild-only message (the old dex-detail fallback was removed).

## Wave — Pal-dex detail STATS / WORK / DROPS / FIELD sections (`views/paldex/detail-view.tsx`)

Upgrades the dex detail into a full palpedia-grade reference page. Sections slot into the
existing scroll rhythm: BASE STATS + MOVEMENT (2-col) → FIELD DATA → WORK SUITABILITY → DROPS
→ LEARNABLE MOVES → BRED FROM (see above) → passives/roster → forward BREED WITH. Element
MATCHUP is deliberately absent — no attacker×defender damage table exists in extractable game
data (confirmed exhaustive scan; effectiveness is C++ code-side), so nothing is rendered rather
than fabricating a chart from folklore.

### Base stats (`Section` "Base stats")

- Combat trio HP / Attack / Defense as `StatRow`s: mono label, right-aligned `tabular-nums`
  value, normalized amber bar (`bg-amber/80`) against soft observed-max caps (`STAT_MAX`
  hp 180 / atk 150 / def 200) — bars only where comparative reading helps.
- Below a `border-t border-line-soft` divider, the non-comparative scalars as `StatValue` rows
  (mono label left, value right, NO bar): Support / Stamina / Craft speed. They don't read
  against a pack max, so a bar would be noise.

### Movement (`Section` "Movement")

- The 5 extraction-sourced speeds (Walk / Run / Ride sprint / Transport / Slow walk) as
  `MoveRow`s with a thin cool bar (`bg-ink-dim/70`) vs `MOVE_MAX` p95 caps. A `-1` sentinel
  (not rideable / can't haul) renders an em dash and NO bar — never a fake `0`.

### Field data (`Section` "Field data")

- Spec-sheet grid (`grid-cols-2 sm:grid-cols-3`, `FactCell`: mono eyebrow above value): Food
  (full-width `FoodMeter` — `amount` filled amber pips out of 10), Rarity (tier name), Size,
  Price (amber + "gold"), Capture rate (`{n}×`), EXP ratio (`{n}×`), Breeding power, Wild level
  (range, hidden when non-catchable), Activity (☾ Nocturnal / ☀ Diurnal).
- Capture/EXP floats trimmed to ≤2 dp with trailing zeros dropped (`fmtNum`: `1×`, `1.5×`).

### Work suitability (`Section` "Work suitability")

- Palpedia rec #1 — levels made prominent. Each nonzero kind (zero-kinds hidden) is a
  `WorkSuitChip`: 26px bundled work glyph + label, a level pip meter, and the level as a loud
  amber numeral (`Lv N`, `text-[17px] font-bold text-amber`). 2-col grid; right-aligned
  `N jobs` count in the header.
- Pip-meter denominator is the observed pack max **Lv8** (Bastigor), NOT the folk "1–5" — real
  extraction work levels run 1–8. A common Lv1–4 worker's bar stays readable; the numeral is
  the source of truth (level > cap fills all pips, never truncates the numeral).

### Drops (`Section` "Drops", presence-gated)

- Renders ONLY when `detail.drops.length > 0` — hidden cleanly for a species with no drop table.
  `DropsTable`: `grid-cols-[1fr_auto_auto]` with a mono eyebrow header (ITEM / QTY / RATE) over
  `border-line-soft` rows — item name (localized, falls back to id), min–max qty (`3–5`, bare
  when equal), and drop rate as an amber `{n}%` (percent 0..100 straight from the pack, so a
  sub-100% row like Anubis's 5% technical manual reads honestly).

### Degradation

- Every optional section is presence-gated (`drops.length`, `learnset.length`, work zero-kinds),
  so absent data hides the entire section — verified on Dumud Gild (no learnable moves + drops
  blanked): the page flows Field data → Work → BRED FROM with no empty shells or gaps.

## Wave — World Map (`views/map/MapView.tsx`, `lib/map-coords.ts`)

A new nav destination ("World Map · Explore", folded-map glyph, last in the
sidebar order) rendering the two Palworld map textures — **Palpagos** (the
`MainMap` overworld) and the **World Tree** sanctuary — with an optional
fog-of-war overlay driven by the loaded save's client-side `LocalData`. It is a
**canvas** view, not a DOM one: the image is 8192×8192, so it draws to a single
`<canvas>` (one `ctx.drawImage` per frame under a viewport transform) instead of
paying DOM/SVG layout for a huge raster.

### Direction

Same **breeder's field terminal** chrome as every other view — abyss surface,
`panel/60` header, amber eyebrow + Chakra-Petch title, mono microcopy. The map
art is the only saturated thing on screen (as the §1 rule intends); the UI stays
quiet gunmetal around it. The one signature flourish is the **fog**: a
game-adjacent unexplored haze, never a flat black mask.

### Interaction — reused from the plan graph

The pan/zoom model is lifted verbatim from `components/plan-graph.tsx` (§7 Graph
view) so the two pannable surfaces feel identical: wheel **zooms to the cursor**
(exp curve, clamped `0.06–2` — a viewport-fit lands near 8–12% for an 8192 image,
so the floor sits well below fit and the ceiling is a 200% pixel-peep), a
left-drag **pans past a 4px threshold** (`grab`/`grabbing`), the view
**fit-to-views** on first image, on every layer switch, and on resize, and a
bottom-right **−/+/fit** cluster mirrors the graph's control chassis exactly. The
difference is the *content*: instead of a CSS-transformed DOM viewport, an
rAF-coalesced `paint()` redraws the canvas under `ctx.setTransform(k·dpr, …)`
(DPR-aware backing store).

### Coordinate transform (`lib/map-coords.ts`)

The world↔pixel math is data-driven: the numeric calibration (image px, world
bounds, mask px) is read verbatim from `public/map/map-data.json` (contract C1),
never hardcoded — a recalibration is a data edit. The one thing in code is the
axis **orientation** (`ORIENT`), mirroring each layer's `world_to_px` string:
Palworld's texture is axis-swapped — the horizontal pixel `u` tracks world **Y**,
the vertical `v` tracks world **X** with a top-down flip. `worldToPx`/`pxToWorld`
are exact inverses. The HUD readout is separate and fixed — the in-game map
coords players actually see: `MapX = (worldY − 158000) / 459`,
`MapY = (worldX + 123888) / 459`.

### Fog overlay

`get_map_state(saveDir)` (C2) yields a `FogLayer` per map: a base64 8-bit
grayscale PNG (255 revealed / 0 fogged) at the layer's mask resolution (MainMap
1024², Tree 512²). It decodes once per layer into two offscreen mask canvases —
`gray` (neutral, opaque over fogged) and `tint` (abyss @ ~0.66 over fogged). Each
frame the composite is: draw the map, then over the fogged region **desaturate**
it (`globalCompositeOperation = "saturation"` with the gray mask — drains color
to grayscale) and **dim** it (source-over abyss tint). The read matches the game:
revealed terrain full-color, unexplored terrain a dark desaturated haze that
stays **barely legible, never pure black**. The mask is texture-aligned (drawn to
the same content box as the image), so fog needs no world transform. Verified
against the dedicated fixture: the ~21% revealed cluster renders, and the player +
custom markers all land on `255`/revealed mask cells (world→px agrees with the
texture UV).

### HUD, pins, controls

- **Coordinate readout** (top-left, mono `tabular-nums`): live `X · Y` in the
  in-game convention, updated on canvas hover, `—` when the cursor is off-canvas.
- **Zoom %** chip beside it (`round(k·100)`).
- **Fog toggle + reveal chip** (header right): the `FOG` toggle is amber-active
  when fog exists and on; **disabled** with honest microcopy *"No local map data
  found for this world"* when `fog:null`; **hidden entirely** when no save is
  loaded. The `NN.N% revealed` chip shows the layer's `revealed_pct`.
- **Player pins**: amber dot + nickname label (from `MapPlayerState`, positioned
  via `worldToPx`) for players with a recoverable position; a screen-space DOM
  overlay so labels stay crisp under zoom and never intercept a pan.
- **Custom markers**: small neutral `ink-dim` dots (icon-type semantics are not
  yet decoded — no fabricated icon set).

### States

- **No save** → full map, no fog controls.
- **Save, no LocalData** (`fog:null`) → full map, disabled FOG + microcopy.
- **Tree at 0% reveal** → still renders: the whole layer is fogged, so it reads
  as a dark desaturated relief rather than a blank.
- **Loading** → centered mono spinner ("Loading map…"); **load failure** → a
  `bad`-toned "Map failed to load".

### Non-goals (Wave 2/3)

Spawn / boss / effigy / fast-travel pin rendering, found/unfound per-pin
coloring, dex/solver cross-links, tile pyramids. The `map-data.json` pin arrays
are wired through the manifest type but not yet rendered.

## Wave 2 — World Map overlays (`views/map/`)

The overlay finish for the World Map. Adds an in-game-style **POI pin system**
(fast travel / alpha pals / effigies / bounties / custom markers / players /
bases), a per-layer **filter panel**, a species **spawn-heat** overlay, and
two-way **dex ↔ map cross-links** — and **reworks the fog** to be spoiler-proof.

> **Supersedes Wave 1** where they conflict: the Wave 1 §"Fog overlay"
> (desaturate + dim, "barely legible") is replaced by the near-opaque recipe
> below; the Wave 1 §"Custom markers" neutral-dot note and the §"Non-goals
> (Wave 2/3)" list (pin rendering, found/unfound, cross-links) are all now
> shipped. The pan/zoom model, coordinate transform, and HUD readout are
> unchanged.

### Fog recipe — rework (`views/map/fog.ts`)

Wave 1 desaturated unexplored terrain (a spoiler leak — you could still read the
coastline). Wave 2 **hides** it. `buildFogMask` bakes the reveal PNG once into an
offscreen canvas: fogged cells fill a deep **abyss-navy** `rgb(8,12,20)` at alpha
**249** (`~0.976` — near-opaque, terrain not legible beneath, but not pure black
so a faint abyss depth remains), revealed cells stay transparent. A single
`ctx.filter = "blur(1.6px)"` pass at native mask resolution softens the cell
edges; the paint loop then bilinear-upscales that ~1024² canvas to the 8192px
content box, and the two smoothing stages together dissolve the 8-px mask blocks
into a **soft cloud edge** (softer as you zoom in). Ocean beyond the map edges
stays the existing `#0d1117` abyss backdrop. Spawn heat is drawn *before* fog, so
points in unrevealed terrain are covered for free. The sharp (pre-blur) mask is
kept as a `Uint8Array` reveal bit-array (`isRevealed(mask, fu, fv)`) for the
per-pin spoiler test.

### Pin overlay + anatomy (`views/map/PinLayer.tsx`)

A screen-space **DOM** layer above the canvas — DOM (not more canvas) so labels,
hover chips, and clicks stay crisp and cheap. All pins live in one container that
carries **only the pan translate** (`transform: translate(tx,ty)`), so a pan
updates a single GPU-composited transform and never re-lays-out the pins; 150+
pins stay smooth. The visible set is **culled** to the viewport + a 200px margin
and only recomputed when the pan crosses a coarse 160px bucket. Pins render at a
**constant screen size** (they never scale with map zoom).

Per-kind anatomy (icons from `icons.json`, contract R1; each degrades to a tuned
inline-SVG vector fallback so a missing key is never a broken image):

- **Fast travel** — the in-game eagle-statue icon, **24px**. Unlocked = full
  `el-ice` cyan, opacity 1; locked = `ink-faint` gray, opacity 0.55. Hover shows
  the statue name.
- **Alpha pals** — a circular **pal portrait** (`PalIcon` by species id) in a
  dark `ring-2 ring-abyss` (→ `amber/70` on hover), with the cyan **`alpha_badge`**
  composited at the lower-right and a **`Lv N` chip** that fades in on hover. The
  whole pin is a `<button>` → opens the species in the Pal-dex.
- **Effigies** — the green Lifmunk-statuette icon, **22px**. Unfound = full
  `el-leaf` green, opacity 1 (the actionable ones pop); found = grayscaled,
  opacity 0.5, with a small green **✓** badge at the lower-right.
- **Bounties** — the `bounty` icon in `el-dark` purple. Dormant this build: no
  fixed-coordinate bounty POIs exist in the paks (bounties are dynamic incident
  spawns), so `map-data.json` ships no `bounties[]` and the row/pin never render.
- **Custom markers** — `marker_<icon_type>.png` (the raw i32 `IconType` indexes
  `T_icon_compass_00..16`), **20px**; falls back to a small outlined diamond.
- **Bases** — the `base` (camp) icon, **22px**, amber-tinted (the player's own).
- **Players** — amber dot + nickname label (unchanged from Wave 1).

### Found / unlocked join — R3 (`views/map/pins.ts`)

Each fast-travel / effigy POI in `map-data.json` carries a **`guid`** — the
world-static actor instance GUID as 32-char **UPPERCASE UE-Digits hex** (R1) —
that matches the keys in a player's `fast_travel_unlocked` / `effigies_found`
flag arrays **exactly**. The join is plain **string set-membership**: a pin is
found/unlocked iff some scoped player's flag set *contains* that pin's guid (no
coordinate join, no radius). `playerScope` `"all"` unions every player's flags.
**Degradation:** a pin with a null guid renders neutral; when *no* POI carries a
guid the filter counts fall back to the raw flag-set sizes (clamped to the pak
total) and are shown dim + italic with *"(per-pin match unavailable)"* microcopy
— honest "you've unlocked N", never a fabricated per-pin state.

### Filter panel (`views/map/FilterPanel.tsx`)

The in-game "Filter" equivalent: a popover under the header **Filter** button,
one switch row per layer with a live right-aligned count — Fast Travel
`found/total`, Alpha Pals, Effigies `found/total`, Bounties (only when present),
Spawns (active species label), Players, Markers, **Bases** (only when the save
has any). State persists to `localStorage` (`pal-calc.mapFilters`). When the join
is live the FT/effigy counts read normal weight (`8/152`, `5/155`); when degraded
they go dim + italic. A trailing **"Show hidden"** override (only while fog is on)
with an amber spoiler warning toggles the fog gate.

### Spawn-heat overlay (`SpawnSearch.tsx` + canvas)

A species search combobox (the Solver's datalist pattern, matched on display
name) renders that species' **wild** spawn points as soft heat dots on the
canvas: low-alpha radius-scaled fills, **amber** for day/anytime and **indigo**
for night-only, so overlapping radii build a readable heat cloud. Hover gives
Lv range / pack size / time; a legend chip shows the species portrait, on-layer
**site count**, level range, a ☀/☾ day-night key, a jump-to-dex link, and a
clear (×). **Wild-only:** field-boss (`BOSS_<id>`) entries are excluded from the
heat, the combobox, and the dex gate (`isFieldBossSpawn` in `lib/map-data.ts`) —
alphas are already the Alpha pin layer, so folding them in would double-show them
and over-count (e.g. Lamball reads **383 sites · Lv 1–9**, not 416 · 1–13).

### Bases layer

`MapState.bases` (R2) — one world point per player base camp (the PalBox anchor).
Rendered with the `base` icon whenever the layer is on and the coord lands in the
active layer's bounds. **Not fog-gated:** these are the player's *own* bases, so
there is no spoiler to hide — they always show.

### Spoiler rules

With fog **on**, a pin whose world cell is unrevealed is **culled** (not drawn) —
the map never leaks the location of content you haven't found. **Exempt:** an
unlocked fast-travel or a found effigy is already known to the player (`known`),
so it shows through fog; bases are exempt (own bases); alpha / locked / unfound
pins are hidden. The **"Show hidden"** panel toggle overrides the gate (with a
*"Revealing pins in unexplored areas — spoilers."* warning) for players who
want the full atlas.

### Dex ↔ map cross-links

- **Dex → map:** the Pal-dex detail Field-data header shows a **"Show on map"**
  button when the species has wild spawns (`speciesHasSpawns`, lazy-loaded off
  the dex render path so the 6 MB manifest never blocks it). It routes to the
  World Map with that species' spawn overlay active (`requestMapSpawn` →
  `mapSpawnTarget` in `state.tsx`, consumed once on the map).
- **Map → dex:** clicking an alpha pin, or the spawn legend chip's species name,
  opens that species in the Pal-dex detail (`requestDex`).

### Verification (fixture mode, 1280 + 1600)

Screenshot-proven against the co-op fixture (host: 9 FT flags, 5 effigy flags;
3 base camps; 20.96% MainMap reveal): (a) fog hides terrain with soft cloud edges
(no 8-px blocks), toggle on/off swaps the visible pin set; (b) real in-game icons
render, and the guid join lights **8/152 unlocked FT** (cyan) + **5/155 found
effigies** (dim + ✓) with joined counts; (c) filter toggles update the map and
survive a reload; (d) Lamball spawn search = 383 wild sites, Lv 1–9, day heat,
legend + clear; (e) under fog all 8 unlocked FT + 5 found effigies stay visible
while locked/unfound/alpha pins hide, and "Show hidden" reveals them with the
warning; (f) dex "Show on map" opens the overlay, and alpha-pin / legend-chip
both open the dex.
