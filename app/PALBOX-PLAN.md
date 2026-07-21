# Palbox View — plan (not yet built)

Refactor Save Inspector's main surface into the in-game Palbox layout (user request,
2026-07-21; reference: in-game screenshot — party rail left, box grid center with pager,
detail panel right, base-pals strip below).

## Data feasibility — everything needed is already parsed

| In-game element | Our data | Notes |
|---|---|---|
| Party rail (5 slots) | `container_kind == Party` + `owner_player_uid` | 4 players on the server save → needs a player switcher the game doesn't have |
| Box grid pages | `container_kind == Palbox` + `slot_index` | box = `slot / 30`, cell = `slot % 30`, 6×5 grid like the game; render trailing empty slots |
| "Pal who is at the base" strip | `container_kind == Base` grouped by `container_id` | 6 bases in test save; base *names/coords* not parsed yet (GroupSaveDataMap has them — optional pal-save extension) |
| Dimensional storage | per-player `_dps.sav` pals | pages of 30, show only occupied pages (9600-slot container) |
| Detail panel right | built in iteration 2 (roster detail panel) | reuse as-is; matches the game's right panel already |

## Layout (1280 base)

```mermaid
graph LR
  A[Party rail<br/>per player, 5 slots] --- B[Box grid 6x5<br/>pager: LB box N RB<br/>+ dimensional tab]
  B --- C[Detail panel<br/>existing component]
  B --- D[Base strip below:<br/>one row per base]
```

## Decisions to confirm with user

1. **Player switcher**: tabs above the party rail (game shows only "you"; a server save has 4 players). Proposed: tabs, remember last.
2. **Slot styling**: circular icon slots like the game (level ring, gender dot, alpha crown) vs current square cards. Proposed: circular in the grid, cards stay in list mode.
3. **Keep the table**: list/box mode toggle — table remains for sort/filter power use. Proposed: yes, toggle top-right.
4. **Search behavior**: game-style highlight (matching slots lit, others dimmed) instead of removing slots. Proposed: highlight.
5. **Box ordering**: slot order is ground truth; no re-sorting inside the grid (sorting lives in list mode).

## Build slices (one designer round + polish)

1. Pure-TS grouping selectors (pals → player → containers → pages) + unit-ish tests in vitest or plain TS asserts.
2. `PalboxGrid`, `PartyRail`, `BaseStrip`, pager components (UI-DESIGN tokens; circular slot primitive).
3. Wire selection → existing detail panel; keyboard nav (arrows move cell, LB/RB = box pager like the game).
4. Optional pal-save extension: base names/positions from GroupSaveDataMap for the base strip headers.
5. Screenshot loop incl. empty boxes, dimensional tab, 1024 width.
