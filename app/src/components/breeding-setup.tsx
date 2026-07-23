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
  WorldOptionsResponse,
} from "../lib/types";
import { PalIcon } from "./primitives";
import { useAppState, useBreedingSetup } from "../state";

/** localStorage keys for this panel's own UI inputs (the composed setup itself
 * lives in the shared store). */
const SELECTED_KEY = "pal-calc.setup.boosters";
const MANUAL_HATCH_KEY = "pal-calc.setup.manualHatch";

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

export function BreedingSetupPanel() {
  const { saveDir, saveSummary } = useAppState();
  const { setup, cake, setSetup, setCake } = useBreedingSetup();
  const pals = saveSummary?.pals ?? [];

  const [boosts, setBoosts] = useState<BreedingBoostEntry[]>([]);
  const [boostsLoaded, setBoostsLoaded] = useState(false);
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

  // Load the booster catalogue once.
  useEffect(() => {
    invoke<BreedingBoostEntry[]>("list_breeding_boosts")
      .then(setBoosts)
      .catch(() => {})
      .finally(() => setBoostsLoaded(true));
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

  // Compose the selected boosters' effects additively into the setup fractions.
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
    return {
      farm_speed_bonus: farm,
      incubation_reduction: inc,
      extra_egg_chance: egg,
      egg_hatch_hours: hatchHours,
    };
  }, [boosters, selected, hatchHours]);

  // Sync the composed setup into the shared store once the catalogue + world
  // scan have resolved (before that we'd zero the persisted setup). Guarded on
  // value equality so it never loops.
  useEffect(() => {
    if (!boostsLoaded || !hatchReady) return;
    if (
      composed.farm_speed_bonus !== setup.farm_speed_bonus ||
      composed.incubation_reduction !== setup.incubation_reduction ||
      composed.extra_egg_chance !== setup.extra_egg_chance ||
      composed.egg_hatch_hours !== setup.egg_hatch_hours
    ) {
      setSetup(composed);
    }
  }, [boostsLoaded, hatchReady, composed, setup, setSetup]);

  const applied = describeSetup(composed, "normal");

  function toggle(source: string) {
    setSelected((s) => (s.includes(source) ? s.filter((x) => x !== source) : [...s, source]));
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
    </section>
  );
}
