import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BreedingPlan,
  NamedEntry,
  PlanNode,
  PlanSource,
  SolveRequest,
} from "../lib/types";

function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs)) return "\u221e";
  const total = Math.round(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function genderSymbol(gender: PlanNode["gender"]): string {
  if (gender === "Male") return " \u2642";
  if (gender === "Female") return " \u2640";
  return "";
}

function describeSource(source: PlanSource): string {
  if (source === "Bred") return "bred";
  if ("Owned" in source) return `owned @ ${source.Owned.location}`;
  return `wild (~${source.Wild.captures} catches)`;
}

/** Count bred steps / wild nodes in a plan tree (for the header summary). */
function countWild(node: PlanNode): number {
  const self = typeof node.source === "object" && "Wild" in node.source ? 1 : 0;
  return self + node.children.reduce((n, c) => n + countWild(c), 0);
}

function PlanNodeView({ node, depth }: { node: PlanNode; depth: number }) {
  const label = (
    <span>
      <span className="font-medium">{node.species_name}</span>
      {genderSymbol(node.gender)}
      <span className="ml-2 text-gray-500">{describeSource(node.source)}</span>
      {typeof node.source === "object" && "Wild" in node.source ? null : (
        <span className="ml-2 tabular-nums text-gray-400">
          {(node.probability * 100).toFixed(1)}% &middot; {fmtDuration(node.est_time_secs)}
        </span>
      )}
    </span>
  );

  const passives =
    node.passives.length > 0 ? (
      <div className="mt-1 flex flex-wrap gap-1">
        {node.passives.map((p, i) => (
          <span
            key={`${p}-${i}`}
            className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700"
          >
            {p}
          </span>
        ))}
      </div>
    ) : null;

  if (node.children.length === 0) {
    return (
      <div className="py-1" style={{ paddingLeft: depth * 16 }}>
        {label}
        {passives}
      </div>
    );
  }

  return (
    <details open className="py-1" style={{ paddingLeft: depth * 16 }}>
      <summary className="cursor-pointer">{label}</summary>
      {passives}
      <div className="border-l border-gray-200 pl-2">
        {node.children.map((child, i) => (
          <PlanNodeView key={i} node={child} depth={depth + 1} />
        ))}
      </div>
    </details>
  );
}

export default function Solver() {
  const [saveDir, setSaveDir] = useState("");
  const [species, setSpecies] = useState("");
  const [passiveInput, setPassiveInput] = useState("");
  const [passives, setPassives] = useState<string[]>([]);
  const [maxSteps, setMaxSteps] = useState<number>(5);
  const [allowWild, setAllowWild] = useState(false);

  const [speciesList, setSpeciesList] = useState<NamedEntry[]>([]);
  const [passiveList, setPassiveList] = useState<NamedEntry[]>([]);

  const [plans, setPlans] = useState<BreedingPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);

  useEffect(() => {
    invoke<NamedEntry[]>("list_species").then(setSpeciesList).catch(() => {});
    invoke<NamedEntry[]>("list_passives").then(setPassiveList).catch(() => {});
  }, []);

  const passiveNames = useMemo(
    () => new Set(passiveList.map((p) => p.name)),
    [passiveList],
  );

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") setSaveDir(picked);
  }

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
        allow_wild: allowWild,
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

  return (
    <div className="flex flex-col gap-4 p-6">
      <h2 className="text-xl font-semibold">Solver</h2>

      <div className="flex items-center gap-2">
        <input
          className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
          placeholder="Path to save folder..."
          value={saveDir}
          onChange={(e) => setSaveDir(e.currentTarget.value)}
        />
        <button
          className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100"
          onClick={pickFolder}
        >
          Browse...
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Target species</span>
          <input
            className="rounded border border-gray-300 px-3 py-1.5"
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
        </label>

        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Required passives</span>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 rounded border border-gray-300 px-3 py-1.5"
              list="passive-options"
              placeholder="Add a passive..."
              value={passiveInput}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setPassiveInput(v);
                // Add immediately when a datalist option is picked.
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
              className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
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
                  className="flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800"
                >
                  {p}
                  <button
                    className="text-blue-500 hover:text-blue-800"
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

        <div className="flex items-center gap-6 text-sm">
          <label className="flex items-center gap-2">
            <span className="font-medium">Max steps</span>
            <input
              type="number"
              min={1}
              className="w-20 rounded border border-gray-300 px-2 py-1.5"
              value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.currentTarget.value))}
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allowWild}
              onChange={(e) => setAllowWild(e.currentTarget.checked)}
            />
            <span className="font-medium">Allow wild pals</span>
          </label>
        </div>

        <div>
          <button
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            onClick={runSolve}
            disabled={!canSolve}
          >
            {solving ? "Solving..." : "Solve"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {plans && plans.length === 0 && (
        <p className="text-sm text-gray-500">No breeding path found.</p>
      )}

      {plans && plans.length > 0 && (
        <div className="flex flex-col gap-4">
          {plans.map((plan, i) => (
            <div key={i} className="rounded border border-gray-200">
              <div className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium">
                Plan {i + 1} &mdash; {fmtDuration(plan.total_time_secs)}
                <span className="ml-2 font-normal text-gray-500">
                  {plan.total_steps} steps &middot; {plan.total_wild_pals} wild
                  {countWild(plan.root) !== plan.total_wild_pals
                    ? ` (${countWild(plan.root)} wild nodes)`
                    : ""}
                </span>
              </div>
              <div className="px-3 py-2 text-sm">
                <PlanNodeView node={plan.root} depth={0} />
              </div>
            </div>
          ))}
        </div>
      )}

      {!plans && !error && (
        <p className="text-sm text-gray-500">
          Pick a save, choose a target species and passives, then Solve.
        </p>
      )}
    </div>
  );
}
