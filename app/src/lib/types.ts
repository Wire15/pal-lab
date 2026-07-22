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
  /** "Include pals I don't own": seed the search with wild-catchable species as
   * CATCH steps so same-species-only legendaries (Jetragon, …) get plans. */
  include_wild?: boolean;
  max_irrelevant?: number;
  /** Catch policy, only meaningful when `include_wild` is true. Defaults to
   * `"breeding_only"` server-side: pure owned breeding, auto-falling back to
   * catch-assisted plans (with `SolveResponse.fallback_used`) only when the
   * target is unreachable owned-only. `"allowed"` lets catches fill ingredient
   * gaps freely. Either way, trivial 0-step "catch the target" plans are
   * dropped whenever a real plan exists. */
  catching?: "allowed" | "breeding_only";
}

/** `{id, name}` from `list_species`. */
export interface NamedEntry {
  id: string;
  name: string;
}

/** One structured effect line of a passive (`list_passives`). `type`/`target`
 * are raw game enum tokens (e.g. "ShotAttack", "ToSelf"); `value` is signed. */
export interface PassiveEffect {
  type: string;
  value: number;
  target: string;
}

/** A passive row from `list_passives`. Identity/rank are the pack's; effects,
 * description, and pal_facing are extraction-sourced display metadata. All
 * passives are returned; the UI filters the browse to `pal_facing`. */
export interface PassiveEntry {
  id: string;
  name: string;
  rank: number;
  effects: PassiveEffect[];
  description: string | null;
  pal_facing: boolean;
  /** Special lottery-pool tier: "rainbow" (mutation pool) / "worldtree"
   * (world-tree pool) / null. Absent or null ⇒ rank-based coloring only. */
  tier?: "rainbow" | "worldtree" | null;
}

/** One active-skill (waza) definition from `list_active_skills`, matching the
 * pack `ActiveSkill` struct. `element` uses the same internal element strings as
 * species elements ("Normal"/"Fire"/"Water"/"Leaf"/"Electricity"/"Ice"/"Earth"/
 * "Dark"/"Dragon"), or "None" for name-only entries. `power`/`cool_time` are null
 * for non-damage / no-cooldown skills; `description` is null when the game has none. */
export interface ActiveSkill {
  name: string;
  element: string;
  power: number | null;
  cool_time: number | null;
  description: string | null;
}

/** Active-skill definitions keyed by save-side waza id
 * (e.g. "Unique_SheepBall_Roll", "AirCanon"), from `list_active_skills`. */
export type ActiveSkills = Record<string, ActiveSkill>;

/**
 * How a plan node is obtained. serde emits an externally-tagged enum:
 * `{ Owned: { location } }` | `{ Wild: { captures, min_wild_level } }` | `"Bred"`.
 */
export type PlanSource =
  | { Owned: { location: string } }
  | { Wild: { captures: number; min_wild_level: number } }
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

/** Response from the `solve` command: the ranked breeding plans plus whether a
 * `"breeding_only"` request had to fall back to catch-assisted plans because no
 * pure owned-breeding path existed. `fallback_used` is always false for
 * `"allowed"` and for owned-only (`include_wild=false`) solves. */
export interface SolveResponse {
  plans: BreedingPlan[];
  fallback_used: boolean;
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
  /** Partner-skill display name (every species has one, from the extraction). */
  partner_skill: string | null;
  /** Partner-skill effect description (real in-game text, from the extraction;
   * 299/299). Numeric values shown as a "(min~max)" range across ranks. */
  partner_skill_desc: string | null;
  /** Partner-skill description with `{0}`..`{N}` slot markers where a value
   * varies across partner-skill ranks (Lv1..LvN); constants baked in as
   * literals. null when nothing varies across ranks. Paired with
   * `partner_skill_values`. */
  partner_skill_template: string | null;
  /** Per-slot display values for `partner_skill_template`: outer index = slot
   * (`{0}`, `{1}`, …), inner = value per rank ascending (rank 1 first). Bare
   * numbers (unit is baked into the template text). Empty when no template. */
  partner_skill_values: string[][];
  /** Partner-skill icon key: numeric TextureID string when a PNG exists at
   * `public/partner/<id>.png`, else null (UI shows a generic fallback glyph). */
  partner_skill_icon: string | null;
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

/** One resolved level-up learnable move: save-side waza `id` (joins
 * `list_active_skills`) + the `level` it is learned at. */
export interface LearnMoveEntry {
  id: string;
  level: number;
}

/** Full detail (`paldex_species_detail`): the grid row plus breeding notes and
 * the level-up learnset (sorted by level ascending; empty when none). */
export interface SpeciesDetail extends SpeciesEntry {
  breeding: BreedingNotes;
  learnset: LearnMoveEntry[];
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
