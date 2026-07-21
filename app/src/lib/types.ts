// Mirrors the serde JSON shapes of crates/pal-data/src/types.rs.
// GUIDs are [u8; 16] in Rust, which serde emits as a JSON array of 16 numbers.

export type Gender = "Male" | "Female";

/** GUID as serialized by serde: a 16-element byte array. */
export type Guid = number[];

export interface IvSet {
  hp: number;
  attack: number;
  defense: number;
}

export type ContainerKind =
  | "Party"
  | "Palbox"
  | "Base"
  | "ViewingCage"
  | "GlobalPalStorage"
  | "DimensionalPalStorage"
  | "Unknown";

export interface OwnedPal {
  instance_id: Guid;
  /** Species id with any BOSS_/PREDATOR_/GYM_ prefix stripped. */
  character_id: string;
  is_boss: boolean;
  gender: Gender | null;
  level: number;
  /** Condensation rank (0 = base). */
  rank: number;
  passives: string[];
  /** Equipped active skills (waza), internal ids, enum prefix stripped. */
  active_skills: string[];
  ivs: IvSet;
  nickname: string | null;
  owner_player_uid: Guid | null;
  container_id: Guid | null;
  slot_index: number | null;
  container_kind: ContainerKind;
}

export interface PlayerRef {
  uid: string;
  name: string;
}

export interface SaveSummary {
  world_name: string;
  players: PlayerRef[];
  pals: OwnedPal[];
  /** Non-fatal parser warnings (skipped entities, unreadable sub-saves). */
  warnings: string[];
}

// --- Solver (mirrors crates/pal-solver/src/solver/results.rs + the Tauri
// `solve` command's SolveRequest). ---

export interface SolveRequest {
  target_species: string;
  required_passives: string[];
  max_steps?: number;
  allow_wild?: boolean;
  max_irrelevant?: number;
}

/** `{id, name}` from list_species / list_passives. */
export interface NamedEntry {
  id: string;
  name: string;
}

/**
 * How a plan node is obtained. serde emits an externally-tagged enum:
 * `{ Owned: { location } }` | `{ Wild: { captures } }` | `"Bred"`.
 */
export type PlanSource =
  | { Owned: { location: string } }
  | { Wild: { captures: number } }
  | "Bred";

export interface PlanNode {
  species: number;
  species_name: string;
  /** null = unresolved/wildcard gender. */
  gender: Gender | null;
  passives: string[];
  source: PlanSource;
  probability: number;
  est_time_secs: number;
  children: PlanNode[];
}

/** serde unit enum -> plain string. */
export type CakeKind =
  | "Normal"
  | "Mushroom"
  | "Vegetable"
  | "DeluxeVegetable"
  | "Special";

export interface BreedingPlan {
  root: PlanNode;
  total_time_secs: number;
  total_steps: number;
  total_wild_pals: number;
  /** Cake used for this plan ("Normal" = none). */
  cake: CakeKind;
  /** Estimated cakes consumed across all steps (0 for Normal). */
  cake_count: number;
}

// --- Pal-dex (mirrors app/src-tauri/src/paldex.rs) ---

/** A passive resolved to `{id, name, rank}` for a species' guaranteed rolls. */
export interface PassiveRef {
  id: string;
  name: string;
  rank: number;
}

/** Base stats the pack carries for a species. */
export interface SpeciesStats {
  hp: number;
  attack: number;
  defense: number;
  rarity: number;
}

/** Lightweight species reference for parent/child links. */
export interface SpeciesRef {
  id: string;
  name: string;
  paldex_no: number;
}

/** One species row for the pal-dex grid (from `paldex_species`). */
export interface SpeciesEntry {
  id: string;
  name: string;
  paldex_no: number;
  is_variant: boolean;
  /** palcalc BreedingPower used by the child formula. */
  combi_rank: number;
  combi_rank_priority: number;
  male_probability: number;
  stats: SpeciesStats;
  guaranteed_passives: PassiveRef[];
  /** Work-suitability levels (12 ints, canonical order: Kindling, Watering,
   * Planting, GenerateElectricity, Handiwork, Gathering, Lumbering, Mining,
   * MedicineProduction, Cooling, Transporting, Farming). */
  work_suitability: number[];
  /** Partner-skill display name, or null when the pack has none. */
  partner_skill: string | null;
  /** Whether the species is nocturnal. */
  nocturnal: boolean;
  /** Food-bowl demand (bars). */
  food_amount: number;
  /** Wild spawn level range [min, max]. */
  wild_levels: [number, number];
}

/** A gender-pinned "unique combo" this species takes part in. */
export interface UniqueCombo {
  parent_a: SpeciesRef;
  parent_b: SpeciesRef;
  child: SpeciesRef;
  /** "parent" if this species is a parent in the combo, else "child". */
  role: "parent" | "child";
}

/** Breeding participation notes for a species detail. */
export interface BreedingNotes {
  parent_pair_count: number;
  unique_combos: UniqueCombo[];
}

/** Full detail (`paldex_species_detail`): the grid row plus breeding notes. */
export interface SpeciesDetail extends SpeciesEntry {
  breeding: BreedingNotes;
}

/** A canonical parent pair that breeds into a target child. */
export interface ParentPair {
  parent_a: SpeciesRef;
  parent_b: SpeciesRef;
}

/** Reverse breeding lookup result (`breeding_parents`). */
export interface ParentsResult {
  /** Total distinct parent pairs before any cap. */
  total: number;
  pairs: ParentPair[];
}

/** Forward breeding result (`breeding_child`). */
export interface ChildResult {
  child: SpeciesRef | null;
}

/** Best (max) IV seen across owned instances of a species. */
export interface BestIvs {
  hp: number;
  atk: number;
  def: number;
}

/** Per-species owned tally from `roster_counts`, keyed by character id. */
export interface RosterCount {
  male: number;
  female: number;
  best_ivs: BestIvs;
}

/** `roster_counts` returns a map of character id -> tally. */
export type RosterCounts = Record<string, RosterCount>;
