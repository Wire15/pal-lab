// The Solver's BREEDING SETUP panel (Wave 2, slice C). Surfaces the three farm
// knobs that bend a breeding plan's real-world time — the world's egg-hatch
// setting, the partner/passive breeding boosters you own (or could), and the
// breeding cake — and composes them into the shared `useBreedingSetup` store
// the solve request and the IV Lab both read.
//
// Everything here is an ESTIMATE from extracted game data: the boosters' per-
// rank fractions and the honest caveat that mixed-source stacking is untested
// in-game. The panel owns its own UI state (which boosters are toggled, the
// manual hatch-hours entry) persisted to localStorage, and derives the composed
// `BreedingSetup` from it + the loaded roster, syncing that into the store.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../lib/tauri";
import type {
  BreedingBoostEntry,
  BreedingEffect,
  BreedingSetup,
  CakeToken,
  LabResearchEntry,
  WorldOptionsResponse,
} from "../lib/types";
import { PalIcon } from "./primitives";
import { formatDuration } from "../lib/ui";
import { useAppState, useBreedingSetup } from "../state";

/** localStorage keys for this panel's own UI inputs (the composed setup itself
 * lives in the shared store). */
const SELECTED_KEY = "pal-lab.setup.boosters";
const MANUAL_HATCH_KEY = "pal-lab.setup.manualHatch";
/** Map of lab-research line key -> researched rank (0 = not researched). */
const RESEARCH_KEY = "pal-lab.setup.research";

/** Farm-speed boosts shorten each breed attempt as `time / (1 + bonus)`, so a
 * `+bonus` fraction reduces breed time by this percentage (non-linear). */
function breedTimeReductionPct(bonus: number): number {
  return Math.round((1 - 1 / (1 + bonus)) * 100);
}

const CAKES: { token: CakeToken; label: string; note: string }[] = [
  { token: "normal", label: "None", note: "No cake \u2014 base inherit odds." },
  { token: "mushroom", label: "Mushroom", note: "Raises the inherited IV floor." },
  { token: "vegetable", label: "Vegetable", note: "Two eggs per breeding cycle." },
  { token: "deluxe_vegetable", label: "Deluxe Veg", note: "Raises the inherited IV floor." },
  { token: "special", label: "Special", note: "All parent passives inherit." },
];

const CAKE_LABEL: Record<CakeToken, string> = {
  normal: "No",
  mushroom: "Mushroom",
  vegetable: "Vegetable",
  deluxe_vegetable: "Deluxe Veg",
  special: "Special",
};

/** True when the setup + cake carry no deviation from the vanilla neutral farm
 * (no boosters, vanilla 72h hatch, no cake) — the Solver hides its summary line
 * then. Exported so the Solver keys its summary off the same definition. */
export function isNeutralSetup(setup: BreedingSetup, cake: CakeToken): boolean {
  return (
    setup.farm_speed_bonus === 0 &&
    setup.incubation_reduction === 0 &&
    setup.extra_egg_chance === 0 &&
    setup.egg_hatch_hours === 72 &&
    cake === "normal"
  );
}

/** Human-readable parts of a setup+cake, e.g.
 * `["-33% breed time", "+75% eggs", "1h hatch", "Vegetable cake"]`. Shared by
 * the panel's applied line and the Solver's above-plan summary so they never
 * drift. Empty when neutral. */
export function describeSetup(setup: BreedingSetup, cake: CakeToken): string[] {
  const parts: string[] = [];
  if (setup.farm_speed_bonus > 0)
    parts.push(`-${breedTimeReductionPct(setup.farm_speed_bonus)}% breed time`);
  if (setup.extra_egg_chance > 0)
    parts.push(`+${Math.round(setup.extra_egg_chance * 100)}% eggs`);
  if (setup.incubation_reduction > 0)
    parts.push(`-${Math.round(setup.incubation_reduction * 100)}% incubation`);
  if (setup.egg_hatch_hours !== 72)
    parts.push(`${+setup.egg_hatch_hours.toFixed(2)}h hatch`);
  if (cake !== "normal") parts.push(`${CAKE_LABEL[cake]} cake`);
  return parts;
}

/** A single effect a booster applies, at the rank/value that will actually be
 * used (owned instance's best condensation rank, or max-rank what-if). */
interface BoosterEffect {
  effect: BreedingEffect;
  value: number;
}

/** One booster row: a partner skill or a passive, its effort-affecting effects,
 * whether the loaded roster owns it (and at what condensation rank). */
interface Booster {
  source: string;
  displayName: string;
  isPassive: boolean;
  owned: boolean;
  /** Best owned condensation rank (0-based), only meaningful for owned partners. */
  bestRank: number;
  /** Highest condensation index the values array carries (partner what-if cap). */
  maxRank: number;
  effects: BoosterEffect[];
}

/** One-line summary of a booster's effects, e.g. `-33% breed time` or, for a
 * multi-effect passive, `-23% breed time \u00b7 -30% hatch time`. */
function effectSummary(effects: BoosterEffect[]): string {
  return effects
    .map((e) => {
      if (e.effect === "farm_speed") return `-${breedTimeReductionPct(e.value)}% breed time`;
      if (e.effect === "incubation_speed") return `-${Math.round(e.value * 100)}% hatch time`;
      if (e.effect === "extra_egg_chance") return `+${Math.round(e.value * 100)}% eggs`;
      return "";
    })
    .filter(Boolean)
    .join(" \u00b7 ");
}

/** One deduped lab-research line the panel offers: its display name, the
 * cumulative incubation-speed fraction per rank (1-based; `values[k-1]` for rank
 * `k`), and a stable key used to persist the chosen rank. */
interface ResearchLine {
  key: string;
  name: string;
  values: number[];
  maxRank: number;
}

/** Collapse the raw lab-research catalogue into distinct offerable lines. The two
 * shipped branches (Kindling/Cooling) carry the identical "Incubation Acceleration"
 * curve, so we dedupe by (name, effect, curve): one buff, one selectable row, no
 * double-count. Only incubation-speed lines are surfaced (they compose into
 * `incubation_reduction`). */
function dedupeResearch(entries: LabResearchEntry[]): ResearchLine[] {
  const seen = new Set<string>();
  const lines: ResearchLine[] = [];
  for (const e of entries) {
    if (e.effect !== "incubation_speed") continue;
    const key = `${e.name}|${e.effect}|${e.values_per_rank.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ key, name: e.name, values: e.values_per_rank, maxRank: e.values_per_rank.length });
  }
  return lines;
}

export function BreedingSetupPanel() {
  const { saveDir, saveSummary } = useAppState();
  const {
    setup,
    cake,
    setSetup,
    setCake,
    surgery,
    genderReverser,
    setSurgery,
    setGenderReverser,
  } = useBreedingSetup();
  // Memoized: a fresh `[]` every render (saveSummary null) destabilizes the
  // boosters memo + save-switch revalidation effect into an update loop.
  const pals = useMemo(() => saveSummary?.pals ?? [], [saveSummary]);

  const [boosts, setBoosts] = useState<BreedingBoostEntry[]>([]);
  const [boostsLoaded, setBoostsLoaded] = useState(false);
  const [research, setResearch] = useState<LabResearchEntry[]>([]);
  const [researchLoaded, setResearchLoaded] = useState(false);
  // undefined = not yet scanned; number = scanned world value; null = no world
  // file (dedicated server) -> manual entry.
  const [worldHatch, setWorldHatch] = useState<number | null | undefined>(undefined);

  const [selected, setSelected] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(SELECTED_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [manualHatch, setManualHatch] = useState<number>(() => {
    const raw = Number(localStorage.getItem(MANUAL_HATCH_KEY));
    return raw > 0 ? raw : 72;
  });
  // Persisted researched rank per lab-research line key (0 = not researched).
  const [researchRanks, setResearchRanks] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(RESEARCH_KEY);
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {};
    }
  });

  // Load the booster + lab-research catalogues once.
  useEffect(() => {
    invoke<BreedingBoostEntry[]>("list_breeding_boosts")
      .then(setBoosts)
      .catch(() => {})
      .finally(() => setBoostsLoaded(true));
    invoke<LabResearchEntry[]>("list_lab_research")
      .then(setResearch)
      .catch(() => {})
      .finally(() => setResearchLoaded(true));
  }, []);

  // Scan the world's egg-hatch setting on save load. No save / any error ->
  // treat as a dedicated server (manual entry).
  useEffect(() => {
    if (!saveDir.trim()) {
      setWorldHatch(null);
      return;
    }
    let cancelled = false;
    invoke<WorldOptionsResponse>("get_world_options", { saveDir })
      .then((r) => {
        if (!cancelled) setWorldHatch(r.egg_hatch_hours);
      })
      .catch(() => {
        if (!cancelled) setWorldHatch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [saveDir]);

  useEffect(() => {
    try {
      localStorage.setItem(SELECTED_KEY, JSON.stringify(selected));
    } catch {
      // Non-fatal (private mode / quota).
    }
  }, [selected]);
  useEffect(() => {
    try {
      localStorage.setItem(MANUAL_HATCH_KEY, String(manualHatch));
    } catch {
      // Non-fatal (private mode / quota).
    }
  }, [manualHatch]);
  useEffect(() => {
    try {
      localStorage.setItem(RESEARCH_KEY, JSON.stringify(researchRanks));
    } catch {
      // Non-fatal (private mode / quota).
    }
  }, [researchRanks]);

  const scanned = typeof worldHatch === "number";
  const hatchHours = scanned ? (worldHatch as number) : manualHatch;
  const hatchReady = worldHatch !== undefined;

  // Booster view-models, grouped by source (a source's effects toggle together;
  // Babysitter carries both farm + incubation). Alpha-egg boosts are handled
  // separately as info rows (they change no breeding effort), see alphaBoosters.
  const boosters = useMemo<Booster[]>(() => {
    const bySource = new Map<
      string,
      { kind: string; displayName: string; entries: { effect: BreedingEffect; values: number[] }[] }
    >();
    for (const b of boosts) {
      // Excluded from effort toggles; surfaced as info rows below instead.
      if (b.effect === "alpha_egg_chance") continue;
      const g =
        bySource.get(b.source) ??
        { kind: b.source_kind, displayName: b.display_name, entries: [] };
      g.entries.push({ effect: b.effect, values: b.values_per_rank });
      bySource.set(b.source, g);
    }
    return [...bySource.entries()].map(([source, g]) => {
      const isPassive = g.kind === "passive";
      let owned = false;
      let bestRank = 0;
      if (isPassive) {
        owned = pals.some((p) => p.passives.includes(source));
      } else {
        const mine = pals.filter(
          (p) => p.character_id.toLowerCase() === source.toLowerCase(),
        );
        owned = mine.length > 0;
        bestRank = mine.reduce((m, p) => Math.max(m, p.rank), 0);
      }
      const maxRank = Math.max(0, (g.entries[0]?.values.length ?? 1) - 1);
      const effects: BoosterEffect[] = g.entries.map((e) => {
        const maxIdx = e.values.length - 1;
        const idx = isPassive ? 0 : owned ? Math.min(bestRank, maxIdx) : maxIdx;
        return { effect: e.effect, value: e.values[idx] ?? 0 };
      });
      return { source, displayName: g.displayName, isPassive, owned, bestRank, maxRank, effects };
    });
  }, [boosts, pals]);

  // Alpha-egg boosters: they raise the odds a hatched Pal is an Alpha (+20% HP,
  // larger size) but change NO breeding effort, so they render as read-only info
  // rows, never effort toggles. Owned state is still shown. One entry per source
  // (Broncherry, Broncherry Aqua); the range spans the per-condensation values.
  const alphaBoosters = useMemo(() => {
    return boosts
      .filter((b) => b.effect === "alpha_egg_chance")
      .map((b) => {
        const vals = b.values_per_rank.length ? b.values_per_rank : [0];
        const owned =
          b.source_kind === "passive"
            ? pals.some((p) => p.passives.includes(b.source))
            : pals.some((p) => p.character_id.toLowerCase() === b.source.toLowerCase());
        return {
          source: b.source,
          displayName: b.display_name,
          isPassive: b.source_kind === "passive",
          owned,
          minPct: Math.round(Math.min(...vals) * 100),
          maxPct: Math.round(Math.max(...vals) * 100),
        };
      });
  }, [boosts, pals]);

  // Deduped lab-research lines (the two identical Kindling/Cooling branches collapse
  // to one "Incubation Acceleration"). Manual entry — save files don't expose which
  // research a guild has completed, so the user sets their own researched rank.
  const researchLines = useMemo<ResearchLine[]>(() => dedupeResearch(research), [research]);

  // Save-switch revalidation (AppReview P2). `selected` is a global localStorage
  // list, but a booster's applied value depends on the loaded roster: owned uses
  // the real best condensation rank, unowned a max-rank what-if. So when the
  // roster changes and a selected booster's owned-state flips, its contribution
  // would silently change value. Drop those selections, forcing a deliberate
  // re-toggle; unchanged and never-seen sources are kept (what-ifs the user set
  // deliberately survive). Runs whenever `boosters` recomputes (i.e. on roster
  // change), so it also covers switching between two loaded saves.
  const prevOwnedRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (!boostsLoaded) return;
    const prev = prevOwnedRef.current;
    const next = new Map(boosters.map((b) => [b.source, b.owned]));
    setSelected((sel) =>
      sel.filter((s) => {
        const before = prev.get(s);
        const now = next.get(s);
        // Keep unknown sources (catalogue mismatch) and first-seen ones; drop
        // only when a known booster's owned-state actually flipped.
        if (now === undefined || before === undefined) return true;
        return before === now;
      }),
    );
    prevOwnedRef.current = next;
  }, [boosters, boostsLoaded]);

  // Compose the selected boosters' + researched lab lines' effects additively into
  // the setup fractions. Lab research composes into incubation_reduction exactly like
  // an incubation-speed booster (contract: no new solver channel).
  const composed = useMemo<BreedingSetup>(() => {
    let farm = 0;
    let inc = 0;
    let egg = 0;
    for (const b of boosters) {
      if (!selected.includes(b.source)) continue;
      for (const e of b.effects) {
        if (e.effect === "farm_speed") farm += e.value;
        else if (e.effect === "incubation_speed") inc += e.value;
        else if (e.effect === "extra_egg_chance") egg += e.value;
      }
    }
    for (const line of researchLines) {
      const rank = researchRanks[line.key] ?? 0;
      if (rank > 0) inc += line.values[Math.min(rank, line.maxRank) - 1] ?? 0;
    }
    return {
      farm_speed_bonus: farm,
      incubation_reduction: inc,
      extra_egg_chance: egg,
      egg_hatch_hours: hatchHours,
    };
  }, [boosters, selected, researchLines, researchRanks, hatchHours]);

  // Sync the composed setup into the shared store once the catalogues + world
  // scan have resolved (before that we'd zero the persisted setup). Guarded on
  // value equality so it never loops.
  useEffect(() => {
    if (!boostsLoaded || !researchLoaded || !hatchReady) return;
    if (
      composed.farm_speed_bonus !== setup.farm_speed_bonus ||
      composed.incubation_reduction !== setup.incubation_reduction ||
      composed.extra_egg_chance !== setup.extra_egg_chance ||
      composed.egg_hatch_hours !== setup.egg_hatch_hours
    ) {
      setSetup(composed);
    }
  }, [boostsLoaded, researchLoaded, hatchReady, composed, setup, setSetup]);

  const applied = describeSetup(composed, "normal");

  function toggle(source: string) {
    setSelected((s) => (s.includes(source) ? s.filter((x) => x !== source) : [...s, source]));
  }

  function setResearchRank(key: string, rank: number) {
    setResearchRanks((r) => ({ ...r, [key]: rank }));
  }

  return (
    <section className="flex flex-col gap-3 border-t border-line-soft pt-4">
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
          Breeding setup
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          Farm bonuses that bend plan times. All values are estimates from game
          data.
        </p>
      </div>

      {/* EGG HATCH TIME */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          Egg hatch time
        </span>
        {scanned ? (
          <div className="flex items-center gap-2 rounded-md border border-line bg-abyss px-2.5 py-1.5">
            <span className="font-mono text-[15px] font-semibold tabular-nums text-ink">
              {+hatchHours.toFixed(2)}
              <span className="ml-0.5 text-[11px] font-normal text-ink-faint">h</span>
            </span>
            <span className="ml-auto inline-flex items-center gap-1 rounded-sm border border-amber/40 bg-amber/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-amber">
              <span className="h-1 w-1 rounded-full bg-amber" />
              Scanned from world
            </span>
          </div>
        ) : (
          <>
            <label className="flex items-center gap-2 rounded-md border border-line bg-abyss px-2.5 py-1.5 focus-within:border-amber/60">
              <input
                type="number"
                min={0.1}
                step={1}
                className="w-16 bg-transparent text-center font-mono text-[13px] text-ink focus:outline-none"
                value={manualHatch}
                onChange={(e) => setManualHatch(Math.max(0.1, Number(e.currentTarget.value) || 0))}
              />
              <span className="text-[11px] text-ink-faint">hours per egg</span>
            </label>
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Dedicated servers keep this in PalWorldSettings.ini &mdash; enter
              your world&rsquo;s Egg Incubation setting.
            </p>
          </>
        )}
      </div>

      {/* BOOSTERS */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          Boosters
        </span>
        <div className="flex flex-col gap-1">
          {boosters.map((b) => {
            const on = selected.includes(b.source);
            return (
              <button
                key={b.source}
                type="button"
                role="switch"
                aria-checked={on}
                onClick={() => toggle(b.source)}
                className={`flex items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors ${
                  on
                    ? "border-amber/50 bg-amber/[0.08]"
                    : "border-line bg-panel hover:bg-hover"
                } ${b.owned ? "" : "opacity-55 hover:opacity-100"}`}
              >
                {b.isPassive ? (
                  <span
                    className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-amber/40 bg-amber/10 text-[13px] leading-none text-amber"
                    aria-hidden
                  >
                    &#9670;
                  </span>
                ) : (
                  <PalIcon id={b.source} name={b.displayName} size={26} />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {b.displayName}
                    </span>
                    {!b.owned && (
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                        not owned
                      </span>
                    )}
                  </span>
                  <span
                    className={`font-mono text-[11px] tabular-nums ${
                      on ? "text-amber-bright" : "text-good"
                    }`}
                  >
                    {effectSummary(b.effects)}
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-[9px] uppercase leading-tight tracking-wider text-ink-faint">
                  {b.isPassive ? (
                    b.owned ? (
                      "passive"
                    ) : (
                      "what\u2011if"
                    )
                  ) : b.owned ? (
                    <>
                      {b.bestRank}
                      <span className="text-amber">&#9733;</span>
                    </>
                  ) : (
                    <>
                      {b.maxRank}
                      <span>&#9733;</span> max
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {alphaBoosters.length > 0 && (
          <div className="flex flex-col gap-1">
            {alphaBoosters.map((b) => (
              <div
                key={b.source}
                className={`flex items-center gap-2.5 rounded-md border border-line bg-panel/60 px-2 py-1.5 ${
                  b.owned ? "" : "opacity-55"
                }`}
              >
                {b.isPassive ? (
                  <span
                    className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-amber/40 bg-amber/10 text-[13px] leading-none text-amber"
                    aria-hidden
                  >
                    &#9670;
                  </span>
                ) : (
                  <PalIcon id={b.source} name={b.displayName} size={26} />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {b.displayName}
                    </span>
                    {!b.owned && (
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                        not owned
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-ink-dim">
                    +{b.minPct === b.maxPct ? b.minPct : `${b.minPct}\u2013${b.maxPct}`}% Alpha-egg chance
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-[9px] uppercase leading-tight tracking-wider text-ink-faint">
                  info
                </span>
              </div>
            ))}
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Raises the chance the hatched Pal is an Alpha (+20% HP, larger
              size). Doesn&rsquo;t affect breeding steps or passives, so it
              isn&rsquo;t a toggle.
            </p>
          </div>
        )}
        {applied.length > 0 && (
          <div className="rounded-md border border-amber/25 bg-amber/[0.06] px-2.5 py-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-amber/80">
              Applied
            </span>
            <span className="ml-2 font-mono text-[11px] tabular-nums text-ink-dim">
              {applied.join("  /  ")}
            </span>
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Owned boosters use your best condensation rank; others are toggleable
          what-ifs at max rank. Stacking boosters from mixed sources is untested
          in-game.
        </p>
      </div>

      {/* LAB RESEARCH */}
      {researchLines.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Lab research
          </span>
          <div className="flex flex-col gap-1.5">
            {researchLines.map((line) => {
              const rank = Math.min(researchRanks[line.key] ?? 0, line.maxRank);
              const frac = rank > 0 ? line.values[rank - 1] ?? 0 : 0;
              return (
                <div
                  key={line.key}
                  className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2 py-1.5"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-amber/40 bg-amber/10 text-[14px] leading-none text-amber"
                      aria-hidden
                    >
                      &#9879;
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {line.name}
                      </span>
                      <span
                        className={`font-mono text-[11px] tabular-nums ${
                          rank > 0 ? "text-amber-bright" : "text-ink-faint"
                        }`}
                      >
                        {rank > 0 ? `-${Math.round(frac * 100)}% hatch time` : "Not researched"}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono text-[9px] uppercase leading-tight tracking-wider text-ink-faint">
                      Lv&nbsp;{rank}/{line.maxRank}
                    </span>
                  </div>
                  <div
                    className="flex overflow-hidden rounded-md border border-line"
                    role="radiogroup"
                    aria-label={`${line.name} researched rank`}
                  >
                    {Array.from({ length: line.maxRank + 1 }, (_, r) => {
                      const active = r === rank;
                      return (
                        <button
                          key={r}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          aria-label={`Rank ${r}`}
                          onClick={() => setResearchRank(line.key, r)}
                          className={`flex-1 border-r border-line py-1 font-mono text-[11px] tabular-nums transition-colors last:border-r-0 ${
                            active
                              ? "bg-raised text-amber"
                              : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                          }`}
                        >
                          {r}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Set to your lab&rsquo;s researched rank &mdash; save files don&rsquo;t
            expose research yet. Each rank speeds egg incubation, up to &minus;30%.
          </p>
        </div>
      )}

      {/* CAKE */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          Cake
        </span>
        <div
          className="flex flex-col overflow-hidden rounded-md border border-line"
          role="radiogroup"
          aria-label="Breeding cake fed at the farm"
        >
          {CAKES.map((c) => {
            const active = cake === c.token;
            return (
              <button
                key={c.token}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setCake(c.token)}
                className={`flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-left text-[12px] transition-colors last:border-b-0 ${
                  active
                    ? "bg-raised text-amber"
                    : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-amber" : "bg-line"}`}
                />
                {c.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] leading-relaxed text-ink-faint">
          {CAKES.find((c) => c.token === cake)?.note}
        </p>
      </div>

      {/* ADVANCED STATIONS */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          Advanced stations
        </span>

        {/* Surgery table */}
        <div className="flex flex-col gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={surgery !== null}
            onClick={() => setSurgery(surgery ? null : { max_implants: 1, cost_secs: 600 })}
            className={`flex items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors ${
              surgery ? "border-amber/50 bg-amber/[0.08]" : "border-line bg-panel hover:bg-hover"
            }`}
          >
            <span
              className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-amber/40 bg-amber/10 text-[14px] leading-none text-amber"
              aria-hidden
            >
              &#9877;
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium text-ink">Surgery table</span>
              <span className="font-mono text-[11px] text-ink-faint">
                Implant missing passives onto the final pal
              </span>
            </span>
            <span
              className={`shrink-0 font-mono text-[9px] uppercase tracking-wider ${
                surgery ? "text-amber" : "text-ink-faint"
              }`}
            >
              {surgery ? "on" : "off"}
            </span>
          </button>
          {surgery && (
            <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                  Max implants
                </span>
                <div
                  className="flex overflow-hidden rounded-md border border-line"
                  role="radiogroup"
                  aria-label="Maximum surgery-table implants"
                >
                  {[1, 2, 3, 4].map((n) => {
                    const active = surgery.max_implants === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={`${n} implants`}
                        onClick={() => setSurgery({ max_implants: n, cost_secs: surgery.cost_secs })}
                        className={`w-7 border-r border-line py-1 font-mono text-[11px] tabular-nums transition-colors last:border-r-0 ${
                          active
                            ? "bg-raised text-amber"
                            : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                        }`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="flex items-center gap-2 rounded-md border border-line bg-abyss px-2.5 py-1.5 focus-within:border-amber/60">
                <input
                  type="number"
                  min={0}
                  step={30}
                  className="w-16 bg-transparent text-center font-mono text-[13px] text-ink focus:outline-none"
                  value={surgery.cost_secs}
                  onChange={(e) =>
                    setSurgery({
                      max_implants: surgery.max_implants,
                      cost_secs: Math.max(0, Number(e.currentTarget.value) || 0),
                    })
                  }
                />
                <span className="text-[11px] text-ink-faint">
                  sec per implant ({formatDuration(surgery.cost_secs)})
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Gender reverser */}
        <div className="flex flex-col gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={genderReverser !== null}
            onClick={() => setGenderReverser(genderReverser ? null : { cost_secs: 300 })}
            className={`flex items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors ${
              genderReverser ? "border-amber/50 bg-amber/[0.08]" : "border-line bg-panel hover:bg-hover"
            }`}
          >
            <span
              className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-amber/40 bg-amber/10 text-[14px] leading-none text-amber"
              aria-hidden
            >
              &#8644;
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium text-ink">Gender reverser</span>
              <span className="font-mono text-[11px] text-ink-faint">
                Breed a same-gender-only pairing by reversing one parent
              </span>
            </span>
            <span
              className={`shrink-0 font-mono text-[9px] uppercase tracking-wider ${
                genderReverser ? "text-amber" : "text-ink-faint"
              }`}
            >
              {genderReverser ? "on" : "off"}
            </span>
          </button>
          {genderReverser && (
            <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2 py-2">
              <label className="flex items-center gap-2 rounded-md border border-line bg-abyss px-2.5 py-1.5 focus-within:border-amber/60">
                <input
                  type="number"
                  min={0}
                  step={30}
                  className="w-16 bg-transparent text-center font-mono text-[13px] text-ink focus:outline-none"
                  value={genderReverser.cost_secs}
                  onChange={(e) =>
                    setGenderReverser({
                      cost_secs: Math.max(0, Number(e.currentTarget.value) || 0),
                    })
                  }
                />
                <span className="text-[11px] text-ink-faint">
                  sec per reverse ({formatDuration(genderReverser.cost_secs)})
                </span>
              </label>
            </div>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-ink-faint">
          Costs are your own time-cost estimates &mdash; what a station&rsquo;s step is
          worth to you in seconds. The solver adds them to a plan&rsquo;s ranking effort,
          so a cheaper pure-breeding plan still wins.
        </p>
      </div>

      {/* MUTATIONS — honest card: rate is code-verified, outcomes are not */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          Mutations
        </span>
        <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="rounded-sm border border-amber/40 bg-amber/10 px-1.5 py-0.5 font-mono text-[10px] text-amber">
              ~1% / egg
            </span>
            <span className="text-[11px] text-ink-faint">
              +2pp with Deluxe cake
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Any breeding step can yield a <span className="text-ink">Mutated Egg</span> that
            hatches a different, stronger species than the pair&rsquo;s normal child. The
            rate is verified from the game&rsquo;s data; <span className="text-ink">which</span>{" "}
            species it becomes hasn&rsquo;t been publicly decoded &mdash; so Pal Lab treats
            mutations as a bonus and never builds plans that depend on one.
          </p>
        </div>
      </div>
    </section>
  );
}
