import { useEffect, useMemo, useState } from "react";
import { invoke } from "../lib/tauri";
import type { Guid, NamedEntry, OwnedPal, PlayerRef } from "../lib/types";
import {
  containerLabel,
  genderView,
  ivBand,
  QUALITY_FILL,
  QUALITY_TEXT,
} from "../lib/ui";
import { PalIcon, PassiveChip, Tag } from "../components/primitives";
import { useAppState } from "../state";

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

/** Lowercase 32-char hex of a serialized GUID, matching the backend's format. */
function hexGuid(g: Guid): string {
  return g.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable row key for a pal (its instance GUID). */
function palKey(pal: OwnedPal): string {
  return pal.instance_id.join("-");
}

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

/** A labelled IV bar for the detail panel: label above, numeral, wide bar. */
function IvStat({ label, value }: { label: string; value: number }) {
  const band = ivBand(value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          {label}
        </span>
        <span className={`font-mono text-[13px] font-medium tabular-nums ${QUALITY_TEXT[band]}`}>
          {value}
        </span>
      </div>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-abyss">
        <span
          className={`block h-full rounded-full ${QUALITY_FILL[band]}`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </span>
    </div>
  );
}

/**
 * Right-side detail panel for one selected pal. Sits beside the table at wide
 * widths and overlays it below `xl` so the roster never gets crushed. Closes
 * via its X button, Escape, or a re-click on the open row (handled upstream).
 */
function PalDetail({
  pal,
  players,
  displayName,
  onClose,
  onViewInDex,
}: {
  pal: OwnedPal;
  players: PlayerRef[];
  displayName: string;
  onClose: () => void;
  onViewInDex: (id: string) => void;
}) {
  const g = genderView(pal.gender);
  const ownerHex = pal.owner_player_uid ? hexGuid(pal.owner_player_uid) : null;
  const owner = ownerHex
    ? players.find((p) => p.uid === ownerHex)?.name ?? null
    : null;
  const instanceHex = hexGuid(pal.instance_id);
  const skills = pal.active_skills ?? [];
  const [copied, setCopied] = useState(false);

  function copyId() {
    navigator.clipboard
      ?.writeText(instanceHex)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }

  return (
    <aside className="absolute right-0 top-0 z-20 flex h-full w-[380px] flex-col border-l border-line bg-panel xl:static xl:z-auto">
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-raised px-4 py-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
          Pal detail
        </span>
        <button
          onClick={onClose}
          aria-label="Close detail"
          className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-auto px-4 py-4">
        {/* Identity */}
        <div className="flex items-start gap-3">
          <PalIcon id={pal.character_id} name={displayName} size={72} className="rounded-lg" />
          <div className="min-w-0 pt-0.5">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-display text-lg font-bold tracking-wide text-ink">
                {displayName}
              </h2>
              {pal.is_boss && <Tag tone="boss">Alpha</Tag>}
            </div>
            {pal.nickname && (
              <div className="truncate font-mono text-[12px] text-ink-dim">
                &ldquo;{pal.nickname}&rdquo;
              </div>
            )}
            <button
              onClick={() => onViewInDex(pal.character_id)}
              className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-amber transition-colors hover:text-amber-bright"
            >
              View in Pal-dex
              <span aria-hidden>&rarr;</span>
            </button>
          </div>
        </div>

        {/* Vitals */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-line-soft py-3 text-[13px]">
          <span className="flex items-center gap-1.5" title={g.label}>
            <span className={`text-base leading-none ${g.className}`}>{g.glyph}</span>
            <span className="text-ink-dim">{g.label}</span>
          </span>
          <span className="text-ink-dim">
            <span className="font-mono text-ink-faint">Lv </span>
            <span className="font-mono tabular-nums text-ink">{pal.level}</span>
          </span>
          {pal.rank > 0 && (
            <span
              className="font-mono text-[13px] text-amber"
              title={`Condensation rank ${pal.rank}`}
            >
              {"\u2605".repeat(pal.rank)}
            </span>
          )}
        </div>

        {/* IVs */}
        <section className="mt-4">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            IV talents
          </div>
          <div className="grid grid-cols-3 gap-3">
            <IvStat label="HP" value={pal.ivs.hp} />
            <IvStat label="ATK" value={pal.ivs.attack} />
            <IvStat label="DEF" value={pal.ivs.defense} />
          </div>
        </section>

        {/* Passives */}
        <section className="mt-4">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Passives
          </div>
          {pal.passives.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {pal.passives.map((p, i) => (
                <PassiveChip key={`${p}-${i}`} id={p} />
              ))}
            </div>
          ) : (
            <span className="text-[13px] text-ink-faint">No passives.</span>
          )}
        </section>

        {/* Active skills */}
        <section className="mt-4">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Active skills
          </div>
          {skills.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {skills.map((s, i) => (
                <span
                  key={`${s}-${i}`}
                  title={s}
                  className="inline-flex items-center rounded-sm border border-line bg-raised px-1.5 py-0.5 font-mono text-[11px] leading-none text-ink-dim"
                >
                  {s}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-[13px] text-ink-faint">Not recorded.</span>
          )}
        </section>

        {/* Provenance */}
        <section className="mt-4">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Owner &amp; storage
          </div>
          <dl className="flex flex-col gap-1.5 text-[13px]">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint">Player</dt>
              <dd className="truncate text-ink">{owner ?? "\u2014"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint">Location</dt>
              <dd>
                <Tag>{containerLabel(pal.container_kind)}</Tag>
              </dd>
            </div>
            {pal.slot_index !== null && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Slot</dt>
                <dd className="font-mono tabular-nums text-ink-dim">{pal.slot_index}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-faint">Instance</dt>
              <dd>
                <button
                  onClick={copyId}
                  title="Copy instance id"
                  className="max-w-[18ch] truncate font-mono text-[11px] text-ink-dim transition-colors hover:text-amber"
                >
                  {copied ? "Copied!" : instanceHex}
                </button>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </aside>
  );
}

export default function SaveInspector() {
  const { saveSummary, saveLoading, saveError, requestDex } = useAppState();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("species");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [nameById, setNameById] = useState<Map<string, string>>(new Map());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    invoke<NamedEntry[]>("list_species")
      .then((list) => setNameById(new Map(list.map((s) => [s.id, s.name]))))
      .catch(() => {});
  }, []);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const displayName = (pal: OwnedPal) =>
    nameById.get(pal.character_id) ?? pal.character_id;

  const rows = useMemo(() => {
    if (!saveSummary) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? saveSummary.pals.filter((p) => {
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
      : saveSummary.pals;

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
  }, [saveSummary, sortKey, sortDir, query, nameById]);

  const selected = useMemo(
    () => rows.find((p) => palKey(p) === selectedKey) ?? null,
    [rows, selectedKey],
  );

  // Keyboard: up/down moves the selection while the detail panel is open;
  // Escape closes it. Scoped to when a pal is selected.
  useEffect(() => {
    if (!selectedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedKey(null);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const idx = rows.findIndex((p) => palKey(p) === selectedKey);
      if (idx === -1) return;
      const next =
        e.key === "ArrowDown"
          ? Math.min(rows.length - 1, idx + 1)
          : Math.max(0, idx - 1);
      const key = palKey(rows[next]);
      setSelectedKey(key);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-pal="${key}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey, rows]);

  return (
    <div className="flex h-full flex-col">
      {/* View header */}
      <header className="shrink-0 border-b border-line bg-panel/60 px-6 pb-4 pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
              Save Inspector
            </div>
            <h1 className="font-display text-xl font-bold tracking-wide text-ink">
              Roster
            </h1>
          </div>
          {saveSummary && (
            <div className="flex items-center gap-3">
              <div className="text-right font-mono text-xs text-ink-dim">
                <span className="text-ink">{saveSummary.world_name}</span>
                <span className="mx-2 text-ink-faint">/</span>
                <span className="text-amber">{saveSummary.pals.length}</span> pals
              </div>
              <input
                className="w-56 rounded-md border border-line bg-abyss px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
                placeholder="Filter by name, passive, location..."
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              {query && (
                <span className="font-mono text-xs text-ink-faint">
                  {rows.length} shown
                </span>
              )}
            </div>
          )}
        </div>

        {saveSummary && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-dim">
            <span>
              <span className="text-ink-faint">Players </span>
              {saveSummary.players.map((p) => p.name).join(", ") || "none"}
            </span>
            {saveSummary.warnings.length > 0 && (
              <span
                className="text-warn"
                title={saveSummary.warnings.slice(0, 20).join("\n")}
              >
                {saveSummary.warnings.length} parser warnings
              </span>
            )}
          </div>
        )}
      </header>

      {/* Body */}
      {saveError && !saveSummary && (
        <div className="m-6 rounded-md border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {saveError}
        </div>
      )}

      {saveSummary ? (
        rows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
            No pals match &ldquo;{query}&rdquo;.
          </div>
        ) : (
          <div className="relative flex flex-1 overflow-hidden">
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
                    const key = palKey(pal);
                    const isSelected = key === selectedKey;
                    return (
                      <tr
                        key={key}
                        data-pal={key}
                        onClick={() =>
                          setSelectedKey((cur) => (cur === key ? null : key))
                        }
                        aria-selected={isSelected}
                        className={`cursor-pointer border-b border-line-soft transition-colors ${
                          isSelected ? "bg-hover" : "hover:bg-panel/70"
                        }`}
                      >
                        <td className="relative px-4 py-2">
                          {isSelected && (
                            <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-amber" />
                          )}
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

            {selected && (
              <>
                {/* Scrim below xl, where the panel overlays the table. */}
                <div
                  className="absolute inset-0 z-10 bg-abyss/40 xl:hidden"
                  onClick={() => setSelectedKey(null)}
                />
                <PalDetail
                  pal={selected}
                  players={saveSummary.players}
                  displayName={displayName(selected)}
                  onClose={() => setSelectedKey(null)}
                  onViewInDex={requestDex}
                />
              </>
            )}
          </div>
        )
      ) : saveLoading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
          Loading save&hellip;
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="font-display text-lg text-ink-dim">No save loaded</div>
          <p className="max-w-xs text-sm text-ink-faint">
            Load a Palworld save from the sidebar to inspect every owned pal,
            their IV talents, and passives.
          </p>
        </div>
      )}
    </div>
  );
}
