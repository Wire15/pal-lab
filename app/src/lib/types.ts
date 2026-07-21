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

export interface BreedingPlan {
  root: PlanNode;
  total_time_secs: number;
  total_steps: number;
  total_wild_pals: number;
}
