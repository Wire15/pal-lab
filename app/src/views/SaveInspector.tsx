import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { OwnedPal, SaveSummary } from "../lib/types";

type SortKey =
  | "character_id"
  | "nickname"
  | "gender"
  | "level"
  | "is_boss"
  | "hp"
  | "attack"
  | "defense"
  | "container_kind";

type SortDir = "asc" | "desc";

function sortValue(pal: OwnedPal, key: SortKey): string | number {
  switch (key) {
    case "character_id":
      return pal.character_id.toLowerCase();
    case "nickname":
      return (pal.nickname ?? "").toLowerCase();
    case "gender":
      return pal.gender ?? "";
    case "level":
      return pal.level;
    case "is_boss":
      return pal.is_boss ? 1 : 0;
    case "hp":
      return pal.ivs.hp;
    case "attack":
      return pal.ivs.attack;
    case "defense":
      return pal.ivs.defense;
    case "container_kind":
      return pal.container_kind;
  }
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "character_id", label: "Species" },
  { key: "nickname", label: "Nickname" },
  { key: "gender", label: "Gender" },
  { key: "level", label: "Level" },
  { key: "is_boss", label: "Boss" },
  { key: "hp", label: "HP" },
  { key: "attack", label: "ATK" },
  { key: "defense", label: "DEF" },
  { key: "container_kind", label: "Container" },
];

export default function SaveInspector() {
  const [saveDir, setSaveDir] = useState("");
  const [summary, setSummary] = useState<SaveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("character_id");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sortedPals = useMemo(() => {
    if (!summary) return [];
    const pals = [...summary.pals];
    pals.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return pals;
  }, [summary, sortKey, sortDir]);

  return (
    <div className="flex flex-col gap-4 p-6">
      <h2 className="text-xl font-semibold">Save Inspector</h2>

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
        <button
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Loading..." : "Load"}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {summary && (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-gray-600">
            <span className="font-medium">{summary.world_name}</span>
            {" - "}
            {summary.players.map((p) => p.name).join(", ") || "no players"}
            {" - "}
            {summary.pals.length} pals
            {summary.warnings.length > 0 && (
              <span
                className="ml-2 text-amber-600"
                title={summary.warnings.slice(0, 20).join("\n")}
              >
                ({summary.warnings.length} warnings)
              </span>
            )}
          </div>

          <div className="overflow-auto rounded border border-gray-200">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-gray-50 text-left">
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      className="cursor-pointer select-none px-3 py-2 font-medium hover:bg-gray-100"
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}
                      {sortKey === c.key ? (sortDir === "asc" ? " ^" : " v") : ""}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-medium">Passives</th>
                </tr>
              </thead>
              <tbody>
                {sortedPals.map((pal) => (
                  <tr
                    key={pal.instance_id.join("-")}
                    className="border-t border-gray-100"
                  >
                    <td className="px-3 py-2">{pal.character_id}</td>
                    <td className="px-3 py-2 text-gray-500">
                      {pal.nickname ?? "-"}
                    </td>
                    <td className="px-3 py-2">{pal.gender ?? "-"}</td>
                    <td className="px-3 py-2">{pal.level}</td>
                    <td className="px-3 py-2">
                      {pal.is_boss && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                          BOSS
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{pal.ivs.hp}</td>
                    <td className="px-3 py-2 tabular-nums">{pal.ivs.attack}</td>
                    <td className="px-3 py-2 tabular-nums">{pal.ivs.defense}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {pal.container_kind}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {pal.passives.map((p) => (
                          <span
                            key={p}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!summary && !error && (
        <p className="text-sm text-gray-500">
          Pick a save folder and load it to inspect owned pals.
        </p>
      )}
    </div>
  );
}
