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
}
