// Presentation helpers shared across views: quality color bands, passive
// tiering, gender glyphs, duration/format. Pure functions returning Tailwind
// class fragments (defined against the tokens in index.css) or small data
// records, so components stay declarative and the color rules live in one place.

import type { ContainerKind, Gender } from "./types";

/** Compact human-readable duration: 2h05m, 9m30s, 45s, or the infinity glyph. */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs)) return "\u221e";
  const total = Math.round(secs);
  if (total <= 0) return "instant";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export interface GenderView {
  glyph: string;
  className: string;
  label: string;
}

/** Mars/Venus glyph + accent color; neutral dash for unresolved gender. */
export function genderView(gender: Gender | null): GenderView {
  if (gender === "Male")
    return { glyph: "\u2642", className: "text-el-water", label: "Male" };
  if (gender === "Female")
    return { glyph: "\u2640", className: "text-el-dragon", label: "Female" };
  return { glyph: "\u2015", className: "text-ink-faint", label: "Any" };
}

export type Quality = "good" | "fair" | "mid" | "low";

/** IV talent band (0-100). Thresholds mirror in-game "good roll" intuition. */
export function ivBand(v: number): Quality {
  if (v >= 90) return "good";
  if (v >= 70) return "fair";
  if (v >= 50) return "mid";
  return "low";
}

/** Text color for a quality band. */
export const QUALITY_TEXT: Record<Quality, string> = {
  good: "text-good",
  fair: "text-fair",
  mid: "text-ink-dim",
  low: "text-ink-faint",
};

/** Bar fill color for a quality band. */
export const QUALITY_FILL: Record<Quality, string> = {
  good: "bg-good",
  fair: "bg-fair",
  mid: "bg-ink-faint",
  low: "bg-bad/70",
};

/** Success-rate band for a breeding step probability (0-1). */
export function probBand(p: number): { text: string; ring: string; label: string } {
  const pct = p * 100;
  if (pct >= 75)
    return { text: "text-good", ring: "border-good/40 bg-good/10", label: "high" };
  if (pct >= 50)
    return { text: "text-fair", ring: "border-fair/40 bg-fair/10", label: "even" };
  if (pct >= 25)
    return { text: "text-warn", ring: "border-warn/40 bg-warn/10", label: "long" };
  return { text: "text-bad", ring: "border-bad/40 bg-bad/12", label: "rare" };
}

export type PassiveTone = "good" | "bad" | "special" | "neutral";

export interface PassiveView {
  label: string;
  tone: PassiveTone;
  tier: number; // 0 = no tier
  dir: "up" | "down" | null;
}

/** Tier -> roman numeral for passive rank badges. */
export const ROMAN = ["", "I", "II", "III", "IV", "V"];

/**
 * Parse a passive id into a display label, direction, tone, and rank tier.
 * Ids encode direction (up/down, any casing, with or without a separator:
 * "MoveSpeed_up_2", "CraftSpeed_down1", "PAL_Sanity_Up_1") and a rank digit.
 * "Rare"/"Legend" are prized specials; the rest are flavor traits. Localized
 * names live elsewhere but are absent in dev fixtures, so we humanize the id.
 */
export function passiveView(id: string): PassiveView {
  const raw = id.trim();
  if (raw === "(random)" || raw.toLowerCase() === "random")
    return { label: "random roll", tone: "neutral", tier: 0, dir: null };

  const dir: "up" | "down" | null = /_up/i.test(raw)
    ? "up"
    : /_down/i.test(raw)
      ? "down"
      : null;
  const tier = Number(raw.match(/[1-5]/)?.[0] ?? 0);

  let tone: PassiveTone = "neutral";
  if (/legend|rare|lucky|divine/i.test(raw)) tone = "special";
  else if (dir === "up") tone = "good";
  else if (dir === "down") tone = "bad";

  // Humanize: drop PAL_/`_PAL` affixes, up/down and rank tokens, split camelCase.
  const label = raw
    .replace(/^PAL_/i, "")
    .replace(/_PAL$/i, "")
    .split("_")
    .filter((t) => t && !/^\d+$/.test(t) && !/^(up|down)\d*$/i.test(t))
    .map((t) => t.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .join(" ")
    .trim();

  return { label: label || raw, tone, tier, dir };
}

export const PASSIVE_TONE: Record<PassiveTone, string> = {
  good: "border-good/35 bg-good/10 text-good",
  bad: "border-bad/35 bg-bad/10 text-bad",
  special: "border-amber/45 bg-amber/12 text-amber-bright",
  neutral: "border-line bg-raised text-ink-dim",
};

/** Short, human label for a container kind. */
export function containerLabel(kind: ContainerKind): string {
  switch (kind) {
    case "Palbox":
      return "Palbox";
    case "Party":
      return "Party";
    case "Base":
      return "Base";
    case "ViewingCage":
      return "Cage";
    case "GlobalPalStorage":
      return "Global";
    case "DimensionalPalStorage":
      return "Dimensional";
    default:
      return "Unknown";
  }
}

/** Pal rarity tier name, coarse-grained from the raw `Rarity` integer. */
export type RarityTierName = "Common" | "Rare" | "Epic" | "Legendary";

export interface RarityTier {
  name: RarityTierName;
  /** Color key: the `rarity-*` design token (`--color-rarity-<key>`). */
  tokenKey: "common" | "rare" | "epic" | "legendary";
}

/**
 * Bucket a species' raw `Rarity` number into one of the game's four rarity
 * bands. Boundaries (<=4 Common, <=7 Rare, <=10 Epic, else Legendary) are
 * corroborated by two independent community tools —
 * snmtriet/palworld (src/app/pals/page.tsx: common 0-4, rare 5-7, epic 8-10,
 * legendary 11+) and FearlessKenji/Paldeck (utility/paldeck.js getRarity:
 * <=4 Common, <=7 Rare, <=10 Epic, else Legendary) — and verified against
 * palcalc's db.json: the legendary pals (Frostallion(+Noct), Jetragon,
 * Paladius, Necromus, Bellanoir(+Libero), Neptilius) carry Rarity 20 while
 * every other species is 1-10, so the >10 cutoff isolates exactly them.
 */
export function rarityTier(n: number): RarityTier {
  if (n <= 4) return { name: "Common", tokenKey: "common" };
  if (n <= 7) return { name: "Rare", tokenKey: "rare" };
  if (n <= 10) return { name: "Epic", tokenKey: "epic" };
  return { name: "Legendary", tokenKey: "legendary" };
}

// --- Passive skill cards (paldb-style browse) -------------------------------
// The pack's passives carry a signed `rank` (-3..5), a list of structured
// `effects` ({type, value, target}), and an optional authored `description`.
// These helpers turn that raw data into the banner tint, the humanized effect
// lines, and the target annotations the passive card renders.

export type RankBand = "danger" | "neutral" | "gold";

/**
 * Passive rank -> color band. Negative ranks (debuffs) read as danger red; low
 * positive ranks (1-2) as a cool silver neutral; high ranks (3+, incl. the
 * rank-5 World Tree passives) as the gold/legendary amber accent.
 */
export function rankBand(rank: number): RankBand {
  if (rank < 0) return "danger";
  if (rank >= 3) return "gold";
  return "neutral";
}

/**
 * Literal `text-*` utility per band. Referencing the generated class (not a raw
 * `var(--color-*)`) is what makes Tailwind v4 emit the token, and it sets
 * `currentColor` so the banner's gradient + border can `color-mix` off it
 * (the same self-tinting trick as RarityBadge).
 */
export const RANK_TINT: Record<RankBand, string> = {
  danger: "text-bad",
  neutral: "text-ink-dim",
  gold: "text-amber",
};

/**
 * Human-readable label for a passive effect enum. The common combat/work/util
 * types are mapped explicitly; the element damage/resistance families are
 * derived ("ElementBoost_Fire" -> "Fire Attack"); anything unmapped falls back
 * to a humanized enum name so an effect is never hidden.
 */
const EFFECT_LABEL: Record<string, string> = {
  ShotAttack: "Attack",
  Defense: "Defense",
  MaxHP: "Max Health",
  CraftSpeed: "Work Speed",
  MoveSpeed: "Movement Speed",
  SwimSpeed: "Swim Speed",
  MaxInventoryWeight: "Carry Capacity",
  CollectItem: "Gathering",
  CollectItemDrop_NaturalObject: "Gathering Drops",
  CaptureLevel: "Capture Power",
  Sanity_Decrease: "SAN Loss",
  FullStomatch_Decrease: "Hunger Loss",
  AutoHPRegeneRate: "HP Regeneration",
  ActiveSkillCoolTime_Decrease: "Skill Cooldown",
  ExplosionResist: "Explosion Resistance",
  TemperatureResist_Cold: "Cold Resistance",
  TemperatureResist_Heat: "Heat Resistance",
  JumpCount_Increase: "Jump Count",
  RideJumpCount_Increase: "Mount Jump Count",
  JumpPower_Increase: "Jump Power",
  AirDash: "Air Dash",
  LifeSteal: "Life Steal",
  PalExp_Increase: "Pal EXP",
  PalSP_Increase: "Pal SP",
  PlayerSP_DecreaseRate: "Player SP Cost",
  ShopSellPrice_Money_Increase: "Sell Price",
  ShopBuyPrice_Money_Increase: "Buy Price",
  SelfDeathAddItemDrop: "Death Drops",
  WorldTreeDecayImmunity: "World Tree Decay Immunity",
  FriendshipPoint_Increase: "Friendship Gain",
  PalEggHatchingSpeed: "Egg Hatching Speed",
  BreedSpeed: "Breeding Speed",
  BreedSpeed_InBaseCamp: "Base Breeding Speed",
  ReloadSpeedUp: "Reload Speed",
  AvoidDurationUp_EquipSkill: "Dodge Duration",
  NonKilling: "Non-Lethal Capture",
  Nocturnal: "Nocturnal",
  NightOwl: "Night Owl",
  InvalidToxicGas: "Toxic Gas Immunity",
  KnockbackInvalid_ForPassiveSkill: "Knockback Immunity",
  LeanBackInvalid_ForPassiveSkill: "Stagger Immunity",
  Defuser_ExplosiveSpore: "Spore Defusal",
  ResistAdditionalEffect_Burn: "Burn Resistance",
  ResistAdditionalEffect_Poison: "Poison Resistance",
  WorkSuitabilityAddRank_MonsterFarm: "Ranch Work Rank",
  Logging: "Logging",
  Mining: "Mining",
  CurveType: "Curve Type",
};

export function effectLabel(type: string): string {
  const explicit = EFFECT_LABEL[type];
  if (explicit) return explicit;
  let m = type.match(/^ElementBoost_(.+)$/);
  if (m) return `${m[1]} Attack`;
  m = type.match(/^(?:ElementResist|TemperatureResist|ResistAdditionalEffect)_(.+)$/);
  if (m) return `${m[1]} Resistance`;
  // Fallback: humanize the enum (never hide) — drop qualifier suffixes, split
  // underscores + camelCase, then space-normalize.
  return type
    .replace(/_ForPassiveSkill$/, "")
    .replace(/_(?:Increase|Decrease|Up)$/, "")
    .split("_")
    .map((seg) => seg.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Effect enums whose `value` is a raw count/level, not a percent. Everything
 * else is a percentage multiplier (Attack +50%, Work Speed -30%, ...).
 */
const EFFECT_COUNT_UNITS: Record<string, true> = {
  AirDash: true,
  JumpCount_Increase: true,
  RideJumpCount_Increase: true,
  CaptureLevel: true,
  CurveType: true,
  Defuser_ExplosiveSpore: true,
  WorkSuitabilityAddRank_MonsterFarm: true,
};

/**
 * Signed, unit-aware value string for one effect. A zero value marks a flag /
 * toggle passive (e.g. Nocturnal, Toxic Gas Immunity) whose label stands alone,
 * so we return "" and the card renders no number.
 */
export function formatEffectValue(type: string, value: number): string {
  if (value === 0) return "";
  const suffix = EFFECT_COUNT_UNITS[type] ? "" : "%";
  return `${value > 0 ? "+" : ""}${value}${suffix}`;
}

const TARGET_LABEL: Record<string, string> = {
  ToSelf: "self",
  ToOtomo: "party",
  ToTrainer: "player",
  ToBuildObject: "structures",
  ToSelfAndTrainer: "self & player",
};

/** Quiet "(self)"-style scope annotation; null when the effect has no target. */
export function effectTarget(target: string): string | null {
  if (!target || target === "None") return null;
  return (
    TARGET_LABEL[target] ??
    target
      .replace(/^To/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
  );
}
