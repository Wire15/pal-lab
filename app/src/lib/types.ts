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
  /**
   * Catchable human NPC (merchant/hunter/villager) rather than a pal. Set when
   * the species id is absent from the pack and the save record has no gender.
   */
  is_human: boolean;
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

/**
 * A guild-owned base camp mapped to its worker pal-container and the guild's
 * member players. All ids are lowercase 32-char hex strings, matching
 * `PlayerRef.uid` and the hex form of `OwnedPal.container_id` — so
 * `guildBases`/`scopeBasesToPlayer` can compare `base.container_id` against
 * `hexGuid(pal.container_id)` and match a selected player's `PlayerRef.uid`
 * against `base.member_uids` directly.
 */
export interface BaseOwnership {
  container_id: string;
  guild_id: string;
  guild_name: string;
  member_uids: string[];
}

export interface SaveSummary {
  world_name: string;
  players: PlayerRef[];
  pals: OwnedPal[];
  /** Guild-owned base camps mapped to worker containers + member players. */
  bases: BaseOwnership[];
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

/** Base + extended stats the pack carries for a species. Extended fields come
 * from the own-install extraction (Palworld build 24181527). */
export interface SpeciesStats {
  hp: number;
  attack: number;
  defense: number;
  rarity: number;
  /** Merchant sell price. */
  price: number;
  /** Crafting-speed multiplier (percent; 100 for every pal). */
  craft_speed: number;
  slow_walk_speed: number;
  walk_speed: number;
  run_speed: number;
  /** Mounted sprint speed; -1 when the species is not rideable. */
  ride_sprint_speed: number;
  /** Transport hauling speed; -1 when the species cannot transport. */
  transport_speed: number;
  stamina: number;
  max_full_stomach: number;
  /** Body-size class: "XS" | "S" | "M" | "L" | "XL". */
  size: string;
  /** P(male) as a percent (0-100). NOTE: SpeciesEntry.male_probability is the
   * 0-1 fraction the gender bar reads; this percent copy exists per contract. */
  male_probability: number;
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
  /** Partner-skill display name, or null when the pack has none (~130 species,
   * mostly DLC, have no permissive partner-skill source). */
  partner_skill: string | null;
  /** Partner-skill effect description, paired with {@link partner_skill}. */
  partner_skill_desc: string | null;
  /** Whether the species is nocturnal. */
  nocturnal: boolean;
  /** Food-bowl demand (bars). */
  food_amount: number;
  /** Wild spawn level range [min, max]. */
  wild_levels: [number, number];
  /** Element type(s): 1–2 canonical kind names ("Normal", "Fire", "Water",
   * "Leaf", "Electricity", "Ice", "Earth", "Dark", "Dragon") in the game's
   * primary-then-secondary order. */
  elements: string[];
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
