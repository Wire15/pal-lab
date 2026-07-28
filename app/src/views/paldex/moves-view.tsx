import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpeciesEntry } from "../../lib/types";
import { PalIcon } from "../../components/primitives";
import { ElementIcon } from "../../components/element";
import { ActiveSkillRow } from "../../components/active-skill";
import { DexTabs, type DexTab } from "../../components/dex-tabs";
import {
  loadActiveSkills,
  type ActiveSkill,
  type ActiveSkills,
} from "../../lib/active-skills";
import { loadLearnerIndex, type MoveLearner } from "../../lib/learnset-index";

type SortKey = "power" | "cooldown" | "name";
type SortDir = "asc" | "desc";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "power", label: "Power" },
  { key: "cooldown", label: "Cooldown" },
  { key: "name", label: "Name" },
];

/** The 9 canonical element types, in the §2 palette order, for the filter row.
 *  Mirrors the species grid's element filter (index-view). "None" (name-only /
 *  no-element skills) is intentionally not a chip — it is caught only when no
 *  element filter is active. */
const ELEMENT_KINDS = [
  "Normal",
  "Fire",
  "Water",
  "Leaf",
  "Electricity",
  "Ice",
  "Earth",
  "Dark",
  "Dragon",
];

interface MoveEntry {
  id: string;
  skill: ActiveSkill;
}

/** Stable empty learners array so a memoized {@link MoveRow} for a move with no
 *  learners doesn't see a fresh `[]` prop on every parent render. */
const NO_LEARNERS: MoveLearner[] = [];

/**
 * Pal-dex MOVES browser: the paldb-style active-skills reference. Lists every
 * active skill from `list_active_skills` as an in-game strip (element segment +
 * name + power + CT + expandable description, the same {@link ActiveSkillRow}
 * the detail view uses), with element / text / sort filters and a per-move
 * expandable LEARNED BY list built from the reverse learnset index. Learner rows
 * link into the species detail; a `focusMoveId` (from a detail's LEARNABLE MOVES
 * link) auto-expands, reveals, and highlights its row.
 */
export default function MovesIndex({
  species,
  tab,
  onTab,
  onSelectPal,
  focusMoveId,
  onFocusConsumed,
}: {
  species: SpeciesEntry[];
  tab: DexTab;
  onTab: (t: DexTab) => void;
  onSelectPal: (id: string) => void;
  focusMoveId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [activeMap, setActiveMap] = useState<ActiveSkills>({});
  const [learners, setLearners] = useState<Map<string, MoveLearner[]>>(
    () => new Map(),
  );
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("power");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [elements, setElements] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  // The move to scroll to once its row is actually rendered (a detail cross-link
  // can arm this before the async move list has loaded).
  const [focus, setFocus] = useState<string | null>(null);

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Stable ref registrar so memoized MoveRows keep a fixed `registerRow` prop.
  const registerRow = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  useEffect(() => {
    loadActiveSkills().then(setActiveMap).catch(() => {});
  }, []);

  useEffect(() => {
    loadLearnerIndex(species).then(setLearners).catch(() => {});
  }, [species]);

  function toggleElement(kind: string) {
    setElements((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Power reads strongest-first, name/cooldown read ascending by default.
      setSortDir(key === "power" ? "desc" : "asc");
    }
  }

  const toggleOpen = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const moves = useMemo<MoveEntry[]>(
    () => Object.entries(activeMap).map(([id, skill]) => ({ id, skill })),
    [activeMap],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = moves.filter((m) => {
      if (elements.size > 0 && !elements.has(m.skill.element)) return false;
      if (!q) return true;
      return (
        m.skill.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.skill.description ?? "").toLowerCase().includes(q)
      );
    });

    // Power/cooldown are nullable (non-damage / no-cooldown skills); a null
    // always sorts last regardless of direction so the meaningful values lead.
    const cmpNullable = (a: number | null, b: number | null): number => {
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return sortDir === "asc" ? a - b : b - a;
    };

    return [...list].sort((a, b) => {
      let cmp: number;
      if (sortKey === "power") cmp = cmpNullable(a.skill.power, b.skill.power);
      else if (sortKey === "cooldown")
        cmp = cmpNullable(a.skill.cool_time, b.skill.cool_time);
      else cmp = 0;
      if (cmp !== 0) return cmp;
      // Stable, human-readable tiebreak (and the primary key for name sort).
      const byName = a.skill.name.localeCompare(b.skill.name);
      return sortKey === "name" && sortDir === "desc" ? -byName : byName;
    });
  }, [moves, query, elements, sortKey, sortDir]);

  // Arm a one-shot focus request (a move link from a detail's LEARNABLE MOVES):
  // clear filters so the target is guaranteed visible, expand its learners, and
  // flash a highlight ring. Consume the parent's one-shot immediately; the
  // actual scroll is deferred to the effect below, since the row may not exist
  // until the async move list has loaded.
  useEffect(() => {
    if (!focusMoveId) return;
    setQuery("");
    setElements(new Set());
    setOpen((prev) => new Set(prev).add(focusMoveId));
    setHighlight(focusMoveId);
    setFocus(focusMoveId);
    onFocusConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMoveId]);

  // Perform the deferred scroll once the focused row is committed. Keyed on
  // `moves` so a focus armed before the list loaded still lands: when the rows
  // finally render, the ref resolves and this re-runs to scroll + un-highlight.
  useEffect(() => {
    if (!focus) return;
    // Defer past layout: with 300+ rows the scroll container is still sizing on
    // the commit frame, so a single rAF can compute the wrong offset. A short
    // timeout lets the full list lay out; `behavior: "auto"` (instant) is
    // reliable in every engine where smooth scroll may be throttled or no-op.
    const scroll = setTimeout(() => {
      rowRefs.current.get(focus)?.scrollIntoView({ block: "center" });
    }, 60);
    const clear = setTimeout(() => {
      setHighlight(null);
      setFocus(null);
    }, 2000);
    return () => {
      clearTimeout(scroll);
      clearTimeout(clear);
    };
  }, [focus, moves]);

  const anyFilter = query.trim().length > 0 || elements.size > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line bg-panel/60 px-6 pb-4 pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex items-center gap-4">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
                Pal-dex
              </div>
              <h1 className="font-display text-xl font-bold tracking-wide text-ink">
                Moves
              </h1>
            </div>
            <DexTabs tab={tab} onTab={onTab} />
          </div>
          <div className="text-right font-mono text-xs text-ink-dim">
            {query.trim() || elements.size > 0 ? (
              <>
                <span className="text-ink">{rows.length}</span> of {moves.length}
              </>
            ) : (
              <>
                <span className="text-ink">{moves.length}</span> moves
              </>
            )}
          </div>
        </div>

        {/* Search + sort */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
            placeholder="Search moves by name or effect..."
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <div className="flex items-center overflow-hidden rounded-md border border-line">
            {SORTS.map((s) => {
              const active = sortKey === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => toggleSort(s.key)}
                  className={`select-none border-l border-line px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors first:border-l-0 ${
                    active
                      ? "bg-raised text-amber"
                      : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
                  }`}
                >
                  {s.label}
                  {active && (
                    <span className="ml-1 text-amber">
                      {sortDir === "asc" ? "\u25b2" : "\u25bc"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Element filter — multi-select, OR semantics */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Element
          </span>
          <div className="flex items-center gap-1">
            {ELEMENT_KINDS.map((kind) => {
              const active = elements.has(kind);
              return (
                <button
                  key={kind}
                  onClick={() => toggleElement(kind)}
                  title={kind}
                  aria-pressed={active}
                  className={`group flex items-center justify-center rounded-sm border p-0.5 transition-colors ${
                    active
                      ? "border-amber/70 bg-raised"
                      : "border-line/60 bg-panel hover:border-line hover:bg-hover"
                  }`}
                >
                  <ElementIcon
                    element={kind}
                    size={18}
                    className={
                      active
                        ? ""
                        : "opacity-45 grayscale transition-[filter,opacity] group-hover:opacity-90 group-hover:grayscale-0"
                    }
                  />
                </button>
              );
            })}
          </div>
          {anyFilter && (
            <button
              onClick={() => {
                setQuery("");
                setElements(new Set());
              }}
              className="font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-dim"
            >
              Clear
            </button>
          )}
        </div>
      </header>

      {/* List */}
      {moves.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="font-display text-lg text-ink-dim">No moves loaded</div>
          <p className="max-w-xs text-sm text-ink-faint">
            The active-skill reference is unavailable. Run inside the app, or
            regenerate the dev fixtures.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="font-display text-lg text-ink-dim">No moves match</div>
          <p className="max-w-xs text-sm text-ink-faint">
            {query.trim()
              ? `Nothing matches \u201c${query}\u201d. Try a different name or effect.`
              : "No moves of the selected element. Pick another type."}
          </p>
          <button
            onClick={() => {
              setQuery("");
              setElements(new Set());
            }}
            className="mt-1 rounded-md border border-line bg-raised px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
            {rows.map((m) => (
              <MoveRow
                key={m.id}
                id={m.id}
                skill={m.skill}
                learners={learners.get(m.id) ?? NO_LEARNERS}
                open={open.has(m.id)}
                onToggle={toggleOpen}
                onSelectPal={onSelectPal}
                highlighted={highlight === m.id}
                registerRow={registerRow}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One move in the MOVES list: the {@link ActiveSkillRow} strip (verbatim, so the
 * element segment / power / CT / description-expand read identically to the
 * detail view's ACTIVE SKILLS rows) plus an expandable LEARNED BY disclosure
 * listing the species that learn it and the level each does. A `highlighted`
 * flash ring marks a row jumped to from a detail's move link.
 */
const MoveRow = memo(function MoveRow({
  id,
  skill,
  learners,
  open,
  onToggle,
  onSelectPal,
  highlighted,
  registerRow,
}: {
  id: string;
  skill: ActiveSkill;
  learners: MoveLearner[];
  open: boolean;
  onToggle: (id: string) => void;
  onSelectPal: (id: string) => void;
  highlighted: boolean;
  registerRow: (id: string, el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={(el) => registerRow(id, el)}
      className={`scroll-mt-6 rounded-md transition-shadow ${
        highlighted ? "ring-1 ring-amber ring-offset-2 ring-offset-abyss" : ""
      }`}
    >
      <ActiveSkillRow id={id} skill={skill} showMoveTags />
      {learners.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => onToggle(id)}
            aria-expanded={open}
            className="mt-1 flex w-full items-center gap-1.5 rounded-sm px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber/70"
          >
            <span
              aria-hidden
              className="text-[9px] leading-none transition-transform duration-150"
              style={{ transform: open ? "rotate(90deg)" : "none" }}
            >
              {"\u25B8"}
            </span>
            Learned by
            <span className="tabular-nums text-ink-dim">{learners.length}</span>
          </button>
          {open && (
            <div className="mt-1 grid gap-1.5 pl-2.5 [grid-template-columns:repeat(auto-fill,minmax(158px,1fr))]">
              {learners.map((l) => (
                <button
                  key={l.species.id}
                  onClick={() => onSelectPal(l.species.id)}
                  className="group flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-left transition-colors hover:border-amber/40 hover:bg-hover"
                >
                  <PalIcon id={l.species.id} name={l.species.name} size={22} />
                  <span className="min-w-0 truncate text-[12px] text-ink group-hover:text-ink">
                    {l.species.name}
                  </span>
                  <span className="ml-auto shrink-0 rounded-sm bg-abyss/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none tabular-nums text-ink-dim">
                    Lv {l.level}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
});
