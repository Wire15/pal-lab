// PIN PARENTS (Solver form) — pin specific owned instances the solver MUST use
// as leaves in every returned plan. A compact "Pin a parent…" affordance opens
// an anchored popover listing owned instances (searchable by name / nickname /
// species); clicking a row pins that exact `instance_id`. Pinned instances
// render as removable chips below. The selected value is the frozen
// `Guid[]` (each a 16-byte `instance_id` array) the Solver passes verbatim as
// `SolveRequest.pinned_parents` — this component never reshapes it.
//
// Cap: 4 pins. A breeding pair is a binary tree; asking for more pinned leaves
// than a small plan can hold is nonsense, so the affordance disables at cap.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Guid, OwnedPal } from "../lib/types";
import { genderView, ivBand, QUALITY_TEXT } from "../lib/ui";
import { hexGuid } from "./palbox/selectors";
import { PalIcon } from "./primitives";

/** Hard cap on pinned parents (solver pairs are binary trees). */
export const MAX_PINS = 4;

/** One selectable owned-instance row in the popover. */
function PalRow({
  pal,
  speciesName,
  disabled,
  onPick,
}: {
  pal: OwnedPal;
  speciesName: string;
  disabled: boolean;
  onPick: () => void;
}) {
  const g = genderView(pal.gender);
  const nick = pal.nickname?.trim();
  const ivs = [pal.ivs.hp, pal.ivs.attack, pal.ivs.defense];
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      <PalIcon id={pal.character_id} name={speciesName} size={26} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span
            className={`truncate text-[13px] ${nick ? "italic text-ink" : "text-ink"}`}
            title={nick ? `${nick} · ${speciesName}` : speciesName}
          >
            {nick || speciesName}
          </span>
          <span className={`text-[13px] leading-none ${g.className}`} title={g.label}>
            {g.glyph}
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-ink-faint">
          <span className="tabular-nums">Lv {pal.level}</span>
          <span className="flex items-center gap-1 tabular-nums" title="IVs: HP / Atk / Def">
            {ivs.map((v, i) => (
              <span key={i} className={QUALITY_TEXT[ivBand(v)]}>
                {v}
              </span>
            ))}
          </span>
          <span className="tabular-nums" title="Passive count">
            {pal.passives.length}p
          </span>
        </div>
      </div>
    </button>
  );
}

/** One pinned-instance chip (icon + name + Lv + remove). */
function PinChip({
  pal,
  speciesName,
  onRemove,
}: {
  pal: OwnedPal;
  speciesName: string;
  onRemove: () => void;
}) {
  const nick = pal.nickname?.trim();
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-amber/40 bg-amber/10 py-0.5 pl-1 pr-1.5 text-[11px] text-amber">
      <PalIcon id={pal.character_id} name={speciesName} size={16} />
      <span className={`max-w-[9rem] truncate font-medium ${nick ? "italic" : ""}`}>
        {nick || speciesName}
      </span>
      <span className="font-mono tabular-nums text-amber/80">Lv {pal.level}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="-mr-0.5 rounded-sm px-0.5 leading-none text-amber/70 transition-colors hover:bg-amber/20 hover:text-amber-bright"
      >
        &times;
      </button>
    </span>
  );
}

export interface PinPickerProps {
  /** All owned pals from the loaded save (`saveSummary.pals`). */
  pals: OwnedPal[];
  /** Internal species id -> localized name, for row/chip labels + search. */
  idToName: Map<string, string>;
  /** Currently pinned instance ids (verbatim `OwnedPal.instance_id` arrays). */
  pins: Guid[];
  /** Add a pin by its instance id. */
  onAdd: (id: Guid) => void;
  /** Remove a pin by its instance id. */
  onRemove: (id: Guid) => void;
}

export function PinPicker({ pals, idToName, pins, onAdd, onRemove }: PinPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const pinnedHex = useMemo(() => new Set(pins.map(hexGuid)), [pins]);
  const atCap = pins.length >= MAX_PINS;

  // Owned pals, pinnable ones first-matched by name/nickname/species.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pals.filter((p) => {
      if (p.is_human) return false;
      if (!q) return true;
      const species = (idToName.get(p.character_id) ?? p.character_id).toLowerCase();
      const nick = (p.nickname ?? "").toLowerCase();
      return species.includes(q) || nick.includes(q);
    });
  }, [pals, idToName, query]);

  // The pinned pals, resolved back to their OwnedPal for the chip row (an id
  // with no matching instance — e.g. after a save switch — is silently dropped).
  const pinnedPals = useMemo(() => {
    const byHex = new Map(pals.map((p) => [hexGuid(p.instance_id), p]));
    return pins
      .map((id) => byHex.get(hexGuid(id)))
      .filter((p): p is OwnedPal => p != null);
  }, [pals, pins]);

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
        Pin parents
      </span>

      <div ref={wrapRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={atCap}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="flex w-full items-center gap-2 rounded-md border border-line bg-abyss px-2.5 py-1.5 text-left text-[12px] text-ink-dim transition-colors enabled:hover:border-amber/60 enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-ink-faint">+</span>
          {atCap ? `Max ${MAX_PINS} pins` : "Pin a parent\u2026"}
        </button>

        {open && (
          <div
            role="dialog"
            aria-label="Pin a parent"
            className="absolute left-0 right-0 top-full z-20 mt-1 flex max-h-72 flex-col overflow-hidden rounded-md border border-line bg-panel shadow-lg shadow-abyss/50"
          >
            <div className="border-b border-line-soft p-1.5">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder={"Search name, nickname, species\u2026"}
                className="w-full rounded-md border border-line bg-abyss px-2 py-1 text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/60 focus:outline-none"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              {matches.length === 0 ? (
                <div className="px-2 py-3 text-center text-[12px] text-ink-faint">
                  {pals.length === 0
                    ? "No owned pals in this save."
                    : "No pals match that search."}
                </div>
              ) : (
                matches.map((p) => {
                  const hex = hexGuid(p.instance_id);
                  const pinned = pinnedHex.has(hex);
                  return (
                    <PalRow
                      key={hex}
                      pal={p}
                      speciesName={idToName.get(p.character_id) ?? p.character_id}
                      disabled={pinned || atCap}
                      onPick={() => onAdd(p.instance_id)}
                    />
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {pinnedPals.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pinnedPals.map((p) => (
            <PinChip
              key={hexGuid(p.instance_id)}
              pal={p}
              speciesName={idToName.get(p.character_id) ?? p.character_id}
              onRemove={() => onRemove(p.instance_id)}
            />
          ))}
        </div>
      )}
      {atCap && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Pin cap reached &mdash; remove one to pin a different parent.
        </p>
      )}
    </div>
  );
}
