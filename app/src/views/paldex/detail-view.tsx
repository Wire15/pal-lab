import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../lib/tauri";
import type {
  ChildResult,
  NamedEntry,
  OwnedPal,
  ParentsResult,
  PlayerRef,
  RosterCounts,
  SpeciesDetail,
  SpeciesRef,
} from "../../lib/types";
import {
  containerLabel,
  genderView,
  ivBand,
  QUALITY_FILL,
  QUALITY_TEXT,
  rarityTier,
} from "../../lib/ui";
import { PalIcon, Tag } from "../../components/primitives";
import { PassiveStrip } from "../../components/passive-strip";
import { PalHoverCard } from "../../components/pal-hover-card";
import { ElementBanners } from "../../components/element";
import { WorkGlyph, nonzeroWork } from "../../components/work-suit";
import { PartnerIcon } from "../../components/partner";
import { hexGuid } from "../../components/palbox/selectors";
import { ActiveSkillRow } from "../../components/active-skill";
import { loadActiveSkills, type ActiveSkills } from "../../lib/active-skills";
import { useAppState } from "../../state";

/** Parent pairs shown before collapsing into an "and N more" note. */
const PAIR_PREVIEW = 12;

/** Slots in the game-style food demand meter (matches paldb's 10-pip bar). */
const FOOD_PIPS = 10;

/** Soft per-stat reference caps (observed pack maxima) for the stat bars. */
const STAT_MAX = { hp: 180, attack: 150, defense: 200 } as const;

/** Soft per-metric caps (~p95 of the pack) for the movement bars; the fastest
 * legendaries saturate (clamped), so a common pal's bar stays readable. */
const MOVE_MAX = {
  walk: 300,
  run: 1000,
  sprint: 1600,
  transport: 600,
  slow: 150,
} as const;

/** A clickable species reference (icon + name + dex #) for in-dex navigation. */
function SpeciesCell({
  sp,
  onNavigate,
  size = 26,
}: {
  sp: SpeciesRef;
  onNavigate: (id: string) => void;
  size?: number;
}) {
  return (
    <PalHoverCard speciesId={sp.id}>
      <button
        onClick={() => onNavigate(sp.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-hover"
      >
        <PalIcon id={sp.id} name={sp.name} size={size} />
        <div className="min-w-0">
          <div className="truncate text-[12px] text-ink">{sp.name}</div>
          <div className="font-mono text-[10px] tabular-nums text-ink-faint">
            #{String(sp.paldex_no).padStart(3, "0")}
          </div>
        </div>
      </button>
    </PalHoverCard>
  );
}

/** A panel with a mono eyebrow header, matching the Solver plan containers. */
function Section({
  eyebrow,
  right,
  children,
}: {
  eyebrow: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-panel/40">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-raised px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-dim">
          {eyebrow}
        </span>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * Literal `text-rarity-*` utility per tier. Using the generated class (not a raw
 * `var(--color-rarity-*)`) is what makes Tailwind v4 emit the token to `:root`,
 * so the badge is self-sufficient and never depends on another component pulling
 * the rarity utilities into the bundle.
 */
const RARITY_TEXT: Record<string, string> = {
  common: "text-rarity-common",
  rare: "text-rarity-rare",
  epic: "text-rarity-epic",
  legendary: "text-rarity-legendary",
};

/** Rarity tier as a token-tinted badge (name loud, raw number as a quiet tooltip). */
function RarityBadge({ rarity }: { rarity: number }) {
  const tier = rarityTier(rarity);
  return (
    <span
      title={`Rarity ${rarity}`}
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider ${RARITY_TEXT[tier.tokenKey]}`}
      style={{
        borderColor: "color-mix(in srgb, currentColor 45%, transparent)",
        backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {tier.name}
    </span>
  );
}

/** One base stat: label, right-aligned mono value, and a normalized bar. */
function StatRow({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  const pct = Math.max(4, Math.min(100, Math.round((value / max) * 100)));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        <span className="font-mono text-[15px] font-semibold tabular-nums text-ink">
          {value}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-abyss">
        <div className="h-full rounded-full bg-amber/80" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The game-style food demand meter: `amount` filled pips out of {@link FOOD_PIPS}. */
function FoodMeter({ amount }: { amount: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex gap-0.5">
        {Array.from({ length: FOOD_PIPS }, (_, i) => (
          <span
            key={i}
            className={`h-3.5 w-1.5 rounded-[1px] ${i < amount ? "bg-amber" : "bg-abyss ring-1 ring-line/70"}`}
          />
        ))}
      </div>
      <span className="font-mono text-[11px] tabular-nums text-ink-dim">
        {amount}/{FOOD_PIPS}
      </span>
    </div>
  );
}

/** One movement metric: mono label, right-aligned value, thin cool bar. A
 * negative value means the pal can't do it (not rideable / can't haul) → an em
 * dash and no bar, never a fake `0`. */
function MoveRow({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  const na = value < 0;
  const pct = na ? 0 : Math.max(4, Math.min(100, Math.round((value / max) * 100)));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">
          {na ? "\u2014" : value}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-abyss">
        {!na && (
          <div className="h-full rounded-full bg-ink-dim/70" style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}

/** A compact field-data cell: mono eyebrow label above its value, for the
 * Field-data spec grid. */
function FactCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      <div className="flex items-baseline gap-1.5 text-[13px] text-ink">{children}</div>
    </div>
  );
}

/** One best-IV talent: mono numeral tinted by quality with a thin bar. */
function BestIv({ label, value }: { label: string; value: number }) {
  const band = ivBand(value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        <span className={`font-mono text-[13px] font-semibold tabular-nums ${QUALITY_TEXT[band]}`}>
          {value}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-abyss">
        <div className={`h-full rounded-full ${QUALITY_FILL[band]}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/** A labelled provenance row: mono faint label left, value right. Moved here
 *  from the retired palbox detail panel (owner/location/slot/instance). */
function InstanceRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-right text-[13px] text-ink">{children}</dd>
    </div>
  );
}

/**
 * The your-pal band: an owned instance's save data grafted onto the top of the
 * species page. Amber-accented so it reads as "this is *your* pal" and native
 * to the hero, not a bolted-on panel. Renders the instance's vitals, IV bars,
 * equipped passives (as in-game strips), equipped active skills resolved to
 * real names, and its owner/storage provenance with an instance-id copy.
 */
function YourPalSection({
  pal,
  players,
  speciesName,
}: {
  pal: OwnedPal;
  players: PlayerRef[];
  speciesName: string;
}) {
  const g = genderView(pal.gender);
  const ownerHex = pal.owner_player_uid ? hexGuid(pal.owner_player_uid) : null;
  const owner = ownerHex
    ? players.find((p) => p.uid === ownerHex)?.name ?? null
    : null;
  const instanceHex = hexGuid(pal.instance_id);
  const skills = pal.active_skills ?? [];
  const title = pal.nickname?.trim() || speciesName;
  const [copied, setCopied] = useState(false);
  const [activeMap, setActiveMap] = useState<ActiveSkills>({});

  useEffect(() => {
    loadActiveSkills().then(setActiveMap).catch(() => {});
  }, []);

  function copyId() {
    navigator.clipboard
      ?.writeText(instanceHex)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }

  return (
    <section className="overflow-hidden rounded-lg border border-amber/40 bg-amber/[0.05]">
      <header className="flex items-center justify-between gap-3 border-b border-amber/25 bg-amber/[0.06] px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
          Your pal
        </span>
        <div className="flex items-center gap-3 font-mono text-[12px] tabular-nums">
          <span className="text-ink-dim">
            <span className="text-ink-faint">Lv </span>
            <span className="text-ink">{pal.level}</span>
          </span>
          {pal.rank > 0 && (
            <span className="text-amber" title={`Condensation rank ${pal.rank}`}>
              {"\u2605".repeat(pal.rank)}
            </span>
          )}
        </div>
      </header>

      <div className="flex flex-col gap-5 p-4">
        {/* Identity + vitals */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="min-w-0 truncate font-display text-xl font-bold tracking-wide text-ink">
            {title}
          </h2>
          {pal.is_boss && <Tag tone="boss">Alpha</Tag>}
          <span className="flex items-center gap-1.5 text-[13px]" title={g.label}>
            <span className={`text-base leading-none ${g.className}`}>{g.glyph}</span>
            <span className="text-ink-dim">{g.label}</span>
          </span>
          {pal.nickname?.trim() && (
            <span className="font-mono text-[12px] text-ink-faint">{speciesName}</span>
          )}
        </div>

        {/* IVs + provenance, two-up on wide */}
        <div className="grid gap-5 sm:grid-cols-[1fr_1fr]">
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
              IV talents
            </span>
            <div className="grid grid-cols-3 gap-4">
              <BestIv label="HP" value={pal.ivs.hp} />
              <BestIv label="ATK" value={pal.ivs.attack} />
              <BestIv label="DEF" value={pal.ivs.defense} />
            </div>
          </div>
          <dl className="flex flex-col gap-1.5">
            <InstanceRow label="Owner">{owner ?? "\u2014"}</InstanceRow>
            <InstanceRow label="Location">
              <Tag>{containerLabel(pal.container_kind)}</Tag>
            </InstanceRow>
            {pal.slot_index !== null && (
              <InstanceRow label="Slot">
                <span className="font-mono tabular-nums text-ink-dim">
                  {pal.slot_index}
                </span>
              </InstanceRow>
            )}
            <InstanceRow label="Instance">
              <button
                onClick={copyId}
                title="Copy instance id"
                className="max-w-[20ch] truncate font-mono text-[11px] text-ink-dim transition-colors hover:text-amber"
              >
                {copied ? "Copied!" : instanceHex}
              </button>
            </InstanceRow>
          </dl>
        </div>

        {/* Equipped passives */}
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Equipped passives
          </span>
          {pal.passives.length > 0 ? (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {pal.passives.map((p, i) => (
                <PassiveStrip key={`${p}-${i}`} id={p} size="md" />
              ))}
            </div>
          ) : (
            <span className="text-[13px] text-ink-faint">No passives.</span>
          )}
        </div>

        {/* Equipped active skills, resolved to real name + element/power/CT/desc */}
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Equipped active skills
          </span>
          {skills.length > 0 ? (
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {skills.map((s, i) => (
                <ActiveSkillRow key={`${s}-${i}`} id={s} skill={activeMap[s] ?? null} />
              ))}
            </div>
          ) : (
            <span className="text-[13px] text-ink-faint">Not recorded.</span>
          )}
        </div>
      </div>
    </section>
  );
}

export default function PaldexDetail({
  id,
  roster,
  instance,
  players,
  onBack,
  onNavigate,
}: {
  id: string;
  roster: RosterCounts | null;
  /** Owned instance to enrich this page with, or null for a species-only view. */
  instance: OwnedPal | null;
  /** Players from the loaded save, for resolving the instance's owner name. */
  players: PlayerRef[];
  onBack: () => void;
  onNavigate: (id: string) => void;
}) {
  const { requestSolve, setView } = useAppState();
  const [detail, setDetail] = useState<SpeciesDetail | null>(null);
  const [parents, setParents] = useState<ParentsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<NamedEntry[]>([]);
  const [secondName, setSecondName] = useState("");
  const [child, setChild] = useState<ChildResult | null>(null);
  const [childLoading, setChildLoading] = useState(false);

  useEffect(() => {
    invoke<NamedEntry[]>("list_species").then(setNames).catch(() => {});
  }, []);

  useEffect(() => {
    setDetail(null);
    setParents(null);
    setError(null);
    setSecondName("");
    setChild(null);
    invoke<SpeciesDetail>("paldex_species_detail", { id })
      .then(setDetail)
      .catch((e) => setError(String(e)));
    invoke<ParentsResult>("breeding_parents", { child: id })
      .then(setParents)
      .catch(() => setParents({ total: 0, pairs: [] }));
  }, [id]);

  const nameToId = useMemo(() => new Map(names.map((n) => [n.name, n.id])), [names]);

  async function breedWith(secondId: string) {
    setChildLoading(true);
    try {
      setChild(await invoke<ChildResult>("breeding_child", { parentA: id, parentB: secondId }));
    } catch {
      setChild({ child: null });
    } finally {
      setChildLoading(false);
    }
  }

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <DetailBar onBack={onBack} />
        <div className="m-6 rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex h-full flex-col">
        <DetailBar onBack={onBack} />
        <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
          Loading&#8230;
        </div>
      </div>
    );
  }

  const malePct = Math.round(detail.male_probability * 100);
  const femalePct = 100 - malePct;
  const owned = roster?.[id];
  const ownedTotal = owned ? owned.male + owned.female : 0;
  const uniqueCombos = detail.breeding.unique_combos;
  const work = nonzeroWork(detail.work_suitability);
  const [wildMin, wildMax] = detail.wild_levels;
  const wildCatchable = wildMin > 0 || wildMax > 0;
  const hasPartner = detail.partner_skill != null;
  const s = detail.stats;
  // The your-pal band renders only for the owned instance whose species this
  // page is — guarded so a stale/mismatched instance never shows here.
  const yourPal = instance && instance.character_id === id ? instance : null;

  return (
    <div className="flex h-full flex-col">
      <DetailBar onBack={onBack} />

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          {/* Hero header */}
          <div className="flex flex-wrap items-start gap-5 rounded-lg border border-line bg-panel px-5 py-5">
            <PalIcon id={detail.id} name={detail.name} size={120} className="!rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-wider">
                <span className="tabular-nums text-amber">
                  #{String(detail.paldex_no).padStart(3, "0")}
                </span>
                <RarityBadge rarity={detail.stats.rarity} />
                <span className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-raised px-2 py-0.5">
                  <span className="text-ink-faint">Size</span>
                  <span className="text-ink">{s.size}</span>
                </span>
                {detail.is_variant && <Tag tone="boss">Variant</Tag>}
                {detail.nocturnal && (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-el-dark/45 bg-el-dark/12 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-el-dark">
                    {"\u263e"} Nocturnal
                  </span>
                )}
              </div>
              <h1 className="font-display text-3xl font-bold tracking-wide text-ink">
                {detail.name}
              </h1>
              <ElementBanners elements={detail.elements} />
              {/* Gender ratio bar */}
              <div className="mt-1 max-w-sm">
                <div className="mb-1 flex justify-between font-mono text-[10px] tabular-nums">
                  <span className="text-el-water">{"\u2642"} {malePct}%</span>
                  <span className="text-el-dragon">{femalePct}% {"\u2640"}</span>
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-full bg-abyss">
                  <div className="h-full bg-el-water" style={{ width: `${malePct}%` }} />
                  <div className="h-full bg-el-dragon" style={{ width: `${femalePct}%` }} />
                </div>
              </div>
            </div>
            <button
              onClick={() => requestSolve(detail.name)}
              className="rounded-md bg-amber px-4 py-2 text-[13px] font-semibold text-abyss transition-colors hover:bg-amber-bright"
            >
              Solve for this pal
            </button>
          </div>

          {/* Your pal — save-data enrichment for the opened owned instance. */}
          {yourPal && (
            <YourPalSection
              pal={yourPal}
              players={players}
              speciesName={detail.name}
            />
          )}

          {/* Partner skill — only when the pack carries one (~130 species lack it). */}
          {hasPartner && (
            <Section eyebrow="Partner skill">
              <div className="flex items-start gap-4">
                <PartnerIcon iconId={detail.partner_skill_icon} size={96} />
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="font-display text-lg font-semibold tracking-wide text-amber-bright">
                    {detail.partner_skill}
                  </span>
                  {detail.partner_skill_desc && (
                    <p className="max-w-3xl whitespace-pre-line text-[13px] leading-relaxed text-ink-dim">
                      {detail.partner_skill_desc}
                    </p>
                  )}
                </div>
              </div>
            </Section>
          )}

          {/* Base stats + movement */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Section eyebrow="Base stats">
              <div className="flex flex-col gap-3.5">
                <StatRow label="Health" value={s.hp} max={STAT_MAX.hp} />
                <StatRow label="Attack" value={s.attack} max={STAT_MAX.attack} />
                <StatRow label="Defense" value={s.defense} max={STAT_MAX.defense} />
              </div>
            </Section>

            <Section eyebrow="Movement">
              <div className="flex flex-col gap-3">
                <MoveRow label="Walk" value={s.walk_speed} max={MOVE_MAX.walk} />
                <MoveRow label="Run" value={s.run_speed} max={MOVE_MAX.run} />
                <MoveRow label="Ride sprint" value={s.ride_sprint_speed} max={MOVE_MAX.sprint} />
                <MoveRow label="Transport" value={s.transport_speed} max={MOVE_MAX.transport} />
                <MoveRow label="Slow walk" value={s.slow_walk_speed} max={MOVE_MAX.slow} />
              </div>
            </Section>
          </div>

          {/* Field data — spec sheet */}
          <Section eyebrow="Field data">
            <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
              <div className="col-span-2 sm:col-span-3">
                <FactCell label="Food">
                  <FoodMeter amount={detail.food_amount} />
                </FactCell>
              </div>
              <FactCell label="Stamina">
                <span className="font-mono font-semibold tabular-nums">{s.stamina}</span>
              </FactCell>
              <FactCell label="Breeding power">
                <span className="font-mono font-semibold tabular-nums">{detail.combi_rank}</span>
              </FactCell>
              <FactCell label="Craft speed">
                <span className="font-mono font-semibold tabular-nums">{s.craft_speed}</span>
              </FactCell>
              <FactCell label="Price">
                <span className="font-mono font-semibold tabular-nums text-amber">
                  {s.price.toLocaleString()}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  gold
                </span>
              </FactCell>
              {wildCatchable && (
                <FactCell label="Wild level">
                  <span className="font-mono tabular-nums">
                    {wildMin === wildMax ? wildMin : `${wildMin}\u2013${wildMax}`}
                  </span>
                </FactCell>
              )}
              <FactCell label="Activity">
                <span className={detail.nocturnal ? "text-el-dark" : "text-ink-dim"}>
                  {detail.nocturnal ? "\u263e Nocturnal" : "\u2600 Diurnal"}
                </span>
              </FactCell>
            </div>
          </Section>

          {/* Work suitability */}
          <Section
            eyebrow="Work suitability"
            right={
              work.length > 0 ? (
                <span className="font-mono text-[11px] tabular-nums text-ink-dim">
                  {work.length} {work.length === 1 ? "job" : "jobs"}
                </span>
              ) : undefined
            }
          >
            {work.length > 0 ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                {work.map((w) => (
                  <div key={w.kind} className="flex items-center gap-2">
                    <WorkGlyph kind={w.kind} size={22} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-dim">
                      {w.label}
                    </span>
                    <span className="font-mono text-[12px] font-semibold tabular-nums text-ink">
                      Lv{w.level}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-ink-faint">
                No work suitability &mdash; not a base worker.
              </p>
            )}
          </Section>

          {/* Guaranteed passives + your roster */}
          <div className="grid gap-5 lg:grid-cols-[1fr_1.35fr]">
            <Section eyebrow="Guaranteed passives">
              {detail.guaranteed_passives.length > 0 ? (
                <div className="grid grid-cols-1 gap-1.5">
                  {detail.guaranteed_passives.map((p) => (
                    <PassiveStrip key={p.id} id={p.id} size="md" />
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-ink-faint">
                  No guaranteed passives &mdash; every roll is random.
                </p>
              )}
            </Section>

            <Section
              eyebrow="Your roster"
              right={
                ownedTotal > 0 ? (
                  <button
                    onClick={() => setView("save")}
                    className="font-mono text-[10px] uppercase tracking-wider text-amber transition-colors hover:text-amber-bright"
                  >
                    View in Roster &rarr;
                  </button>
                ) : undefined
              }
            >
              {ownedTotal > 0 ? (
                <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
                  <div className="flex items-center gap-5">
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                        Owned
                      </span>
                      <span className="font-mono text-2xl font-semibold tabular-nums text-ink">
                        {ownedTotal}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1 font-mono text-[13px] tabular-nums">
                      <span className="text-el-water">{"\u2642"} {owned!.male} male</span>
                      <span className="text-el-dragon">{"\u2640"} {owned!.female} female</span>
                    </div>
                  </div>
                  <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      Best IVs owned
                    </span>
                    <div className="grid grid-cols-3 gap-4">
                      <BestIv label="HP" value={owned!.best_ivs.hp} />
                      <BestIv label="ATK" value={owned!.best_ivs.atk} />
                      <BestIv label="DEF" value={owned!.best_ivs.def} />
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-[13px] text-ink-faint">
                  {roster
                    ? `You don't own any ${detail.name} yet.`
                    : "Load a save in the Roster view to see how many you own and their best IVs."}
                </p>
              )}
            </Section>
          </div>

          {/* Breeding */}
          <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
            <Section
              eyebrow="How to breed this pal"
              right={
                parents && parents.total > 0 ? (
                  <span className="font-mono text-[11px] tabular-nums text-ink-dim">
                    <span className="text-amber">{parents.total}</span> parent pairs
                  </span>
                ) : undefined
              }
            >
              {parents === null ? (
                <p className="text-[13px] text-ink-faint">Loading pairs&#8230;</p>
              ) : parents.total === 0 ? (
                <p className="text-[13px] text-ink-faint">
                  No breeding pairs produce {detail.name} &mdash; it is only found in the wild.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    {parents.pairs.slice(0, PAIR_PREVIEW).map((pair, i) => (
                      <div
                        key={`${pair.parent_a.id}-${pair.parent_b.id}-${i}`}
                        className="flex items-center rounded-md border border-line-soft"
                      >
                        <SpeciesCell sp={pair.parent_a} onNavigate={onNavigate} />
                        <span className="px-1 font-mono text-[11px] text-ink-faint">&times;</span>
                        <SpeciesCell sp={pair.parent_b} onNavigate={onNavigate} />
                      </div>
                    ))}
                  </div>
                  {parents.total > PAIR_PREVIEW && (
                    <p className="mt-2 font-mono text-[11px] text-ink-faint">
                      and {parents.total - PAIR_PREVIEW} more pairs&#8230;
                    </p>
                  )}
                </div>
              )}
            </Section>

            <Section eyebrow="Breed with&#8230;">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 rounded-md border border-line bg-abyss px-2 py-1 focus-within:border-amber/60">
                  <PalIcon id={nameToId.get(secondName) ?? null} name={secondName || "partner"} size={26} />
                  <input
                    className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
                    list="breed-partner-options"
                    placeholder="Pick a second parent"
                    value={secondName}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setSecondName(v);
                      const secId = nameToId.get(v);
                      if (secId) breedWith(secId);
                      else setChild(null);
                    }}
                  />
                  <datalist id="breed-partner-options">
                    {names.map((n) => (
                      <option key={n.id} value={n.name} />
                    ))}
                  </datalist>
                </div>

                <div className="flex items-center justify-center gap-3 rounded-md bg-abyss/40 px-3 py-4">
                  <PalIcon id={detail.id} name={detail.name} size={30} />
                  <span className="font-mono text-[11px] text-ink-faint">+</span>
                  <PalIcon id={nameToId.get(secondName) ?? null} name={secondName || "?"} size={30} />
                  <span className="font-mono text-sm text-amber">&rarr;</span>
                  {childLoading ? (
                    <span className="font-mono text-[12px] text-ink-faint">&#8230;</span>
                  ) : child?.child ? (
                    <SpeciesCell sp={child.child} onNavigate={onNavigate} size={30} />
                  ) : nameToId.get(secondName) ? (
                    <span className="text-[12px] text-ink-faint">No known result</span>
                  ) : (
                    <PalIcon id={null} name="child" size={30} />
                  )}
                </div>
                <p className="text-[12px] text-ink-faint">
                  Choose any pal to see what it produces with {detail.name}.
                </p>
              </div>
            </Section>
          </div>

          {/* Gender-locked combos, when the pack pins them */}
          {uniqueCombos.length > 0 && (
            <Section
              eyebrow="Gender-locked combos"
              right={
                <span className="font-mono text-[11px] tabular-nums text-ink-dim">
                  {uniqueCombos.length}
                </span>
              }
            >
              <div className="flex flex-col gap-1">
                {uniqueCombos.map((combo, i) => (
                  <div
                    key={`${combo.parent_a.id}-${combo.parent_b.id}-${i}`}
                    className="flex flex-wrap items-center rounded-md border border-line-soft"
                  >
                    <SpeciesCell sp={combo.parent_a} onNavigate={onNavigate} />
                    <span className="px-1 font-mono text-[11px] text-ink-faint">&times;</span>
                    <SpeciesCell sp={combo.parent_b} onNavigate={onNavigate} />
                    <span className="px-2 font-mono text-sm text-amber">&rarr;</span>
                    <SpeciesCell sp={combo.child} onNavigate={onNavigate} />
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Sticky back bar shared by every detail state (loading / error / loaded). */
function DetailBar({ onBack }: { onBack: () => void }) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel/60 px-6 py-3">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
      >
        <span className="text-[14px] leading-none">&larr;</span> All pals
      </button>
      <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
        Pal-dex
      </span>
    </header>
  );
}
