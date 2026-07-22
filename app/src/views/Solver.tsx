import { useEffect, useMemo, useState } from "react";
import { invoke } from "../lib/tauri";
import type {
  BreedingPlan,
  NamedEntry,
  PlanNode,
  SolveRequest,
} from "../lib/types";
import { formatDuration, genderView, probBand } from "../lib/ui";
import { PalIcon, Tag } from "../components/primitives";
import { PassiveStrip } from "../components/passive-strip";
import { useAppState } from "../state";

/** Count wild-caught leaves in a plan tree (header summary cross-check). */
function countWild(node: PlanNode): number {
  const self = typeof node.source === "object" && "Wild" in node.source ? 1 : 0;
  return self + node.children.reduce((n, c) => n + countWild(c), 0);
}

/** One node of the lineage ladder: a compact card, recursively collapsible. */
function TreeNode({
  node,
  nameToId,
  isRoot = false,
}: {
  node: PlanNode;
  nameToId: Map<string, string>;
  isRoot?: boolean;
}) {
  const g = genderView(node.gender);
  const isBred = node.source === "Bred";
  // Externally-tagged serde: read the source object's variant directly.
  const wild =
    typeof node.source === "object" && "Wild" in node.source
      ? node.source.Wild
      : null;
  const owned =
    typeof node.source === "object" && "Owned" in node.source
      ? node.source.Owned
      : null;
  const prob = probBand(node.probability);
  const hasChildren = node.children.length > 0;

  const card = (
    <div
      className={`flex flex-col gap-1.5 rounded-md border px-2.5 py-2 ${
        isRoot
          ? "border-amber/45 bg-amber/[0.06]"
          : wild
            ? "border-el-leaf/45 bg-el-leaf/[0.06]"
            : "border-line bg-panel"
      }`}
    >
      <div className="flex items-center gap-2.5">
        {hasChildren && (
          <svg
            className="shrink-0 text-ink-faint transition-transform duration-150 group-open/n:rotate-90"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        )}
        {!hasChildren && <span className="w-3 shrink-0" />}
        <PalIcon id={nameToId.get(node.species_name) ?? null} name={node.species_name} size={30} />
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-ink">{node.species_name}</span>
          <span className={`text-sm leading-none ${g.className}`} title={g.label}>
            {g.glyph}
          </span>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {wild ? (
            <>
              <span
                className="rounded-sm border border-el-leaf/50 bg-el-leaf/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wider text-el-leaf"
                title="Catch this pal in the wild"
              >
                Catch{wild.captures > 1 ? `\u00a0\u00d7${wild.captures}` : ""}
              </span>
              {wild.min_wild_level ? (
                <span
                  className="rounded-sm border border-el-leaf/35 bg-el-leaf/[0.08] px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none tabular-nums text-el-leaf"
                  title={`Wild spawns from level ${wild.min_wild_level}`}
                >
                  Lv {wild.min_wild_level}+
                </span>
              ) : null}
            </>
          ) : owned ? (
            <Tag>Owned &middot; {owned.location}</Tag>
          ) : isBred ? (
            <Tag tone="amber">Bred</Tag>
          ) : null}
          {isBred && (
            <>
              <span
                className={`rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${prob.text} ${prob.ring}`}
                title={`${prob.label} odds`}
              >
                {(node.probability * 100).toFixed(0)}%
              </span>
              <span className="font-mono text-[11px] tabular-nums text-ink-dim">
                {formatDuration(node.est_time_secs)}
              </span>
            </>
          )}
        </div>
      </div>

      {node.passives.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5 pl-[3.6rem]">
          {node.passives.map((p, i) => (
            <PassiveStrip key={`${p}-${i}`} id={p} size="sm" />
          ))}
        </div>
      )}
    </div>
  );

  if (!hasChildren) return card;

  return (
    <details open className="group/n">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        {card}
      </summary>
      <div className="relative ml-[1.15rem] mt-1 flex flex-col gap-1 border-l border-line pl-5">
        {node.children.map((child, i) => (
          <div key={i} className="relative">
            <span className="absolute -left-5 top-[1.15rem] h-px w-4 bg-line" />
            <TreeNode node={child} nameToId={nameToId} />
          </div>
        ))}
      </div>
    </details>
  );
}

export default function Solver() {
  const { saveDir, solveTarget, clearSolveTarget } = useAppState();
  const [species, setSpecies] = useState("");
  const [passiveInput, setPassiveInput] = useState("");
  const [passives, setPassives] = useState<string[]>([]);
  const [maxSteps, setMaxSteps] = useState<number>(5);
  const [includeWild, setIncludeWild] = useState(false);

  const [speciesList, setSpeciesList] = useState<NamedEntry[]>([]);
  const [passiveList, setPassiveList] = useState<NamedEntry[]>([]);

  const [plans, setPlans] = useState<BreedingPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);

  useEffect(() => {
    invoke<NamedEntry[]>("list_species").then(setSpeciesList).catch(() => {});
    invoke<NamedEntry[]>("list_passives").then(setPassiveList).catch(() => {});
  }, []);

  // Pre-fill the target when the Pal-dex jumps here via "Solve for this pal".
  useEffect(() => {
    if (solveTarget !== null) {
      setSpecies(solveTarget);
      clearSolveTarget();
    }
  }, [solveTarget, clearSolveTarget]);

  const passiveNames = useMemo(
    () => new Set(passiveList.map((p) => p.name)),
    [passiveList],
  );
  const nameToId = useMemo(
    () => new Map(speciesList.map((s) => [s.name, s.id])),
    [speciesList],
  );
  const targetId = nameToId.get(species) ?? null;

  function addPassive() {
    const v = passiveInput.trim();
    if (v && !passives.includes(v)) setPassives((p) => [...p, v]);
    setPassiveInput("");
  }

  function removePassive(name: string) {
    setPassives((p) => p.filter((x) => x !== name));
  }

  async function runSolve() {
    setSolving(true);
    setError(null);
    setPlans(null);
    try {
      const spec: SolveRequest = {
        target_species: species,
        required_passives: passives,
        max_steps: maxSteps,
        include_wild: includeWild,
      };
      const result = await invoke<BreedingPlan[]>("solve", { saveDir, spec });
      setPlans(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setSolving(false);
    }
  }

  const canSolve = saveDir.trim() !== "" && species.trim() !== "" && !solving;
  const fastestIdx = plans && plans.length > 1
    ? plans.reduce((best, p, idx, arr) => (p.total_time_secs < arr[best].total_time_secs ? idx : best), 0)
    : -1;

  return (
    <div className="flex h-full">
      {/* Mission briefing */}
      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-auto border-r border-line bg-panel px-5 pb-6 pt-5">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            Solver
          </div>
          <h1 className="font-display text-xl font-bold tracking-wide text-ink">
            Breeding plan
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
              list="species-options"
              placeholder="e.g. Anubis"
              value={species}
              onChange={(e) => setSpecies(e.currentTarget.value)}
            />
            <datalist id="species-options">
              {speciesList.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
          </div>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Required passives
          </span>
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
              list="passive-options"
              placeholder="Add a passive..."
              value={passiveInput}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setPassiveInput(v);
                if (passiveNames.has(v)) {
                  if (!passives.includes(v)) setPassives((p) => [...p, v]);
                  setPassiveInput("");
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPassive();
                }
              }}
            />
            <button
              className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
              onClick={addPassive}
            >
              Add
            </button>
            <datalist id="passive-options">
              {passiveList.map((p) => (
                <option key={p.id} value={p.name} />
              ))}
            </datalist>
          </div>
          {passives.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {passives.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1 rounded-sm border border-amber/35 bg-amber/10 px-1.5 py-0.5 text-[11px] text-amber"
                >
                  {p}
                  <button
                    className="text-amber/60 hover:text-amber"
                    onClick={() => removePassive(p)}
                    aria-label={`Remove ${p}`}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
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
              Source pool
            </span>
            <div
              className="flex flex-col overflow-hidden rounded-md border border-line"
              role="radiogroup"
              aria-label="Which pals the solver may draw from"
            >
              {[
                { wild: false, label: "Only pals I own" },
                { wild: true, label: "Include pals I don\u2019t own" },
              ].map((m) => {
                const active = includeWild === m.wild;
                return (
                  <button
                    key={m.label}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setIncludeWild(m.wild)}
                    className={`flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-left text-[12px] transition-colors last:border-b-0 ${
                      active
                        ? "bg-raised text-amber"
                        : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        active ? "bg-amber" : "bg-line"
                      }`}
                    />
                    {m.label}
                  </button>
                );
              })}
            </div>
            {includeWild && (
              <p className="text-[12px] leading-relaxed text-ink-faint">
                Plans may include pals you&rsquo;d need to catch first.
              </p>
            )}
          </div>
        </div>

        <button
          className="mt-1 rounded-md bg-amber px-4 py-2.5 text-sm font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-40"
          onClick={runSolve}
          disabled={!canSolve}
        >
          {solving ? "Solving\u2026" : "Solve breeding path"}
        </button>
        {!saveDir.trim() && (
          <p className="-mt-2 text-[12px] leading-relaxed text-ink-faint">
            Load a save from the sidebar to solve for a target.
          </p>
        )}
      </aside>

      {/* Results */}
      <section className="flex-1 overflow-auto px-6 py-5">
        {error && (
          <div className="rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
            {error}
          </div>
        )}

        {plans && plans.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="font-display text-lg text-ink-dim">No path found</div>
            <p className="max-w-xs text-sm text-ink-faint">
              No breeding chain reaches that target within {maxSteps} steps. Try
              raising max steps or including pals you don&rsquo;t own.
            </p>
          </div>
        )}

        {plans && plans.length > 0 && (
          <div className="flex flex-col gap-5">
            {plans.map((plan, i) => {
              const wildNodes = countWild(plan.root);
              return (
                <article key={i} className="overflow-hidden rounded-lg border border-line bg-panel/40">
                  <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-raised px-4 py-3">
                    <span className="font-display text-sm font-bold tracking-wide text-ink">
                      Plan {i + 1}
                    </span>
                    {i === fastestIdx && (
                      <Tag tone="amber">Fastest</Tag>
                    )}
                    <span className="font-mono text-lg font-semibold tabular-nums text-amber">
                      {formatDuration(plan.total_time_secs)}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-dim">
                      <span>
                        <span className="text-ink">{plan.total_steps}</span> steps
                      </span>
                      <span className="text-line">|</span>
                      <span>
                        <span className="text-el-leaf">{plan.total_wild_pals || wildNodes}</span> wild
                      </span>
                      {plan.cake && plan.cake !== "Normal" && (
                        <>
                          <span className="text-line">|</span>
                          <span>
                            <span className="text-ink">{plan.cake_count}</span> {plan.cake} cake
                          </span>
                        </>
                      )}
                    </div>
                  </header>
                  <div className="p-3 text-sm">
                    <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      Target
                    </div>
                    <TreeNode node={plan.root} nameToId={nameToId} isRoot />
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {!plans && !error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="font-display text-lg text-ink-dim">Plan a breeding path</div>
            <p className="max-w-sm text-sm text-ink-faint">
              Pick a save, choose a target species and the passives you want, then
              solve. Each plan shows the full lineage from wild and owned pals up
              to your target.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
