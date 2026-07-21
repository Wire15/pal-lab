import { useEffect, useMemo, useState } from "react";
import { invoke } from "../lib/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import type { NamedEntry, OwnedPal, SaveSummary } from "../lib/types";
import {
  containerLabel,
  genderView,
  ivBand,
  QUALITY_FILL,
  QUALITY_TEXT,
} from "../lib/ui";
import { PalIcon, PassiveChip, Tag } from "../components/primitives";

type SortKey =
  | "species"
  | "gender"
  | "level"
  | "hp"
  | "attack"
  | "defense"
  | "container_kind";

type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "species", label: "Pal" },
  { key: "gender", label: "Sex" },
  { key: "level", label: "Lv", align: "right" },
  { key: "hp", label: "HP", align: "right" },
  { key: "attack", label: "ATK", align: "right" },
  { key: "defense", label: "DEF", align: "right" },
  { key: "container_kind", label: "Location" },
];

/** One IV talent: mono numeral tinted by quality with a thin quality bar. */
function IvCell({ value }: { value: number }) {
  const band = ivBand(value);
  return (
    <div className="flex flex-col items-end gap-1">
      <span className={`font-mono text-[13px] font-medium tabular-nums ${QUALITY_TEXT[band]}`}>
        {value}
      </span>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-abyss">
        <span
          className={`block h-full rounded-full ${QUALITY_FILL[band]}`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </span>
    </div>
  );
}

export default function SaveInspector() {
  const [saveDir, setSaveDir] = useState("");
  const [summary, setSummary] = useState<SaveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("species");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [nameById, setNameById] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    invoke<NamedEntry[]>("list_species")
      .then((list) => setNameById(new Map(list.map((s) => [s.id, s.name]))))
      .catch(() => {});
  }, []);

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") setSaveDir(picked);
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<SaveSummary>("load_save", { saveDir });
      setSummary(result);
    } catch (e) {
      setError(String(e));
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const displayName = (pal: OwnedPal) => nameById.get(pal.character_id) ?? pal.character_id;

  const rows = useMemo(() => {
    if (!summary) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? summary.pals.filter((p) => {
          const hay = [
            displayName(p),
            p.character_id,
            p.nickname ?? "",
            p.container_kind,
            ...p.passives,
          ]
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : summary.pals;

    const value = (pal: OwnedPal): string | number => {
      switch (sortKey) {
        case "species":
          return displayName(pal).toLowerCase();
        case "gender":
          return pal.gender ?? "";
        case "level":
          return pal.level;
        case "hp":
          return pal.ivs.hp;
        case "attack":
          return pal.ivs.attack;
        case "defense":
          return pal.ivs.defense;
        case "container_kind":
          return pal.container_kind;
      }
    };

    return [...filtered].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, sortKey, sortDir, query, nameById]);

  return (
    <div className="flex h-full flex-col">
      {/* View header */}
      <header className="shrink-0 border-b border-line bg-panel/60 px-6 pb-4 pt-5">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
              Save Inspector
            </div>
            <h1 className="font-display text-xl font-bold tracking-wide text-ink">
              Roster
            </h1>
          </div>
          {summary && (
            <div className="text-right font-mono text-xs text-ink-dim">
              <span className="text-ink">{summary.world_name}</span>
              <span className="mx-2 text-ink-faint">/</span>
              <span className="text-amber">{summary.pals.length}</span> pals
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-3 py-1.5 font-mono text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
            placeholder="Path to save folder..."
            value={saveDir}
            onChange={(e) => setSaveDir(e.currentTarget.value)}
          />
          <button
            className="rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:border-line hover:bg-hover hover:text-ink"
            onClick={pickFolder}
          >
            Browse
          </button>
          <button
            className="rounded-md bg-amber px-4 py-1.5 text-[13px] font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-50"
            onClick={load}
            disabled={loading}
          >
            {loading ? "Loading..." : "Load save"}
          </button>
        </div>

        {summary && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-dim">
            <span>
              <span className="text-ink-faint">Players </span>
              {summary.players.map((p) => p.name).join(", ") || "none"}
            </span>
            {summary.warnings.length > 0 && (
              <span className="text-warn" title={summary.warnings.slice(0, 20).join("\n")}>
                {summary.warnings.length} parser warnings
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <input
                className="w-56 rounded-md border border-line bg-abyss px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
                placeholder="Filter by name, passive, location..."
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              {query && (
                <span className="font-mono text-ink-faint">{rows.length} shown</span>
              )}
            </span>
          </div>
        )}
      </header>

      {/* Body */}
      {error && (
        <div className="m-6 rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </div>
      )}

      {summary ? (
        rows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
            No pals match "{query}".
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-raised text-left">
                  {COLUMNS.map((c) => {
                    const activeSort = sortKey === c.key;
                    return (
                      <th
                        key={c.key}
                        onClick={() => toggleSort(c.key)}
                        className={`cursor-pointer select-none border-b border-line px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-wider transition-colors hover:text-ink ${
                          c.align === "right" ? "text-right" : "text-left"
                        } ${activeSort ? "text-amber" : "text-ink-faint"}`}
                      >
                        {c.label}
                        <span className="ml-1 inline-block w-2 text-amber">
                          {activeSort ? (sortDir === "asc" ? "\u25b2" : "\u25bc") : ""}
                        </span>
                      </th>
                    );
                  })}
                  <th className="border-b border-line px-4 py-2.5 text-left font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                    Passives
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((pal) => {
                  const g = genderView(pal.gender);
                  return (
                    <tr
                      key={pal.instance_id.join("-")}
                      className="border-b border-line-soft transition-colors hover:bg-panel/70"
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-3">
                          <PalIcon id={pal.character_id} name={displayName(pal)} size={34} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium text-ink">
                                {displayName(pal)}
                              </span>
                              {pal.is_boss && <Tag tone="boss">Alpha</Tag>}
                              {pal.rank > 0 && (
                                <span
                                  className="font-mono text-[11px] text-amber"
                                  title={`Condensation rank ${pal.rank}`}
                                >
                                  {"\u2605".repeat(pal.rank)}
                                </span>
                              )}
                            </div>
                            <div className="truncate font-mono text-[11px] text-ink-faint">
                              {pal.nickname ? `"${pal.nickname}"` : pal.character_id}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`text-base leading-none ${g.className}`} title={g.label}>
                          {g.glyph}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-[13px] tabular-nums text-ink-dim">
                        {pal.level}
                      </td>
                      <td className="px-4 py-2">
                        <IvCell value={pal.ivs.hp} />
                      </td>
                      <td className="px-4 py-2">
                        <IvCell value={pal.ivs.attack} />
                      </td>
                      <td className="px-4 py-2">
                        <IvCell value={pal.ivs.defense} />
                      </td>
                      <td className="px-4 py-2">
                        <Tag>{containerLabel(pal.container_kind)}</Tag>
                      </td>
                      <td className="px-4 py-2">
                        {pal.passives.length > 0 ? (
                          <div className="flex max-w-[22rem] flex-wrap gap-1">
                            {pal.passives.map((p, i) => (
                              <PassiveChip key={`${p}-${i}`} id={p} />
                            ))}
                          </div>
                        ) : (
                          <span className="text-ink-faint">&mdash;</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        !error && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="font-display text-lg text-ink-dim">No save loaded</div>
            <p className="max-w-xs text-sm text-ink-faint">
              Point at a Palworld save folder and load it to inspect every owned
              pal, their IV talents, and passives.
            </p>
          </div>
        )
      )}
    </div>
  );
}
