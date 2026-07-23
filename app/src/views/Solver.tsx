import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BreedingPlan,
  Guid,
  PlanNode,
  QueueItemResult,
  QueueResponse,
  SolveRequest,
} from "../lib/types";
import { formatDuration, genderView, probBand } from "../lib/ui";
import { PalIcon, Tag } from "../components/primitives";
import { PassiveStrip } from "../components/passive-strip";
import { PassivePicker } from "../components/passive-picker";
import { PinPicker, MAX_PINS } from "../components/pin-picker";
import {
  QueuePanel,
  readQueue,
  writeQueue,
  type QueueEntry,
} from "../components/queue-panel";
import { hexGuid } from "../components/palbox/selectors";
import { useAppState, useBreedingSetup } from "../state";
import { useSolve, type NodeSelection, type SolveSpec } from "../lib/use-solve";
import {
  BreedingSetupPanel,
  describeSetup,
  isNeutralSetup,
} from "../components/breeding-setup";
import { PlanGraph } from "../components/plan-graph";
import { PlanNodePanel } from "../components/plan-node-panel";
import { SolveProgress } from "../components/solve-progress";
import {
  downloadBlob,
  encodePlanCode,
  planPngFilename,
  renderPlanPng,
  type DecodedPlanCode,
} from "../components/plan-export";
import {
  PlansDrawer,
  defaultPlanName,
  saveNewPlan,
  type SavedPlan,
} from "../components/plans-drawer";

/** Catch policy for a solve; mirrors the contract's SolveRequest["catching"]. */
type CatchingMode = NonNullable<SolveRequest["catching"]>;

/** One wild species the active plan needs caught, aggregated across the tree. */
interface CatchChip {
  id: string | null;
  name: string;
  captures: number;
  minLevel: number;
}

/** Walk a plan tree and aggregate its Wild leaves by species: captures sum,
 *  min-wild-level is the highest floor seen. Drives the required-catches callout. */
function catchChips(root: PlanNode, nameToId: Map<string, string>): CatchChip[] {
  const acc = new Map<string, CatchChip>();
  (function walk(n: PlanNode) {
    if (typeof n.source === "object" && "Wild" in n.source) {
      const w = n.source.Wild;
      const cur = acc.get(n.species_name);
      if (cur) {
        cur.captures += w.captures;
        cur.minLevel = Math.max(cur.minLevel, w.min_wild_level);
      } else {
        acc.set(n.species_name, {
          id: nameToId.get(n.species_name) ?? null,
          name: n.species_name,
          captures: w.captures,
          minLevel: w.min_wild_level,
        });
      }
    }
    n.children.forEach(walk);
  })(root);
  return [...acc.values()];
}

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

/** Warn banner shown when `pinned_parents` eliminated every otherwise-valid
 *  plan (single solve or a queue item). */
function PinsUnsatisfiedBanner() {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-y border-warn/30 bg-warn/[0.08] px-4 py-2.5">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-warn">
        Pins unsatisfied
      </span>
      <span className="text-[12.5px] leading-relaxed text-ink-dim">
        No plan uses all pinned parents &mdash; unpin or raise Max steps.
      </span>
    </div>
  );
}

interface PlanResultsProps {
  plans: BreedingPlan[];
  fallbackUsed: boolean;
  nameToId: Map<string, string>;
  requestDex: (speciesId: string, instanceId?: string) => void;
  activePlan: number;
  setActivePlan: (i: number) => void;
  selection: NodeSelection | null;
  setSelection: (s: NodeSelection | null) => void;
  viewMode: "graph" | "list";
  setViewMode: (m: "graph" | "list") => void;
  /** Right-aligned toolbar slot (single-solve Save / PNG / Copy / Plans). Queue
   *  items omit it — their actions live at the queue level. */
  headerRight?: React.ReactNode;
}

/** The plan tabs + Graph|List toggle + required-catches callout + setup banner +
 *  the graph/list renderer with its node inspector. Shared verbatim by the
 *  single-solve results and every queue-item accordion (contract: a queue item
 *  expands to "its plan tabs + PlanGraph exactly like single results").
 *  Assumes `plans.length > 0`; the caller renders empty/error states. */
function PlanResults({
  plans,
  fallbackUsed,
  nameToId,
  requestDex,
  activePlan,
  setActivePlan,
  selection,
  setSelection,
  viewMode,
  setViewMode,
  headerRight,
}: PlanResultsProps) {
  const { setup, cake } = useBreedingSetup();

  const fastestIdx = useMemo(
    () =>
      plans.length > 1
        ? plans.reduce(
            (best, p, idx, arr) =>
              p.total_time_secs < arr[best].total_time_secs ? idx : best,
            0,
          )
        : -1,
    [plans],
  );

  const activePlanObj = plans[activePlan] ?? plans[0] ?? null;
  const catchAgg = useMemo(
    () => (activePlanObj ? catchChips(activePlanObj.root, nameToId) : []),
    [activePlanObj, nameToId],
  );
  const activeRootWild =
    activePlanObj &&
    typeof activePlanObj.root.source === "object" &&
    "Wild" in activePlanObj.root.source
      ? activePlanObj.root.source.Wild
      : null;
  const catchOnly = !!(
    plans.length === 1 &&
    activeRootWild &&
    activePlanObj &&
    activePlanObj.total_steps === 0
  );
  const showCatchCallout =
    !!activePlanObj && (catchOnly || (fallbackUsed && catchAgg.length > 0));

  return (
    <>
      {/* Plan tabs + Graph|List toggle */}
      <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <div
          className="flex flex-wrap items-center gap-1"
          role="tablist"
          aria-label="Breeding plans"
        >
          {plans.map((_plan, i) => {
            const active = i === activePlan;
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActivePlan(i)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  active
                    ? "border-amber/50 bg-amber/10 text-amber"
                    : "border-line bg-panel text-ink-dim hover:bg-hover hover:text-ink"
                }`}
              >
                Plan {i + 1}
                {i === fastestIdx && (
                  <span
                    className={`rounded-sm px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wider ${
                      active ? "bg-amber/20 text-amber" : "bg-raised text-amber/80"
                    }`}
                  >
                    Fastest
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">{headerRight}</div>
        <div
          className="flex overflow-hidden rounded-md border border-line"
          role="radiogroup"
          aria-label="Result view"
        >
          {(["graph", "list"] as const).map((m) => {
            const active = viewMode === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setViewMode(m)}
                className={`px-3 py-1 text-[12px] font-medium capitalize transition-colors ${
                  active
                    ? "bg-raised text-amber"
                    : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>
      {showCatchCallout && activePlanObj && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-el-leaf/25 bg-el-leaf/[0.06] px-4 py-2.5">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-el-leaf">
            {catchOnly ? "Catch only" : "Needs catching"}
          </span>
          {catchOnly ? (
            <span className="text-[12.5px] leading-relaxed text-ink-dim">
              <span className="font-medium text-ink">
                {activePlanObj.root.species_name}
              </span>{" "}
              can&rsquo;t be bred from any other species &mdash; catch it in the
              wild
              {activeRootWild && activeRootWild.min_wild_level
                ? ` (Lv ${activeRootWild.min_wild_level}+)`
                : ""}
              .
            </span>
          ) : (
            <>
              <span className="text-[12.5px] leading-relaxed text-ink-dim">
                No pure-breeding path from your pals &mdash; this plan needs
                catches:
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {catchAgg.map((c) => (
                  <span
                    key={c.name}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-el-leaf/40 bg-el-leaf/[0.08] px-1.5 py-0.5 text-[11px] text-el-leaf"
                  >
                    <PalIcon id={c.id} name={c.name} size={16} />
                    <span className="font-medium">
                      {c.name}
                      {c.captures > 1 ? `\u00a0\u00d7${c.captures}` : ""}
                    </span>
                    {c.minLevel > 0 && (
                      <span className="font-mono tabular-nums text-el-leaf/90">
                        &middot; Lv {c.minLevel}+
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {!isNeutralSetup(setup, cake) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber/20 bg-amber/[0.05] px-4 py-1.5">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-amber">
            Setup
          </span>
          <span className="font-mono text-[11px] tabular-nums text-ink-dim">
            {describeSetup(setup, cake).join("\u00a0\u00a0/\u00a0\u00a0")}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            &middot; est.
          </span>
        </div>
      )}

      {viewMode === "graph" ? (
        <>
          {activePlanObj && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-raised px-4 py-2">
              <span className="font-mono text-lg font-semibold tabular-nums text-amber">
                {formatDuration(activePlanObj.total_time_secs)}
              </span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-dim">
                <span>
                  <span className="text-ink">{activePlanObj.total_steps}</span> steps
                </span>
                <span className="text-line">|</span>
                <span>
                  <span className="text-el-leaf">
                    {activePlanObj.total_wild_pals || countWild(activePlanObj.root)}
                  </span>{" "}
                  wild
                </span>
                {activePlanObj.cake && activePlanObj.cake !== "Normal" && (
                  <>
                    <span className="text-line">|</span>
                    <span>
                      <span className="text-ink">{activePlanObj.cake_count}</span>{" "}
                      {activePlanObj.cake} cake
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">
              {activePlanObj && (
                <PlanGraph
                  plan={activePlanObj}
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
      ) : (
        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="flex flex-col gap-5">
            {plans.map((plan, i) => {
              const wildNodes = countWild(plan.root);
              return (
                <article key={i} className="overflow-hidden rounded-lg border border-line bg-panel/40">
                  <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-raised px-4 py-3">
                    <span className="font-display text-sm font-bold tracking-wide text-ink">
                      Plan {i + 1}
                    </span>
                    {i === fastestIdx && <Tag tone="amber">Fastest</Tag>}
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
        </div>
      )}
    </>
  );
}

/** Status-chip color per queue-item outcome. */
const QUEUE_STATUS_CLASS: Record<string, string> = {
  bad: "border-bad/40 bg-bad/10 text-bad",
  faint: "border-line bg-raised text-ink-faint",
  leaf: "border-el-leaf/45 bg-el-leaf/10 text-el-leaf",
  amber: "border-amber/45 bg-amber/10 text-amber",
};

/** One queue-result accordion row: a status header that expands to the item's
 *  full plan results (its own tabs/graph/inspector state), or an empty/pins
 *  note when the item produced no plan. */
function QueueItemView({
  index,
  item,
  nameToId,
  requestDex,
}: {
  index: number;
  item: QueueItemResult;
  nameToId: Map<string, string>;
  requestDex: (speciesId: string, instanceId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activePlan, setActivePlan] = useState(0);
  const [selection, setSelection] = useState<NodeSelection | null>(null);
  const [viewMode, setViewMode] = useState<"graph" | "list">("graph");

  const best = item.plans[0] ?? null;
  const status = !item.pins_satisfied
    ? { tone: "bad", label: "Pins unsatisfied" }
    : item.plans.length === 0
      ? { tone: "faint", label: "No plan" }
      : item.fallback_used
        ? { tone: "leaf", label: "Needs catching" }
        : { tone: "amber", label: best ? formatDuration(best.total_time_secs) : "" };
  const hasPlans = item.plans.length > 0;

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-panel/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 bg-raised px-4 py-2.5 text-left transition-colors hover:bg-hover"
      >
        <svg
          className={`shrink-0 text-ink-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
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
        <span className="w-4 shrink-0 text-center font-mono text-[11px] tabular-nums text-ink-faint">
          {index + 1}
        </span>
        <PalIcon
          id={nameToId.get(item.target_species) ?? null}
          name={item.target_species}
          size={26}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          {item.target_species}
        </span>
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none tabular-nums ${QUEUE_STATUS_CLASS[status.tone]}`}
        >
          {status.label}
        </span>
      </button>
      {open &&
        (hasPlans ? (
          <div className="flex h-[540px] flex-col overflow-hidden border-t border-line">
            <PlanResults
              plans={item.plans}
              fallbackUsed={item.fallback_used}
              nameToId={nameToId}
              requestDex={requestDex}
              activePlan={activePlan}
              setActivePlan={setActivePlan}
              selection={selection}
              setSelection={setSelection}
              viewMode={viewMode}
              setViewMode={setViewMode}
            />
          </div>
        ) : !item.pins_satisfied ? (
          <PinsUnsatisfiedBanner />
        ) : (
          <div className="border-t border-line px-4 py-4 text-[13px] text-ink-faint">
            No breeding chain reached this target within its step limit.
          </div>
        ))}
    </article>
  );
}

/** Queue results view — replaces the single-solve results when a queue has been
 *  solved. A combined header + the item-k-seeding note over an accordion of
 *  per-target results, with a "back to single solve" affordance. */
function QueueResults({
  result,
  nameToId,
  requestDex,
  onBack,
}: {
  result: QueueResponse;
  nameToId: Map<string, string>;
  requestDex: (speciesId: string, instanceId?: string) => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-4 py-2.5">
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.2em] text-amber">
          Queue
        </span>
        <span className="font-mono text-[13px] tabular-nums text-ink-dim">
          combined ~
          <span className="font-semibold text-amber">
            {formatDuration(result.combined_effort_secs)}
          </span>
        </span>
        <span className="text-line">|</span>
        <span className="font-mono text-[13px] tabular-nums text-ink-dim">
          <span className="text-ink">{result.items.length}</span> targets
        </span>
        <button
          type="button"
          onClick={onBack}
          className="ml-auto rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
        >
          &larr; Back to single solve
        </button>
      </div>
      <div className="border-b border-line-soft bg-abyss/40 px-4 py-1.5">
        <span className="text-[12px] leading-relaxed text-ink-faint">
          Each target&rsquo;s plan assumes the previous targets were bred first.
        </span>
      </div>
      <div className="flex-1 overflow-auto px-4 py-4">
        <div className="flex flex-col gap-2">
          {result.items.map((item, i) => (
            <QueueItemView
              key={i}
              index={i}
              item={item}
              nameToId={nameToId}
              requestDex={requestDex}
            />
          ))}
        </div>
      </div>
    </>
  );
}

export default function Solver() {
  const { saveDir, saveSummary, solveTarget, clearSolveTarget, requestDex } =
    useAppState();
  const [species, setSpecies] = useState("");
  const [passives, setPassives] = useState<string[]>([]);
  const [maxSteps, setMaxSteps] = useState<number>(5);
  const [includeWild, setIncludeWild] = useState(false);
  const [catching, setCatching] = useState<CatchingMode>("breeding_only");
  const [viewMode, setViewMode] = useState<"graph" | "list">("graph");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [pins, setPins] = useState<Guid[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>(readQueue);

  const {
    speciesList,
    nameToId,
    plans,
    fallbackUsed,
    pinsSatisfied,
    error,
    solving,
    progress,
    cancelled,
    cancel,
    activePlan,
    setActivePlan,
    selection,
    setSelection,
    lastRequest,
    restoredFrom,
    rehydrate,
    solve,
    queueResult,
    queueSolving,
    queueError,
    solveQueue,
    clearQueue,
    reset,
  } = useSolve();

  // Pre-fill the target when the Pal-dex jumps here via "Solve for this pal".
  useEffect(() => {
    if (solveTarget !== null) {
      setSpecies(solveTarget);
      clearSolveTarget();
    }
  }, [solveTarget, clearSolveTarget]);

  // Persist the queue so it survives restarts (entries store the request only).
  useEffect(() => {
    writeQueue(queue);
  }, [queue]);

  const targetId = nameToId.get(species) ?? null;
  const idToName = useMemo(
    () => new Map(speciesList.map((s) => [s.id, s.name])),
    [speciesList],
  );
  // "Add current target" and pinning need a save loaded and a target chosen.
  const canAdd = saveDir.trim() !== "" && species.trim() !== "";

  function removePassive(name: string) {
    setPassives((p) => p.filter((x) => x !== name));
  }

  // The current briefing assembled as a solve spec — exactly what a single solve
  // sends (the hook injects the shared setup/cake at solve time). "Add to queue"
  // reuses it verbatim, so a queued item and a live request are identical.
  function buildSpec(): SolveSpec {
    return {
      target_species: species,
      required_passives: passives,
      max_steps: maxSteps,
      include_wild: includeWild,
      catching,
      ...(pins.length > 0 ? { pinned_parents: pins } : {}),
    };
  }

  function runSolve() {
    return solve(buildSpec());
  }

  // RESET the query: clear the target, passives, pins, and the results — restore
  // max-steps / source-pool / catching to their defaults. Deliberately KEEPS the
  // breeding setup (boosters/cake/hatch) and the saved queue list: those describe
  // the farm, not this one query. `reset()` handles the results half in the hook.
  function resetForm() {
    setSpecies("");
    setPassives([]);
    setPins([]);
    setMaxSteps(5);
    setIncludeWild(false);
    setCatching("breeding_only");
    setNaming(false);
    reset();
  }

  function addPin(id: Guid) {
    setPins((p) => (p.length >= MAX_PINS ? p : [...p, id]));
  }
  function removePin(id: Guid) {
    setPins((p) => p.filter((x) => hexGuid(x) !== hexGuid(id)));
  }

  function addToQueue() {
    setQueue((q) => [...q, { id: crypto.randomUUID(), spec: buildSpec() }]);
  }
  function removeEntry(id: string) {
    setQueue((q) => q.filter((e) => e.id !== id));
  }
  function moveEntry(id: string, dir: -1 | 1) {
    setQueue((q) => {
      const i = q.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= q.length) return q;
      const next = [...q];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // Transient header confirmation ("Plan saved", "PNG exported", ...).
  const flashTimer = useRef<number | null>(null);
  function showFlash(msg: string) {
    setFlash(msg);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 2200);
  }

  // Sync the briefing form to a request (shared by load + import).
  function applyRequestToForm(r: SolveRequest) {
    setSpecies(r.target_species);
    setPassives(r.required_passives ?? []);
    setMaxSteps(r.max_steps ?? 5);
    setIncludeWild(!!r.include_wild);
    setCatching(r.catching ?? "breeding_only");
    setPins(r.pinned_parents ?? []);
  }

  // Load a saved plan: restore the form + rehydrate the result (staleness-flagged).
  function loadSaved(saved: SavedPlan) {
    applyRequestToForm(saved.request);
    rehydrate(saved);
    setDrawerOpen(false);
  }

  // Import a plan code: replay the request live so the tree is honest against
  // the current save (the hook injects the live setup/cake over the decoded ones).
  function importPlanCode(decoded: DecodedPlanCode) {
    applyRequestToForm(decoded.request);
    solve(decoded.request);
  }

  function beginSave() {
    if (!activePlanObj) return;
    setNameDraft(defaultPlanName(activePlanObj.root.species_name, activePlanObj));
    setNaming(true);
  }
  function commitSave() {
    if (!activePlanObj || !lastRequest || !plans) return;
    saveNewPlan({
      name:
        nameDraft.trim() ||
        defaultPlanName(activePlanObj.root.species_name, activePlanObj),
      saveDir,
      request: lastRequest,
      response: { plans, fallback_used: fallbackUsed },
      activePlan,
    });
    setNaming(false);
    showFlash("Plan saved");
  }

  async function exportPng() {
    if (!activePlanObj) return;
    setExporting(true);
    try {
      const blob = await renderPlanPng(activePlanObj, nameToId, {
        targetName: activePlanObj.root.species_name,
      });
      downloadBlob(blob, planPngFilename(activePlanObj.root.species_name));
      showFlash("PNG exported");
    } catch (e) {
      showFlash(`Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setExporting(false);
    }
  }

  async function copyCode() {
    if (!lastRequest) return;
    try {
      await navigator.clipboard.writeText(
        encodePlanCode(lastRequest, activePlan),
      );
      showFlash("Plan code copied");
    } catch {
      showFlash("Clipboard blocked");
    }
  }

  const canSolve = saveDir.trim() !== "" && species.trim() !== "" && !solving;

  // The active plan drives the single-solve toolbar actions (Save / PNG / Copy).
  const activePlanObj = plans && plans.length > 0 ? plans[activePlan] : null;

  return (
    <div className="flex h-full">
      {/* Mission briefing */}
      <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-auto border-r border-line bg-panel px-5 pb-6 pt-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
              Solver
            </div>
            <h1 className="font-display text-xl font-bold tracking-wide text-ink">
              Breeding plan
            </h1>
          </div>
          <button
            type="button"
            onClick={resetForm}
            title="Clear target, passives, pins and results (keeps breeding setup & queue)"
            className="mt-0.5 shrink-0 rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:border-bad/50 hover:text-bad focus-visible:border-bad/50 focus-visible:text-bad"
          >
            Reset
          </button>
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

        <PassivePicker
          selected={passives}
          onAdd={(name) => setPassives((p) => (p.includes(name) ? p : [...p, name]))}
          onRemove={removePassive}
        />

        {saveSummary && species.trim() !== "" && (
          <PinPicker
            pals={saveSummary.pals}
            idToName={idToName}
            pins={pins}
            onAdd={addPin}
            onRemove={removePin}
          />
        )}

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
              onChange={(e) =>
                setMaxSteps(Math.max(1, Math.round(Number(e.currentTarget.value) || 1)))
              }
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
                Also considers wild-catchable species you don&rsquo;t own yet.
              </p>
            )}
          </div>
          {includeWild && (
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                Catching
              </span>
              <div
                className="flex flex-col overflow-hidden rounded-md border border-line"
                role="radiogroup"
                aria-label="Whether the solver may use wild catches"
              >
                {[
                  { mode: "breeding_only" as const, label: "Breeding only" },
                  { mode: "allowed" as const, label: "Catching allowed" },
                ].map((m) => {
                  const active = catching === m.mode;
                  return (
                    <button
                      key={m.mode}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setCatching(m.mode)}
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
              <p className="text-[12px] leading-relaxed text-ink-faint">
                {catching === "breeding_only"
                  ? "Pure breeding from your pals. Falls back to catches only when no breeding path exists."
                  : "Wild catches may fill ingredient gaps anywhere in the chain."}
              </p>
            </div>
          )}
        </div>

        <BreedingSetupPanel />

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

        <QueuePanel
          entries={queue}
          nameToId={nameToId}
          canAdd={canAdd}
          onAdd={addToQueue}
          onRemove={removeEntry}
          onMove={moveEntry}
          onSolve={() => solveQueue(queue.map((e) => e.spec))}
          solving={queueSolving}
        />
      </aside>

      {/* Results */}
      <section className="flex flex-1 flex-col overflow-hidden">
        {solving || queueSolving ? (
          <SolveProgress
            progress={progress}
            onCancel={cancel}
            queueTargets={
              queueSolving ? queue.map((e) => e.spec.target_species) : undefined
            }
          />
        ) : (
          <>
            {cancelled && !plans && !queueResult && (
              <div className="m-6 rounded-md border border-line bg-raised px-3 py-2 text-[12px] text-ink-dim">
                Solve cancelled.
              </div>
            )}
        {queueError && (
          <div className="m-6 rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
            {queueError}
          </div>
        )}

        {queueResult ? (
          <QueueResults
            result={queueResult}
            nameToId={nameToId}
            requestDex={requestDex}
            onBack={clearQueue}
          />
        ) : (
          <>
            {error && (
              <div className="m-6 rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
                {error}
              </div>
            )}

            {plans && plans.length === 0 && (
              <>
                {!pinsSatisfied && <PinsUnsatisfiedBanner />}
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                  <div className="font-display text-lg text-ink-dim">No path found</div>
                  <p className="max-w-xs text-sm text-ink-faint">
                    No breeding chain reaches that target within {maxSteps} steps. Try
                    raising max steps or including pals you don&rsquo;t own.
                  </p>
                </div>
              </>
            )}

            {plans && plans.length > 0 && (
              <>
                {restoredFrom && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber/30 bg-amber/[0.07] px-4 py-2">
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-amber">
                      Saved {new Date(restoredFrom.created).toLocaleDateString()}
                    </span>
                    <span className="text-[12px] leading-relaxed text-ink-dim">
                      Loaded from &ldquo;{restoredFrom.name}&rdquo; &mdash; your roster
                      may have changed since. Re-solve for a fresh plan.
                    </span>
                  </div>
                )}
                {naming && activePlanObj && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-line bg-raised px-4 py-2">
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      Name this plan
                    </span>
                    <input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitSave();
                        if (e.key === "Escape") setNaming(false);
                      }}
                      className="min-w-0 flex-1 rounded-md border border-amber/60 bg-abyss px-2.5 py-1 text-[13px] text-ink focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={commitSave}
                      className="rounded-md bg-amber px-3 py-1 text-[12px] font-semibold text-abyss transition-colors hover:bg-amber-bright"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setNaming(false)}
                      className="rounded-md border border-line bg-raised px-3 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                    >
                      Cancel
                    </button>
                  </div>
                )}
                <PlanResults
                  plans={plans}
                  fallbackUsed={fallbackUsed}
                  nameToId={nameToId}
                  requestDex={requestDex}
                  activePlan={activePlan}
                  setActivePlan={setActivePlan}
                  selection={selection}
                  setSelection={setSelection}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                  headerRight={
                    <>
                      {flash && (
                        <span className="font-mono text-[11px] text-good">{flash}</span>
                      )}
                      <button
                        type="button"
                        onClick={beginSave}
                        disabled={!activePlanObj || !lastRequest}
                        className="rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Save plan
                      </button>
                      <button
                        type="button"
                        onClick={exportPng}
                        disabled={!activePlanObj || exporting}
                        className="rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {exporting ? "PNG\u2026" : "PNG"}
                      </button>
                      <button
                        type="button"
                        onClick={copyCode}
                        disabled={!lastRequest}
                        className="rounded-md border border-line bg-raised px-2.5 py-1 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Copy code
                      </button>
                      <button
                        type="button"
                        onClick={() => setDrawerOpen(true)}
                        className="rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1 text-[12px] font-medium text-amber transition-colors hover:bg-amber/20"
                      >
                        Plans
                      </button>
                    </>
                  }
                />
              </>
            )}

            {!plans && !error && (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <div className="font-display text-lg text-ink-dim">Plan a breeding path</div>
                <p className="max-w-sm text-sm text-ink-faint">
                  Pick a save, choose a target species and the passives you want, then
                  solve. Each plan shows the full lineage from wild and owned pals up
                  to your target.
                </p>
              </div>
            )}
          </>
        )}
          </>
        )}

        <PlansDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          currentSaveDir={saveDir}
          nameToId={nameToId}
          onLoad={loadSaved}
          onImport={importPlanCode}
        />
      </section>
    </div>
  );
}
