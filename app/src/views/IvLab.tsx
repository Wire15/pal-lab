// IV Lab — the stat-breeding companion to the passive Solver. The passive
// Solver asks "which pals carry these passives"; the IV Lab asks "how do I hit
// these stat floors, from which parents, with which cake". Same `solve` backend
// (ivs/cake/iv_model/setup ride the request), same PlanGraph/PlanNodePanel for
// the result, but the briefing is IV-shaped: three threshold sliders, a cake
// strategy note, and a BEST DONORS scan of the owned pals that could seed the
// line. Farm setup + cake are shared with the Solver via useBreedingSetup().

import { useEffect, useMemo, useState } from "react";
import { invoke } from "../lib/tauri";
import type {
  BreedingPlan,
  CakeToken,
  IvModel,
  NamedEntry,
  OwnedPal,
  PlanNode,
  SolveRequest,
  SolveResponse,
} from "../lib/types";
import { formatDuration, genderView, ivBand, QUALITY_TEXT } from "../lib/ui";
import { PalIcon } from "../components/primitives";
import { PassivePicker } from "../components/passive-picker";
import { PlanGraph } from "../components/plan-graph";
import { PlanNodePanel, type PlanNodeSelection } from "../components/plan-node-panel";
import { hexGuid } from "../components/palbox/selectors";
import { useAppState, useBreedingSetup } from "../state";
import { ivSum, rankDonors, type StatKey } from "./ivlab/donors";

const STAT_KEYS: readonly StatKey[] = ["hp", "attack", "defense"];
const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP",
  attack: "ATK",
  defense: "DEF",
};

const CAKES: { token: CakeToken; label: string }[] = [
  { token: "normal", label: "None" },
  { token: "mushroom", label: "Mushroom" },
  { token: "vegetable", label: "Vegetable" },
  { token: "deluxe_vegetable", label: "Deluxe Veg" },
  { token: "special", label: "Special" },
];

/** Cakes that raise a bred egg's IV floor by +5 (TalentBonusMax); mirrors the
 *  solver's `CakeKind::iv_floor_bonus` (Mushroom / DeluxeVegetable only). Any
 *  threshold at or below this floor is guaranteed by the cake alone, so the
 *  solver drops it (`apply_iv_floor`). */
const IV_FLOOR_CAKES: CakeToken[] = ["mushroom", "deluxe_vegetable"];
const IV_FLOOR = 5;

/** Honest one-liner per IV inherit-count model (shared-contract microcopy). */
const IV_MODEL_COPY: Record<IvModel, string> = {
  empirical: "Community-measured 50 / 25 / 25 inherit split. The safe default.",
  cdo: "Game-data 50 / 33 / 17 weights. Unverified consumption \u2014 experimental.",
};

/**
 * Estimated eggs to hatch across a plan: the geometric expectation `1/p` summed
 * over every bred step (owned / wild leaves cost no eggs). This mirrors the
 * solver's internal `num_eggs`, which the frozen plan payload doesn't surface,
 * so it stays an ESTIMATE and is always labelled as one.
 */
function expectedEggs(root: PlanNode): number {
  let eggs = 0;
  (function walk(n: PlanNode) {
    if (n.source === "Bred" && n.probability > 0 && Number.isFinite(n.probability)) {
      eggs += Math.max(1, Math.round(1 / n.probability));
    }
    n.children.forEach(walk);
  })(root);
  return eggs;
}

/** One IV threshold slider: 0 renders as "any", otherwise a band-tinted chip. */
function IvSlider({
  stat,
  value,
  onChange,
}: {
  stat: StatKey;
  value: number;
  onChange: (v: number) => void;
}) {
  const active = value > 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {STAT_LABEL[stat]}
        </span>
        <span
          className={`rounded-xs bg-abyss px-1.5 py-0.5 font-mono text-[11px] tabular-nums ${
            active ? QUALITY_TEXT[ivBand(value)] : "text-ink-faint"
          }`}
        >
          {active ? value : "any"}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-label={`${STAT_LABEL[stat]} minimum IV`}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line accent-amber"
      />
    </div>
  );
}

/** A donor candidate row: portrait, name + gender, level, the three IVs with
 *  the ranked stat highlighted (or the IV sum for the overall bucket). */
function DonorRow({
  pal,
  name,
  lead,
  showSum,
  onOpen,
}: {
  pal: OwnedPal;
  name: string;
  lead: StatKey | null;
  showSum: boolean;
  onOpen: () => void;
}) {
  const g = genderView(pal.gender);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5 text-left transition-colors hover:border-amber/40 hover:bg-hover"
    >
      <PalIcon id={pal.character_id} name={name} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-ink">{name}</span>
          <span className={`text-[11px] ${g.className}`} title={g.label}>
            {g.glyph}
          </span>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          Lv {pal.level}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 font-mono tabular-nums">
        {STAT_KEYS.map((k) => {
          const on = lead === k;
          return (
            <span
              key={k}
              className={`flex w-6 flex-col items-center leading-none ${
                on ? `${QUALITY_TEXT[ivBand(pal.ivs[k])]} font-semibold` : "text-ink-faint"
              }`}
            >
              <span className="text-[8px] uppercase tracking-wide text-ink-faint">
                {STAT_LABEL[k]}
              </span>
              <span className="text-[11px]">{pal.ivs[k]}</span>
            </span>
          );
        })}
        {showSum && (
          <span className="flex w-8 flex-col items-center leading-none text-amber">
            <span className="text-[8px] uppercase tracking-wide text-ink-faint">
              sum
            </span>
            <span className="text-[11px] font-semibold">{ivSum(pal)}</span>
          </span>
        )}
      </div>
    </button>
  );
}

export default function IvLab() {
  const { saveDir, saveSummary, requestDex } = useAppState();
  const { setup, cake, setCake } = useBreedingSetup();

  const [species, setSpecies] = useState("");
  const [ivs, setIvs] = useState({ hp: 0, attack: 0, defense: 0 });
  const [passives, setPassives] = useState<string[]>([]);
  const [maxSteps, setMaxSteps] = useState(5);
  const [ivModel, setIvModel] = useState<IvModel>("empirical");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [speciesList, setSpeciesList] = useState<NamedEntry[]>([]);
  const [plans, setPlans] = useState<BreedingPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [activePlan, setActivePlan] = useState(0);
  const [selection, setSelection] = useState<{
    nodeId: string;
    data: PlanNodeSelection;
  } | null>(null);

  useEffect(() => {
    invoke<NamedEntry[]>("list_species").then(setSpeciesList).catch(() => {});
  }, []);
  // Fresh result resets to the first plan; switching plans clears the node
  // selection (node ids are per-plan-render path ids, like the Solver).
  useEffect(() => {
    setActivePlan(0);
  }, [plans]);
  useEffect(() => {
    setSelection(null);
  }, [activePlan, plans]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelection(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nameToId = useMemo(
    () => new Map(speciesList.map((s) => [s.name, s.id])),
    [speciesList],
  );
  const idToName = useMemo(
    () => new Map(speciesList.map((s) => [s.id, s.name])),
    [speciesList],
  );
  const targetId = nameToId.get(species) ?? null;

  const anyThreshold = ivs.hp > 0 || ivs.attack > 0 || ivs.defense > 0;
  const floorCovered =
    IV_FLOOR_CAKES.includes(cake) &&
    STAT_KEYS.some((k) => ivs[k] > 0 && ivs[k] <= IV_FLOOR);

  // Donor pool: owned pals of the target species, plus any owned pal that shows
  // up in the returned plans (plan node species_names -> internal id -> owned).
  const donorGroups = useMemo(() => {
    if (!saveSummary || !targetId) return null;
    const kin = new Set<string>([targetId]);
    for (const plan of plans ?? []) {
      (function walk(n: PlanNode) {
        const id = nameToId.get(n.species_name);
        if (id) kin.add(id);
        n.children.forEach(walk);
      })(plan.root);
    }
    const pool = saveSummary.pals.filter(
      (p) => !p.is_human && kin.has(p.character_id),
    );
    if (pool.length === 0) return [];
    return rankDonors(pool);
  }, [saveSummary, targetId, plans, nameToId]);

  const showDonors = donorGroups !== null;

  async function runSolve() {
    setSolving(true);
    setError(null);
    setPlans(null);
    try {
      const spec: SolveRequest = {
        target_species: species,
        required_passives: passives,
        max_steps: maxSteps,
        ivs,
        cake,
        iv_model: ivModel,
        setup,
      };
      const resp = await invoke<SolveResponse>("solve", { saveDir, spec });
      setPlans(resp.plans);
    } catch (e) {
      setError(String(e));
    } finally {
      setSolving(false);
    }
  }

  const canSolve = saveDir.trim() !== "" && species.trim() !== "" && !solving;
  const fastestIdx =
    plans && plans.length > 1
      ? plans.reduce(
          (best, p, idx, arr) =>
            p.total_time_secs < arr[best].total_time_secs ? idx : best,
          0,
        )
      : -1;
  const active = plans && plans.length > 0 ? plans[activePlan] : null;

  return (
    <div className="flex h-full">
      {/* Briefing */}
      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-auto border-r border-line bg-panel px-5 pb-6 pt-5">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            IV Lab
          </div>
          <h1 className="font-display text-xl font-bold tracking-wide text-ink">
            Stat breeding
          </h1>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Target species
          </span>
          <div className="flex items-center gap-2 rounded-md border border-line bg-abyss px-2 py-1 focus-within:border-amber/60">
            <PalIcon id={targetId} name={species || "target"} size={26} />
            <input
              className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
              list="ivlab-species-options"
              placeholder="e.g. Anubis"
              value={species}
              onChange={(e) => setSpecies(e.currentTarget.value)}
            />
            <datalist id="ivlab-species-options">
              {speciesList.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
          </div>
        </label>

        <div className="flex flex-col gap-2.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Target IVs
          </span>
          {STAT_KEYS.map((k) => (
            <IvSlider
              key={k}
              stat={k}
              value={ivs[k]}
              onChange={(v) => setIvs((prev) => ({ ...prev, [k]: v }))}
            />
          ))}
          {!anyThreshold && (
            <p className="text-[12px] leading-relaxed text-ink-faint">
              Set at least one stat floor above 0 &mdash; that&rsquo;s what the IV
              Lab optimizes for. All zero solves like a plain passive plan.
            </p>
          )}
        </div>

        <PassivePicker
          selected={passives}
          onAdd={(name) =>
            setPassives((p) => (p.includes(name) ? p : [...p, name]))
          }
          onRemove={(name) => setPassives((p) => p.filter((x) => x !== name))}
        />

        <label className="flex items-center gap-2 text-[13px] text-ink-dim">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Max steps
          </span>
          <input
            type="number"
            min={1}
            className="w-16 rounded-md border border-line bg-abyss px-2 py-1 text-center font-mono text-[13px] text-ink focus:border-amber/60"
            value={maxSteps}
            onChange={(e) => setMaxSteps(Number(e.currentTarget.value))}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Breeding cake
          </span>
          <div className="grid grid-cols-3 gap-1">
            {CAKES.map((c) => {
              const on = cake === c.token;
              return (
                <button
                  key={c.token}
                  type="button"
                  onClick={() => setCake(c.token)}
                  aria-pressed={on}
                  className={`rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors ${
                    on
                      ? "border-amber/50 bg-amber/10 text-amber"
                      : "border-line bg-abyss text-ink-dim hover:bg-hover hover:text-ink"
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          {floorCovered ? (
            <p className="text-[12px] leading-relaxed text-good">
              This cake guarantees a +{IV_FLOOR} IV floor, so your 1&ndash;
              {IV_FLOOR} thresholds are already covered &mdash; the solver drops
              them.
            </p>
          ) : cake === "normal" && anyThreshold ? (
            <p className="text-[12px] leading-relaxed text-ink-faint">
              No cake &mdash; every IV is inherited or rolled from scratch.{" "}
              <button
                type="button"
                onClick={() => setCake("mushroom")}
                className="font-medium text-amber underline decoration-amber/40 underline-offset-2 transition-colors hover:text-amber-bright"
              >
                Mushroom adds a +{IV_FLOOR} IV floor &mdash; use it
              </button>
            </p>
          ) : (
            <p className="text-[12px] leading-relaxed text-ink-faint">
              Mushroom &amp; Deluxe Veg add a +{IV_FLOOR} IV floor; Vegetable
              doubles eggs; Special forces 4 passive inherits.
            </p>
          )}
        </div>

        {/* Advanced disclosure: IV model + shared farm setup readout */}
        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-dim"
          >
            <span
              className={`inline-block transition-transform ${
                showAdvanced ? "rotate-90" : ""
              }`}
            >
              &rsaquo;
            </span>
            Advanced
          </button>
          {showAdvanced && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                  IV model
                </span>
                <div
                  className="flex overflow-hidden rounded-md border border-line"
                  role="radiogroup"
                  aria-label="IV inherit-count model"
                >
                  {(["empirical", "cdo"] as const).map((m) => {
                    const on = ivModel === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setIvModel(m)}
                        className={`flex-1 px-3 py-1 text-[12px] font-medium uppercase tracking-wide transition-colors ${
                          on
                            ? "bg-raised text-amber"
                            : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                        }`}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[12px] leading-relaxed text-ink-faint">
                  {IV_MODEL_COPY[ivModel]}
                </p>
              </div>

              <div className="flex flex-col gap-1">
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                  Farm setup
                </span>
                <div className="flex flex-col gap-0.5 rounded-md border border-line bg-abyss px-2.5 py-2 font-mono text-[11px] tabular-nums text-ink-dim">
                  <SetupLine label="Farm speed" value={`+${Math.round(setup.farm_speed_bonus * 100)}%`} />
                  <SetupLine label="Incubation" value={`-${Math.round(setup.incubation_reduction * 100)}%`} />
                  <SetupLine label="Extra egg" value={`+${Math.round(setup.extra_egg_chance * 100)}%`} />
                  <SetupLine label="Hatch time" value={`${setup.egg_hatch_hours}h`} />
                </div>
                <p className="text-[12px] leading-relaxed text-ink-faint">
                  Shared with the Solver &mdash; edit boosts in its Breeding
                  Setup panel.
                </p>
              </div>
            </div>
          )}
        </div>

        <button
          className="mt-1 rounded-md bg-amber px-4 py-2.5 text-sm font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
          onClick={runSolve}
          disabled={!canSolve}
        >
          {solving ? "Solving\u2026" : "Solve IV line"}
        </button>
        {!saveDir.trim() && (
          <p className="-mt-2 text-[12px] leading-relaxed text-ink-faint">
            Load a save from the sidebar to scan donors and solve.
          </p>
        )}
      </aside>

      {/* Best donors */}
      {showDonors && (
        <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-auto border-r border-line bg-panel/60 px-4 pb-6 pt-5">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-amber">
              Best donors
            </div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-faint">
              Your strongest owned parents for {species || "this line"}
              {plans && plans.length > 0 ? " and its plan kin" : ""}.
            </p>
          </div>
          {donorGroups.length === 0 ? (
            <div className="rounded-md border border-line bg-panel px-3 py-4 text-[12px] leading-relaxed text-ink-faint">
              No owned {species || "pals"} yet. Catch or breed one to seed the
              line, then its best IVs show up here.
            </div>
          ) : (
            donorGroups.map((group) => (
              <div key={group.key} className="flex flex-col gap-1.5">
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  {group.label}
                </div>
                {group.pals.map((pal) => (
                  <DonorRow
                    key={hexGuid(pal.instance_id)}
                    pal={pal}
                    name={idToName.get(pal.character_id) ?? pal.character_id}
                    lead={group.key === "sum" ? null : group.key}
                    showSum={group.key === "sum"}
                    onOpen={() =>
                      requestDex(pal.character_id, hexGuid(pal.instance_id))
                    }
                  />
                ))}
              </div>
            ))
          )}
        </aside>
      )}

      {/* Results */}
      <section className="flex flex-1 flex-col overflow-hidden">
        {error && (
          <div className="m-6 rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
            {error}
          </div>
        )}

        {plans && plans.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="font-display text-lg text-ink-dim">No line found</div>
            <p className="max-w-xs text-sm text-ink-faint">
              No breeding chain reaches those IV floors within {maxSteps} steps.
              Loosen a threshold, raise max steps, or try a cake with an IV floor.
            </p>
          </div>
        )}

        {plans && plans.length > 0 && (
          <>
            <div
              className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-4 py-2"
              role="tablist"
              aria-label="Breeding lines"
            >
              {plans.map((_plan, i) => {
                const on = i === activePlan;
                return (
                  <button
                    key={i}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setActivePlan(i)}
                    className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                      on
                        ? "border-amber/50 bg-amber/10 text-amber"
                        : "border-line bg-panel text-ink-dim hover:bg-hover hover:text-ink"
                    }`}
                  >
                    Line {i + 1}
                    {i === fastestIdx && (
                      <span
                        className={`rounded-sm px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wider ${
                          on ? "bg-amber/20 text-amber" : "bg-raised text-amber/80"
                        }`}
                      >
                        Fastest
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {active && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-raised px-4 py-2">
                <span className="font-mono text-lg font-semibold tabular-nums text-amber">
                  {formatDuration(active.total_time_secs)}
                </span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-dim">
                  <span>
                    <span className="text-ink">~{expectedEggs(active.root)}</span>{" "}
                    eggs
                  </span>
                  <span className="text-line">|</span>
                  <span>
                    <span className="text-ink">{active.total_steps}</span> steps
                  </span>
                  {active.cake && active.cake !== "Normal" && (
                    <>
                      <span className="text-line">|</span>
                      <span>
                        <span className="text-ink">{active.cake_count}</span>{" "}
                        {active.cake} cake
                      </span>
                    </>
                  )}
                </div>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  Estimates &middot; {ivModel} IV model
                </span>
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                {active && (
                  <PlanGraph
                    plan={active}
                    planIndex={activePlan}
                    nameToId={nameToId}
                    selectedId={selection?.nodeId ?? null}
                    onSelect={(data, nodeId) => setSelection({ nodeId, data })}
                  />
                )}
              </div>
              {selection && (
                <PlanNodePanel
                  selection={selection.data}
                  onClose={() => setSelection(null)}
                  onNavigateDex={requestDex}
                />
              )}
            </div>
          </>
        )}

        {!plans && !error && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="font-display text-lg text-ink-dim">
              Engineer an IV line
            </div>
            <p className="max-w-sm text-sm text-ink-faint">
              Pick a target, set the stat floors you want, choose a cake, then
              solve. The plan shows the full lineage; your best owned parents sit
              in the donors panel.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/** One label/value row of the compact farm-setup readout. */
function SetupLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-faint">{label}</span>
      <span className="text-ink-dim">{value}</span>
    </div>
  );
}
