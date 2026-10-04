import { t, tr, useLocale } from "../i18n";
// IV Lab — the stat-breeding companion to the passive Solver. The passive
// Solver asks "which pals carry these passives"; the IV Lab asks "how do I hit
// these stat floors, from which parents, with which cake". Same `solve` backend
// (ivs/cake/iv_model/setup ride the request), same PlanGraph/PlanNodePanel for
// the result, but the briefing is IV-shaped: three threshold sliders, a cake
// strategy note, and a BEST DONORS scan of the owned pals that could seed the
// line. Farm setup + cake are shared with the Solver via useBreedingSetup().

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CakeToken,
  IvModel,
  OwnedPal,
  PlanNode,
  SolveRequest,
} from "../lib/types";
import { formatDuration, genderView, ivBand, QUALITY_TEXT } from "../lib/ui";
import { PalIcon } from "../components/primitives";
import { PassivePicker } from "../components/passive-picker";
import { PlanGraph } from "../components/plan-graph";
import { PlanNodePanel } from "../components/plan-node-panel";
import { hexGuid } from "../components/palbox/selectors";
import { useAppState, useBreedingSetup } from "../state";
import { ivSum, rankDonors, type StatKey } from "./ivlab/donors";
import { useSolve } from "../lib/use-solve";
import { SolveProgress } from "../components/solve-progress";
import { usePlanActions } from "../components/plan-actions";
import { PalHoverCard } from "../components/pal-hover-card";
import {
  HistoryDrawer,
  pushHistoryEntry,
  type SolveHistoryEntry,
} from "../components/history-drawer";
import { NoPathPanel } from "../components/no-path-panel";

const STAT_KEYS: readonly StatKey[] = ["hp", "attack", "defense"];
const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP",
  attack: "ATK",
  defense: "DEF",
};

const CAKES: { token: CakeToken; label: string }[] = [
  { token: "normal", get label() { return t("None"); } },
  { token: "mushroom", get label() { return t("Mushroom"); } },
  { token: "vegetable", get label() { return t("Vegetable"); } },
  { token: "deluxe_vegetable", get label() { return t("Deluxe Veg"); } },
  { token: "special", get label() { return t("Special"); } },
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
 * Estimated eggs (egg batches) to hatch across a plan: the geometric
 * expectation `1/p` summed over every bred step (owned / wild leaves cost no
 * eggs), divided by the effective eggs-per-cycle multiplier `eggMult` (cake
 * BreedCount x the extra-egg chance) so this agrees with the backend-adjusted
 * `total_time` shown beside it. Mirrors the solver's internal `num_eggs`, which
 * the frozen plan payload doesn't surface, so it stays an ESTIMATE, labelled one.
 */
function expectedEggs(root: PlanNode, eggMult: number): number {
  let eggs = 0;
  (function walk(n: PlanNode) {
    if (n.source === "Bred" && n.probability > 0 && Number.isFinite(n.probability)) {
      eggs += Math.max(1, Math.round(1 / n.probability / eggMult));
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
  useLocale();
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
          {active ? value : t("any")}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-label={t("{0} minimum IV", [STAT_LABEL[stat]])}
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
  useLocale();
  const g = genderView(pal.gender);
  return (
    <PalHoverCard speciesId={pal.character_id} pal={pal}>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5 text-left transition-colors hover:border-amber/40 hover:bg-hover"
      >
        <PalIcon id={pal.character_id} name={name} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] text-ink">{tr(name)}</span>
            <span className={`text-[11px] ${g.className}`} title={tr(g.label)}>
              {g.glyph}
            </span>
          </div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{t("Lv ")}{pal.level}
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
              <span className="text-[8px] uppercase tracking-wide text-ink-faint">{t("sum")}</span>
              <span className="text-[11px] font-semibold">{ivSum(pal)}</span>
            </span>
          )}
        </div>
      </button>
    </PalHoverCard>
  );
}

export default function IvLab() {
  useLocale();
  const { saveDir, saveSummary, requestDex, playerScope, ivLabSession, setIvLabSession } =
    useAppState();
  const { setup, cake, setCake } = useBreedingSetup();

  const [species, setSpecies] = useState("");
  const [ivs, setIvs] = useState({ hp: 0, attack: 0, defense: 0 });
  const [passives, setPassives] = useState<string[]>([]);
  const [maxSteps, setMaxSteps] = useState(5);
  const [ivModel, setIvModel] = useState<IvModel>("empirical");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const {
    speciesList,
    nameToId,
    plans,
    fallbackUsed,
    diagnosis,
    searchTruncated,
    error,
    solving,
    progress,
    cancelled,
    cancel,
    activePlan,
    setActivePlan,
    selection,
    setSelection,
    fastestIdx,
    lastRequest,
    restoredFrom,
    rehydrate,
    solve,
    restoreSession,
    reset,
  } = useSolve();

  const idToName = useMemo(
    () => new Map(speciesList.map((s) => [s.id, s.name])),
    [speciesList],
  );
  const targetId = nameToId.get(species) ?? null;

  const anyThreshold = ivs.hp > 0 || ivs.attack > 0 || ivs.defense > 0;
  const floorCovered =
    IV_FLOOR_CAKES.includes(cake) &&
    STAT_KEYS.some((k) => ivs[k] > 0 && ivs[k] <= IV_FLOOR);

  // Effective eggs-per-cycle multiplier: Vegetable/Deluxe Veg cakes yield 2 eggs
  // per breeding cycle, composed with the extra-egg chance — mirrors the solver's
  // `egg_mult` so the ~eggs estimate agrees with the backend-adjusted total time.
  const eggMult =
    (cake === "vegetable" || cake === "deluxe_vegetable" ? 2 : 1) *
    (1 + setup.extra_egg_chance);

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
      (p) =>
        !p.is_human &&
        kin.has(p.character_id) &&
        (playerScope === "all" ||
          (p.owner_player_uid != null &&
            hexGuid(p.owner_player_uid) === playerScope)),
    );
    if (pool.length === 0) return [];
    return rankDonors(pool);
  }, [saveSummary, targetId, plans, nameToId, playerScope]);

  const showDonors = donorGroups !== null;

  // IV Lab sends only its own field set ({ ivs, iv_model }); the hook injects
  // the shared setup/cake.
  async function runSolve() {
    const outcome = await solve({
      target_species: species,
      required_passives: passives,
      max_steps: maxSteps,
      ivs,
      iv_model: ivModel,
    });
    if (!outcome) return; // errored or cancelled — nothing to record
    const timestamp = Date.now();
    // Lift the fresh result into the IV Lab's own session slot so it survives
    // navigation. A new solve always lands on the first plan tab.
    setIvLabSession({
      request: outcome.request,
      response: outcome.response,
      activePlan: 0,
      timestamp,
      saveDir,
    });
    // Record successful solves only (a zero-plan "no line" is not history-worthy).
    if (outcome.response.plans.length > 0) {
      pushHistoryEntry({
        storageKey: "pal-lab.ivLabHistory",
        request: outcome.request,
        response: outcome.response,
        activePlan: 0,
        timestamp,
      });
    }
  }

  // RESET the query: clear the target, IV thresholds, passives and max-steps,
  // plus the results (via `reset()`). KEEPS the shared farm state — breeding
  // setup + cake — and the IV model, which describe the farm, not this one
  // query (frozen reset-scope contract).
  function resetForm() {
    setSpecies("");
    setIvs({ hp: 0, attack: 0, defense: 0 });
    setPassives([]);
    setMaxSteps(5);
    closeNaming();
    reset();
    setIvLabSession(null);
  }

  // Sync the briefing form to a saved/imported request (target + IV briefing).
  // The shared setup/cake stay live and are never restored, mirroring the Solver.
  function applyRequestToForm(r: SolveRequest) {
    setSpecies(r.target_species);
    setPassives(r.required_passives ?? []);
    setMaxSteps(r.max_steps ?? 5);
    setIvs(r.ivs ?? { hp: 0, attack: 0, defense: 0 });
    setIvModel(r.iv_model ?? "empirical");
  }

  // User-driven plan-tab switch: update the live view AND the stored session so
  // the tab the user left on is what a navigation return restores. Internal
  // resets (fresh solve / save switch) go through the hook's own setter.
  function selectPlan(i: number) {
    setActivePlan(i);
    setIvLabSession((prev) => (prev ? { ...prev, activePlan: i } : prev));
  }

  // Restore an IV LAB HISTORY entry as the current session. Does NOT record a
  // new entry; a later re-solve appends as usual. Tagged with the live save so
  // navigation restore treats it as the current session.
  function restoreFromHistory(entry: SolveHistoryEntry) {
    applyRequestToForm(entry.request);
    restoreSession(entry);
    setIvLabSession({
      request: entry.request,
      response: entry.response,
      activePlan: entry.activePlan,
      timestamp: entry.timestamp,
      saveDir,
    });
  }

  // Restore the current IV Lab session when returning after a view switch (the
  // view unmounts on nav), so plans/graph/active tab survive without re-solving.
  // Runs once per real mount; guarded to the same save. The ref makes it
  // StrictMode-safe (its double-invoke mount fires the effect twice).
  const sessionRestored = useRef(false);
  useEffect(() => {
    if (sessionRestored.current) return;
    sessionRestored.current = true;
    if (
      ivLabSession &&
      ivLabSession.saveDir === saveDir &&
      !plans &&
      !solving
    ) {
      applyRequestToForm(ivLabSession.request);
      restoreSession(ivLabSession);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { headerButtons, banners, drawer, closeNaming } = usePlanActions({
    plans,
    fallbackUsed,
    activePlan,
    lastRequest,
    nameToId,
    saveDir,
    restoredFrom,
    rehydrate,
    solve,
    applyRequestToForm,
  });

  const canSolve = saveDir.trim() !== "" && species.trim() !== "" && !solving;
  const active = plans && plans.length > 0 ? plans[activePlan] : null;

  return (
    <div className="flex h-full">
      {/* Briefing */}
      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-auto border-r border-line bg-panel px-5 pb-6 pt-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">{t("IV Lab")}</div>
            <h1 className="font-display text-xl font-bold tracking-wide text-ink">{t("Stat breeding")}</h1>
          </div>
          <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              title={t("Recent IV lines — reopen a previous solve")}
              className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:border-amber/50 hover:text-amber focus-visible:border-amber/50 focus-visible:text-amber"
            >{t("History")}</button>
            <button
              type="button"
              onClick={resetForm}
              title={t("Clear target, IV floors and passives (keeps breeding setup & cake)")}
              className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:border-bad/50 hover:text-bad focus-visible:border-bad/50 focus-visible:text-bad"
            >{t("Reset")}</button>
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">{t("Target species")}</span>
          <div className="flex items-center gap-2 rounded-md border border-line bg-abyss px-2 py-1 focus-within:border-amber/60">
            <PalIcon id={targetId} name={species || "target"} size={26} />
            <input
              className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
              list="ivlab-species-options"
              placeholder={t("e.g. Anubis")}
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
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">{t("Target IVs")}</span>
          {STAT_KEYS.map((k) => (
            <IvSlider
              key={k}
              stat={k}
              value={ivs[k]}
              onChange={(v) => setIvs((prev) => ({ ...prev, [k]: v }))}
            />
          ))}
          {!anyThreshold && (
            <p className="text-[12px] leading-relaxed text-ink-faint">{t("Set at least one stat floor above 0 — that’s what the IV Lab optimizes for. All zero solves like a plain passive plan.")}</p>
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
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">{t("Max steps")}</span>
          <input
            type="number"
            min={1}
            className="w-16 rounded-md border border-line bg-abyss px-2 py-1 text-center font-mono text-[13px] text-ink focus:border-amber/60"
            value={maxSteps}
            onChange={(e) =>
              setMaxSteps(Math.max(1, Math.round(Number(e.currentTarget.value) || 1)))
            }
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">{t("Breeding cake")}</span>
          <div
            className="grid grid-cols-3 gap-1"
            role="radiogroup"
            aria-label={t("Breeding cake fed at the farm")}
          >
            {CAKES.map((c) => {
              const on = cake === c.token;
              return (
                <button
                  key={c.token}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setCake(c.token)}
                  className={`rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors ${
                    on
                      ? "border-amber/50 bg-amber/10 text-amber"
                      : "border-line bg-abyss text-ink-dim hover:bg-hover hover:text-ink"
                  }`}
                >
                  {tr(c.label)}
                </button>
              );
            })}
          </div>
          {floorCovered ? (
            <p className="text-[12px] leading-relaxed text-good">{t("This cake guarantees a +")}{IV_FLOOR}{t(" IV floor, so your 1–")}{IV_FLOOR}{t(" thresholds are already covered — the solver drops them.")}</p>
          ) : cake === "normal" && anyThreshold ? (
            <p className="text-[12px] leading-relaxed text-ink-faint">{t("No cake — every IV is inherited or rolled from scratch.")}{" "}
              <button
                type="button"
                onClick={() => setCake("mushroom")}
                className="font-medium text-amber underline decoration-amber/40 underline-offset-2 transition-colors hover:text-amber-bright"
              >{t("Mushroom adds a +")}{IV_FLOOR}{t(" IV floor — use it")}</button>
            </p>
          ) : (
            <p className="text-[12px] leading-relaxed text-ink-faint">{t("Mushroom & Deluxe Veg add a +")}{IV_FLOOR}{t(" IV floor; Vegetable doubles eggs; Special forces 4 passive inherits.")}</p>
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
            </span>{t("Advanced")}</button>
          {showAdvanced && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">{t("IV model")}</span>
                <div
                  className="flex overflow-hidden rounded-md border border-line"
                  role="radiogroup"
                  aria-label={t("IV inherit-count model")}
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
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">{t("Farm setup")}</span>
                <div className="flex flex-col gap-0.5 rounded-md border border-line bg-abyss px-2.5 py-2 font-mono text-[11px] tabular-nums text-ink-dim">
                  <SetupLine label={t("Farm speed")} value={`+${Math.round(setup.farm_speed_bonus * 100)}%`} />
                  <SetupLine label={t("Incubation")} value={`-${Math.round(setup.incubation_reduction * 100)}%`} />
                  <SetupLine label={t("Extra egg")} value={`+${Math.round(setup.extra_egg_chance * 100)}%`} />
                  <SetupLine label={t("Hatch time")} value={`${setup.egg_hatch_hours}h`} />
                </div>
                <p className="text-[12px] leading-relaxed text-ink-faint">{t("Shared with the Solver — edit boosts in its Breeding Setup panel.")}</p>
              </div>
            </div>
          )}
        </div>

        <button
          className="mt-1 rounded-md bg-amber px-4 py-2.5 text-sm font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
          onClick={runSolve}
          disabled={!canSolve}
        >
          {solving ? t("Solving…") : t("Solve IV line")}
        </button>
        {!saveDir.trim() && (
          <p className="-mt-2 text-[12px] leading-relaxed text-ink-faint">{t("Load a save from the sidebar to scan donors and solve.")}</p>
        )}
      </aside>

      {/* Best donors */}
      {showDonors && (
        <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-auto border-r border-line bg-panel/60 px-4 pb-6 pt-5">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-amber">{t("Best donors")}</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-faint">{t("Your strongest owned parents for ")}{species || t("this line")}
              {plans && plans.length > 0 ? t(" and its plan kin") : ""}.
            </p>
          </div>
          {donorGroups.length === 0 ? (
            <div className="rounded-md border border-line bg-panel px-3 py-4 text-[12px] leading-relaxed text-ink-faint">{t("No owned ")}{species || t("pals")}{t(" yet. Catch or breed one to seed the line, then its best IVs show up here.")}</div>
          ) : (
            donorGroups.map((group) => (
              <div key={group.key} className="flex flex-col gap-1.5">
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                  {tr(group.label)}
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
        {solving ? (
          <SolveProgress progress={progress} onCancel={cancel} />
        ) : (
          <>
            {cancelled && !plans && (
              <div className="m-6 rounded-md border border-line bg-raised px-3 py-2 text-[12px] text-ink-dim">{t("Solve cancelled.")}</div>
            )}
        {error && (
          <div className="m-6 rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
            {error}
          </div>
        )}

        {plans && plans.length === 0 && (
          <NoPathPanel
            diagnosis={diagnosis}
            maxSteps={maxSteps}
            title={t("No line found")}
            fallback={
              <p className="max-w-xs text-sm text-ink-faint">{t("No breeding chain reaches those IV floors within ")}{maxSteps}{t(" steps. Loosen a threshold, raise max steps, or try a cake with an IV floor.")}</p>
            }
          />
        )}

        {plans && plans.length > 0 && (
          <>
            {banners}
            {searchTruncated && (
              <div className="border-b border-line-soft bg-abyss/40 px-4 py-1.5">
                <span className="font-mono text-[11px] tabular-nums text-ink-faint">{t("search truncated at time budget — plans shown may not be optimal")}</span>
              </div>
            )}
            <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2">
              <div
                className="flex flex-wrap items-center gap-1"
                role="tablist"
                aria-label={t("Breeding lines")}
              >
                {plans.map((_plan, i) => {
                  const on = i === activePlan;
                  return (
                    <button
                      key={i}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => selectPlan(i)}
                      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                        on
                          ? "border-amber/50 bg-amber/10 text-amber"
                          : "border-line bg-panel text-ink-dim hover:bg-hover hover:text-ink"
                      }`}
                    >{t("Line ")}{i + 1}
                      {i === fastestIdx && (
                        <span
                          className={`rounded-sm px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wider ${
                            on ? "bg-amber/20 text-amber" : "bg-raised text-amber/80"
                          }`}
                        >{t("Fastest")}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="ml-auto flex items-center gap-2">{headerButtons}</div>
            </div>

            {active && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-raised px-4 py-2">
                <span className="font-mono text-lg font-semibold tabular-nums text-amber">
                  {formatDuration(active.total_time_secs)}
                </span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-dim">
                  <span>
                    <span className="text-ink">~{expectedEggs(active.root, eggMult)}</span>{" "}{t("eggs")}</span>
                  <span className="text-line">|</span>
                  <span>
                    <span className="text-ink">{active.total_steps}</span>{t(" steps")}</span>
                  {active.cake && active.cake !== "Normal" && (
                    <>
                      <span className="text-line">|</span>
                      <span>
                        <span className="text-ink">{active.cake_count}</span>{" "}
                        {active.cake}{t(" cake")}</span>
                    </>
                  )}
                </div>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-ink-faint">{t("Estimates · ")}{ivModel}{t(" IV model")}</span>
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
            <div className="font-display text-lg text-ink-dim">{t("Engineer an IV line")}</div>
            <p className="max-w-sm text-sm text-ink-faint">{t("Pick a target, set the stat floors you want, choose a cake, then solve. The plan shows the full lineage; your best owned parents sit in the donors panel.")}</p>
          </div>
        )}
          </>
        )}
        {drawer}
        <HistoryDrawer
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          nameToId={nameToId}
          onRestore={restoreFromHistory}
          storageKey="pal-lab.ivLabHistory"
          title={t("Recent IV lines")}
          ariaLabel="IV line history"
          variant="ivlab"
        />
      </section>
    </div>
  );
}

/** One label/value row of the compact farm-setup readout. */
function SetupLine({ label, value }: { label: string; value: string }) {
  useLocale();
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-faint">{tr(label)}</span>
      <span className="text-ink-dim">{value}</span>
    </div>
  );
}
