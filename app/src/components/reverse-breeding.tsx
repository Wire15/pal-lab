// BRED FROM — the reverse-breeding surface for a pal-dex detail page: every
// parent pair whose bred child resolves to this species, from the
// `reverse_breeding` command. Gender-pinned "unique" combos are badged and shown
// first; the combi-rank majority follows. When a save is loaded, pairs whose
// BOTH parents are owned glow and sort to the front of their group. Parents are
// clickable (in-dex navigation). Lazily fetched on mount so the detail view
// stays snappy; renders nothing for a non-breedable pal (no empty shell).

import { useEffect, useMemo, useState } from "react";
import type { Gender, ReversePair, SpeciesEntry } from "../lib/types";
import { invoke } from "../lib/tauri";
import { PalIcon } from "./primitives";
import { PalHoverCard } from "./pal-hover-card";
import { useAppState } from "../state";

/** Show the search filter once a species has more than this many parent pairs. */
const SEARCH_THRESHOLD = 30;

// --- module-cached species lookup (id -> row), shared across mounts ----------
let speciesMapPromise: Promise<Map<string, SpeciesEntry>> | null = null;

function speciesMap(): Promise<Map<string, SpeciesEntry>> {
  if (!speciesMapPromise) {
    speciesMapPromise = invoke<SpeciesEntry[]>("paldex_species")
      .then((list) => new Map(list.map((s) => [s.id, s])))
      .catch((e) => {
        speciesMapPromise = null; // allow retry on the next mount
        throw e;
      });
  }
  return speciesMapPromise;
}

/** Gender glyph (♂ water-blue / ♀ dragon-magenta), matching the app's palette. */
function GenderGlyph({ gender }: { gender: Gender }) {
  return (
    <span
      className={`font-mono text-[11px] leading-none ${
        gender === "Male" ? "text-el-water" : "text-el-dragon"
      }`}
      title={gender}
    >
      {gender === "Male" ? "\u2642" : "\u2640"}
    </span>
  );
}

/** A clickable parent: icon + name (+ optional gender pin), owned pals tinted. */
function ParentChip({
  id,
  name,
  gender,
  owned,
  onNavigate,
}: {
  id: string;
  name: string;
  gender: Gender | null;
  owned: boolean;
  onNavigate: (id: string) => void;
}) {
  return (
    <PalHoverCard speciesId={id}>
      <button
        onClick={() => onNavigate(id)}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-hover"
      >
        <PalIcon id={id} name={name} size={22} />
        <span className={`truncate text-[12px] ${owned ? "text-amber" : "text-ink"}`}>
          {name}
        </span>
        {gender && <GenderGlyph gender={gender} />}
      </button>
    </PalHoverCard>
  );
}

/** One parent pair row: parentA × parentB → child glyph. Both-owned pairs glow. */
function PairRow({
  pair,
  childId,
  childName,
  label,
  isOwned,
  onNavigate,
}: {
  pair: ReversePair;
  childId: string;
  childName: string;
  label: (id: string) => string;
  isOwned: (id: string) => boolean;
  onNavigate: (id: string) => void;
}) {
  const ownedA = isOwned(pair.parent1);
  const ownedB = isOwned(pair.parent2);
  const bothOwned = ownedA && ownedB;
  return (
    <div
      className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 transition-colors ${
        bothOwned
          ? "border-amber/40 bg-amber/[0.07] shadow-[0_0_0_1px_rgba(245,158,11,0.15)]"
          : "border-line bg-abyss/30"
      }`}
    >
      <ParentChip
        id={pair.parent1}
        name={label(pair.parent1)}
        gender={pair.parent1_gender}
        owned={ownedA}
        onNavigate={onNavigate}
      />
      <span className="shrink-0 px-0.5 font-mono text-[11px] text-ink-faint">&times;</span>
      <ParentChip
        id={pair.parent2}
        name={label(pair.parent2)}
        gender={pair.parent2_gender}
        owned={ownedB}
        onNavigate={onNavigate}
      />
      <span className="shrink-0 px-1 font-mono text-sm text-amber">&rarr;</span>
      <PalIcon id={childId} name={childName} size={18} className="shrink-0 opacity-80" />
    </div>
  );
}

export default function ReverseBreeding({
  species,
  onNavigate,
}: {
  species: string;
  onNavigate: (id: string) => void;
}) {
  const { roster } = useAppState();
  const [pairs, setPairs] = useState<ReversePair[] | null>(null);
  const [names, setNames] = useState<Map<string, SpeciesEntry>>(new Map());
  const [query, setQuery] = useState("");

  // Lazy-load the reverse-breeding pairs for this species on mount / id change.
  useEffect(() => {
    let alive = true;
    setPairs(null);
    setQuery("");
    invoke<ReversePair[]>("reverse_breeding", { species })
      .then((p) => alive && setPairs(p))
      .catch(() => alive && setPairs([]));
    return () => {
      alive = false;
    };
  }, [species]);

  // Species labels for the parent chips (module-cached, fetched once).
  useEffect(() => {
    let alive = true;
    speciesMap().then((m) => alive && setNames(m)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const label = useMemo(
    () => (id: string) => names.get(id)?.name ?? id,
    [names],
  );
  const isOwned = useMemo(
    () => (id: string) => {
      const c = roster?.[id];
      return !!c && c.male + c.female > 0;
    },
    [roster],
  );
  const childName = label(species);

  // Filter by parent name/id, then split into unique-first groups; within each
  // group both-parents-owned pairs sort to the front (stable otherwise, so the
  // backend's dex order is preserved).
  const { unique, rank } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (p: ReversePair) =>
      !q ||
      p.parent1.toLowerCase().includes(q) ||
      p.parent2.toLowerCase().includes(q) ||
      label(p.parent1).toLowerCase().includes(q) ||
      label(p.parent2).toLowerCase().includes(q);
    const ownedRank = (p: ReversePair) =>
      (isOwned(p.parent1) ? 1 : 0) + (isOwned(p.parent2) ? 1 : 0);
    const sortOwned = (list: ReversePair[]) =>
      list
        .map((p, i) => ({ p, i }))
        .sort((a, b) => ownedRank(b.p) - ownedRank(a.p) || a.i - b.i)
        .map((x) => x.p);
    const filtered = (pairs ?? []).filter(match);
    return {
      unique: sortOwned(filtered.filter((p) => p.kind === "unique")),
      rank: sortOwned(filtered.filter((p) => p.kind === "rank")),
    };
  }, [pairs, query, label, isOwned]);

  const total = pairs?.length ?? 0;
  const shown = unique.length + rank.length;

  const renderGroup = (list: ReversePair[]) =>
    list.map((p) => (
      <PairRow
        key={`${p.kind}:${p.parent1}:${p.parent2}`}
        pair={p}
        childId={species}
        childName={childName}
        label={label}
        isOwned={isOwned}
        onNavigate={onNavigate}
      />
    ));

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-panel/40">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-raised px-4 py-2.5">
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-dim">
          Bred from
          <PalIcon id={species} name={childName} size={16} className="opacity-80" />
        </span>
        {total > 0 && (
          <span className="font-mono text-[11px] tabular-nums text-ink-faint">
            {total} {total === 1 ? "pair" : "pairs"}
          </span>
        )}
      </header>
      <div className="p-4">
        {pairs === null ? (
          <p className="text-[12px] text-ink-faint">Loading breeding recipes&hellip;</p>
        ) : total === 0 ? (
          <p className="text-[12px] text-ink-faint">
            No breeding pair produces {childName}&nbsp;&mdash; catch it in the wild.
          </p>
        ) : (
          <>
            {total > SEARCH_THRESHOLD && (
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Filter parents&hellip;"
                className="mb-3 w-full rounded-md border border-line bg-abyss/50 px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/50 focus:outline-none"
              />
            )}

            {unique.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber">
                    Unique combos
                  </span>
                  <span className="rounded-sm border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber">
                    gender-locked
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">{renderGroup(unique)}</div>
              </div>
            )}

            {rank.length > 0 && (
              <div>
                {unique.length > 0 && (
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                    Standard combos
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2">{renderGroup(rank)}</div>
              </div>
            )}

            {shown === 0 && (
              <p className="text-[12px] text-ink-faint">
                No parents match &ldquo;{query}&rdquo;.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
