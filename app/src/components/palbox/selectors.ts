// Pure grouping / sorting / filtering selectors for the Palbox view. Kept as
// plain functions (no React) so the flatten -> sort -> repaginate logic and the
// per-player / per-container grouping are deterministic and unit-testable.
//
// The in-game Palbox layout (PALBOX-PLAN.md) and its sort/search feature set
// (PALBOX-SORT-SPEC.md) are cloned here read-only: we never rewrite slots, we
// reorder virtually.

import { isAlpha, type OwnedPal, type SaveSummary, type SpeciesEntry } from "../../lib/types";

/** Slots per Palbox / Dimensional page (6x5), matching the game. */
export const PAGE_SIZE = 30;
/** Grid columns; 6 wide x 5 tall = 30. */
export const GRID_COLS = 6;
/** Party rail capacity. */
export const PARTY_SIZE = 5;

/** Canonical element order used by the "Element" sort (primary element). */
export const ELEMENT_ORDER = [
  "Normal",
  "Fire",
  "Water",
  "Leaf",
  "Electricity",
  "Ice",
  "Earth",
  "Dark",
  "Dragon",
] as const;

export type SortKey =
  | "slot"
  | "paldex"
  | "level"
  | "name"
  | "rarity"
  | "element"
  | "alpha";

export type SortDir = "asc" | "desc";

export type GenderFilter = "any" | "Male" | "Female";

/** The shared sort/search/filter state, applied to BOTH grid and list modes. */
export interface PalboxQuery {
  /** Free-text query; case-insensitive contains over name/nickname/species. */
  search: string;
  sortKey: SortKey;
  sortDir: SortDir;
  /** Active element toggles (canonical kind names). Empty = no element filter. */
  elements: string[];
  gender: GenderFilter;
  alphaOnly: boolean;
  /** Free-text passive query; matches passive display ids, contains. */
  passive: string;
}

export const DEFAULT_QUERY: PalboxQuery = {
  search: "",
  sortKey: "slot",
  sortDir: "asc",
  elements: [],
  gender: "any",
  alphaOnly: false,
  passive: "",
};

/** True when the query would reorder or hide anything vs. physical slot order. */
export function isQueryActive(q: PalboxQuery): boolean {
  return (
    q.sortKey !== "slot" ||
    q.search.trim() !== "" ||
    q.elements.length > 0 ||
    q.gender !== "any" ||
    q.alphaOnly ||
    q.passive.trim() !== ""
  );
}

/** Lowercase 32-char hex of a serialized GUID (matches the backend format). */
export function hexGuid(g: number[]): string {
  return g.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable identity key for a pal instance. */
export function palKey(pal: OwnedPal): string {
  return pal.instance_id.join("-");
}

/**
 * Whether this entity is a captured human rather than a pal. Slice A adds
 * `is_human: boolean` to OwnedPal; read defensively so the app compiles and
 * degrades gracefully against fixtures / saves that predate the field.
 */
export function isHuman(pal: OwnedPal): boolean {
  return (pal as OwnedPal & { is_human?: boolean }).is_human === true;
}

/** Species lookup helpers, tolerant of missing pack entries. */
export type SpeciesLookup = Map<string, SpeciesEntry>;

export function speciesName(
  pal: OwnedPal,
  names: Map<string, string>,
): string {
  return names.get(pal.character_id) ?? pal.character_id;
}

/** The name the search / "Name" sort reads: nickname wins, else species name. */
export function displayLabel(
  pal: OwnedPal,
  names: Map<string, string>,
): string {
  return pal.nickname && pal.nickname.trim()
    ? pal.nickname
    : speciesName(pal, names);
}

/** Primary element index in canonical order; unknown -> end of list. */
function elementRank(pal: OwnedPal, species: SpeciesLookup): number {
  const el = species.get(pal.character_id)?.elements?.[0];
  const i = el ? ELEMENT_ORDER.indexOf(el as (typeof ELEMENT_ORDER)[number]) : -1;
  return i === -1 ? ELEMENT_ORDER.length : i;
}

function paldexNo(pal: OwnedPal, species: SpeciesLookup): number {
  // Unknown species sink to the end on an ascending Paldeck sort.
  return species.get(pal.character_id)?.paldex_no ?? Number.MAX_SAFE_INTEGER;
}

/** Physical slot order across containers: box index then cell, then key. */
function physicalOrder(a: OwnedPal, b: OwnedPal): number {
  const sa = a.slot_index ?? Number.MAX_SAFE_INTEGER;
  const sb = b.slot_index ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return palKey(a).localeCompare(palKey(b));
}

/**
 * Does a pal pass the active text search + structured filters?
 * Search HIDES non-matches (PALBOX-PLAN decision 4).
 */
export function matchesQuery(
  pal: OwnedPal,
  q: PalboxQuery,
  names: Map<string, string>,
  species: SpeciesLookup,
): boolean {
  const s = q.search.trim().toLowerCase();
  if (s) {
    const hay = [
      displayLabel(pal, names),
      speciesName(pal, names),
      pal.character_id,
      pal.nickname ?? "",
    ]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(s)) return false;
  }

  if (q.elements.length > 0) {
    const els = species.get(pal.character_id)?.elements ?? [];
    if (!q.elements.some((e) => els.includes(e))) return false;
  }

  if (q.gender !== "any" && pal.gender !== q.gender) return false;

  if (q.alphaOnly && !isAlpha(pal)) return false;

  const pq = q.passive.trim().toLowerCase();
  if (pq) {
    const has = pal.passives.some((p) => p.toLowerCase().includes(pq));
    if (!has) return false;
  }

  return true;
}

/**
 * Comparator for a sort key + direction, with the deterministic tie-break
 * chain from PALBOX-SORT-SPEC §Tie-breaks. Physical slot order is always the
 * final tie-break so every sort is fully stable.
 */
export function compareBy(
  key: SortKey,
  dir: SortDir,
  names: Map<string, string>,
  species: SpeciesLookup,
): (a: OwnedPal, b: OwnedPal) => number {
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    let primary = 0;
    switch (key) {
      case "slot":
        // Pure physical order; direction still applies.
        return sign * physicalOrder(a, b);
      case "paldex":
        primary = paldexNo(a, species) - paldexNo(b, species);
        if (primary) return sign * primary;
        // tie: Level desc, then physical
        if (b.level !== a.level) return b.level - a.level;
        return physicalOrder(a, b);
      case "level":
        primary = a.level - b.level;
        if (primary) return sign * primary;
        primary = paldexNo(a, species) - paldexNo(b, species);
        if (primary) return primary;
        return physicalOrder(a, b);
      case "name":
        primary = displayLabel(a, names)
          .toLowerCase()
          .localeCompare(displayLabel(b, names).toLowerCase());
        if (primary) return sign * primary;
        primary = paldexNo(a, species) - paldexNo(b, species);
        if (primary) return primary;
        return physicalOrder(a, b);
      case "rarity":
        primary =
          (species.get(a.character_id)?.stats.rarity ?? 0) -
          (species.get(b.character_id)?.stats.rarity ?? 0);
        if (primary) return sign * primary;
        primary = paldexNo(a, species) - paldexNo(b, species);
        if (primary) return primary;
        return physicalOrder(a, b);
      case "element":
        primary = elementRank(a, species) - elementRank(b, species);
        if (primary) return sign * primary;
        primary = paldexNo(a, species) - paldexNo(b, species);
        if (primary) return primary;
        if (b.level !== a.level) return b.level - a.level;
        return physicalOrder(a, b);
      case "alpha":
        // Alpha-first: alphas (boss origin or lucky) lead on ascending.
        primary = (isAlpha(b) ? 1 : 0) - (isAlpha(a) ? 1 : 0);
        if (primary) return sign * primary;
        primary = paldexNo(a, species) - paldexNo(b, species);
        if (primary) return primary;
        return physicalOrder(a, b);
    }
  };
}

/** Filter + stable sort a flat pal list per the shared query. */
export function applyQuery(
  pals: OwnedPal[],
  q: PalboxQuery,
  names: Map<string, string>,
  species: SpeciesLookup,
): OwnedPal[] {
  const filtered = pals.filter((p) => matchesQuery(p, q, names, species));
  const cmp = compareBy(q.sortKey, q.sortDir, names, species);
  return filtered.slice().sort(cmp);
}

// --- Grouping ---------------------------------------------------------------

/** A base container: one container_id, its pals in physical order. */
export interface BaseGroup {
  containerId: string;
  label: string;
  pals: OwnedPal[];
}

/** Container split for one player, plus the player-independent bases. */
export interface PlayerContainers {
  party: OwnedPal[];
  palbox: OwnedPal[];
  dimensional: OwnedPal[];
  /** World-shared Global Pal Storage machine(s) — own bucket, not folded. */
  global: OwnedPal[];
  /** Viewing cages (display pedestals); pals remain owned + solver-visible. */
  cage: OwnedPal[];
}

/** Split all pals owned by / stored for one player by container kind. */
export function playerContainers(
  pals: OwnedPal[],
  playerUidHex: string,
): PlayerContainers {
  const party: OwnedPal[] = [];
  const palbox: OwnedPal[] = [];
  const dimensional: OwnedPal[] = [];
  const global: OwnedPal[] = [];
  const cage: OwnedPal[] = [];
  for (const p of pals) {
    const owner = p.owner_player_uid ? hexGuid(p.owner_player_uid) : null;
    if (owner !== playerUidHex) continue;
    if (p.container_kind === "Party") party.push(p);
    else if (p.container_kind === "Palbox") palbox.push(p);
    else if (p.container_kind === "DimensionalPalStorage") dimensional.push(p);
    else if (p.container_kind === "GlobalPalStorage") global.push(p);
    else if (p.container_kind === "ViewingCage") cage.push(p);
  }
  return { party, palbox, dimensional, global, cage };
}

/**
 * All base containers across the save (player-independent), grouped by
 * container_id and labeled "Base 1..N" in first-seen order.
 */
export function baseGroups(pals: OwnedPal[]): BaseGroup[] {
  const order: string[] = [];
  const map = new Map<string, OwnedPal[]>();
  for (const p of pals) {
    if (p.container_kind !== "Base") continue;
    const cid = p.container_id ? hexGuid(p.container_id) : "unknown";
    if (!map.has(cid)) {
      map.set(cid, []);
      order.push(cid);
    }
    map.get(cid)!.push(p);
  }
  return order.map((cid, i) => ({
    containerId: cid,
    label: `Base ${i + 1}`,
    pals: map.get(cid)!.slice().sort(physicalOrder),
  }));
}

// --- Guild / base ownership scoping ----------------------------------------

/**
 * A base's guild membership, normalized from the SaveSummary.bases contract
 * (slice A). `containerId`/`memberUids` are lowercased 32-char hex to match
 * {@link hexGuid} and PlayerRef.uid. Read defensively so the view compiles and
 * falls back to a combined base view until the backend field lands.
 */
export interface GuildBase {
  containerId: string;
  guildName: string | null;
  memberUids: string[];
}

type RawBase = {
  container_id?: number[] | string;
  guild_id?: string;
  guild_name?: string;
  member_uids?: string[];
};

/** Normalize a hex-or-Guid identifier to lowercase 32-char hex. */
function normHex(v: number[] | string | undefined): string {
  if (Array.isArray(v)) return hexGuid(v);
  return (v ?? "").toLowerCase();
}

/**
 * Read the (optional) guild-base ownership table off a SaveSummary. Empty when
 * the backend hasn't published `bases` yet — callers treat that as "no guild
 * data, show the combined view".
 */
export function guildBases(summary: SaveSummary): GuildBase[] {
  const raw = (summary as SaveSummary & { bases?: RawBase[] }).bases;
  if (!Array.isArray(raw)) return [];
  return raw.map((b) => ({
    containerId: normHex(b.container_id),
    guildName: b.guild_name ?? null,
    memberUids: (b.member_uids ?? []).map((u) => normHex(u)),
  }));
}

/**
 * Scope base groups to those owned by the selected player's guild. A base is
 * shown when its guild's members include `playerUidHex`, and is relabeled with
 * its guild name for clarity. When guild data is absent (stale fixture /
 * pre-contract backend) every base is returned unchanged — the graceful
 * combined fallback. Bases with no matching guild entry are kept too, so real
 * data is never silently hidden.
 */
export function scopeBasesToPlayer(
  bases: BaseGroup[],
  guild: GuildBase[],
  playerUidHex: string,
): BaseGroup[] {
  if (guild.length === 0) return bases;
  const byContainer = new Map(guild.map((g) => [g.containerId, g]));
  const out: BaseGroup[] = [];
  for (const b of bases) {
    const g = byContainer.get(b.containerId);
    if (g && !g.memberUids.includes(playerUidHex)) continue;
    out.push(g?.guildName ? { ...b, label: g.guildName } : b);
  }
  return out;
}

// --- Paging -----------------------------------------------------------------

/** A single grid cell: a pal or an empty slot at a given cell index. */
export interface GridCell {
  pal: OwnedPal | null;
  /** Physical cell index within the box (0..PAGE_SIZE-1) for empty slots. */
  cell: number;
}

/**
 * Physical-layout paging: place pals at `slot_index % PAGE_SIZE` within box
 * `slot_index / PAGE_SIZE`, rendering trailing empty slots. Returns one array
 * of PAGE_SIZE cells per occupied box (boxes with no pals are skipped so the
 * pager only walks real boxes; the last box still fills to 30).
 */
export function physicalPages(palbox: OwnedPal[]): GridCell[][] {
  if (palbox.length === 0) return [];
  const byBox = new Map<number, OwnedPal[]>();
  let maxBox = 0;
  for (const p of palbox) {
    const slot = p.slot_index ?? 0;
    const box = Math.floor(slot / PAGE_SIZE);
    maxBox = Math.max(maxBox, box);
    if (!byBox.has(box)) byBox.set(box, []);
    byBox.get(box)!.push(p);
  }
  const pages: GridCell[][] = [];
  for (let box = 0; box <= maxBox; box++) {
    const cells: GridCell[] = Array.from({ length: PAGE_SIZE }, (_, cell) => ({
      pal: null,
      cell,
    }));
    for (const p of byBox.get(box) ?? []) {
      const cell = (p.slot_index ?? 0) % PAGE_SIZE;
      cells[cell] = { pal: p, cell };
    }
    pages.push(cells);
  }
  return pages;
}

/**
 * Virtual (compact) paging: chunk a flattened/sorted/filtered pal list into
 * pages of PAGE_SIZE with no empty gaps. The last page is NOT padded here;
 * the grid renders it as-is (compact, per user decision to hide not dim).
 */
export function compactPages(pals: OwnedPal[]): GridCell[][] {
  const pages: GridCell[][] = [];
  for (let i = 0; i < pals.length; i += PAGE_SIZE) {
    pages.push(
      pals.slice(i, i + PAGE_SIZE).map((pal, j) => ({ pal, cell: i + j })),
    );
  }
  return pages;
}

/**
 * Dimensional paging: pages of PAGE_SIZE showing ONLY occupied pages (game
 * behavior — the 9600-slot container never renders empty pages). Each returned
 * page is compacted (no empty cells) and tagged with its physical page number.
 */
export interface DimPage {
  /** Physical page index (slot / PAGE_SIZE). */
  page: number;
  pals: OwnedPal[];
}

export function dimensionalPages(dps: OwnedPal[]): DimPage[] {
  const byPage = new Map<number, OwnedPal[]>();
  for (const p of dps) {
    const page = Math.floor((p.slot_index ?? 0) / PAGE_SIZE);
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(p);
  }
  return [...byPage.keys()]
    .sort((a, b) => a - b)
    .map((page) => ({
      page,
      pals: byPage.get(page)!.slice().sort(physicalOrder),
    }));
}

/** Place party pals into PARTY_SIZE fixed slots by slot_index. */
export function partySlots(party: OwnedPal[]): (OwnedPal | null)[] {
  const slots: (OwnedPal | null)[] = Array.from({ length: PARTY_SIZE }, () => null);
  for (const p of party) {
    const i = p.slot_index ?? -1;
    if (i >= 0 && i < PARTY_SIZE) slots[i] = p;
  }
  return slots;
}
