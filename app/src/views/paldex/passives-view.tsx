import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../lib/tauri";
import type { PassiveEntry } from "../../lib/types";
import { PassiveCard } from "../../components/passive-card";
import { DexTabs, type DexTab } from "../../components/dex-tabs";
import { effectLabel } from "../../lib/ui";

/** Lowercase search haystack: name + humanized effect labels + description. */
function haystack(p: PassiveEntry): string {
  return [
    p.name,
    ...p.effects.map((e) => effectLabel(e.type)),
    p.description ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Paldb-style passive-skill browser. Shows only **pal-facing** passives (the
 * ones a pal can actually roll — the split paldb makes) as a card grid, sorted
 * strongest-first, with a name/effect search and a reset.
 */
export default function PassivesIndex({
  tab,
  onTab,
}: {
  tab: DexTab;
  onTab: (t: DexTab) => void;
}) {
  const [passives, setPassives] = useState<PassiveEntry[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    invoke<PassiveEntry[]>("list_passives").then(setPassives).catch(() => {});
  }, []);

  // Only pal-facing passives, strongest rank first, then alphabetical.
  const palFacing = useMemo(
    () =>
      passives
        .filter((p) => p.pal_facing)
        .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name)),
    [passives],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return palFacing;
    return palFacing.filter((p) => haystack(p).includes(q));
  }, [palFacing, query]);

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
                Passive skills
              </h1>
            </div>
            <DexTabs tab={tab} onTab={onTab} />
          </div>
          <div className="text-right font-mono text-xs text-ink-dim">
            {query.trim() ? (
              <>
                <span className="text-ink">{rows.length}</span>
                <span className="mx-1 text-ink-faint">/</span>
              </>
            ) : null}
            <span className={query.trim() ? "" : "text-ink"}>{palFacing.length}</span> pal
            passives
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
            placeholder="Search by name or effect..."
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <button
            onClick={() => setQuery("")}
            disabled={!query}
            className="select-none rounded-md border border-line bg-panel px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="font-display text-lg text-ink-dim">
            {passives.length === 0 ? "Loading passives\u2026" : "No passives match"}
          </div>
          {passives.length > 0 && (
            <p className="max-w-xs text-sm text-ink-faint">
              Nothing matches &ldquo;{query}&rdquo;. Try a different name or effect.
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
            {rows.map((p) => (
              <PassiveCard key={p.id} passive={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
