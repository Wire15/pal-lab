import { useMemo, useState } from "react";
import type { SpeciesEntry } from "../../lib/types";
import { DexTabs, type DexTab } from "../../components/dex-tabs";
import { PartnerIcon } from "../../components/partner";
import { PartnerSkillDescription, partnerLevels } from "../../components/partner-value";

/** Lowercase search haystack: partner-skill name + species name + description. */
function haystack(s: SpeciesEntry): string {
  return [s.partner_skill ?? "", s.name, s.partner_skill_desc ?? ""]
    .join(" ")
    .toLowerCase();
}

/** One partner skill as a paldb-style card, mirroring the PassiveCard idiom: the
 *  partner glyph + skill name over the species cross-link and the per-rank
 *  description (Lv1..LvN progression via the shared template tokens). */
function PartnerCard({
  s,
  onSelect,
}: {
  s: SpeciesEntry;
  onSelect: (id: string) => void;
}) {
  const levels = partnerLevels(s);
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-line bg-panel">
      <header className="flex min-h-[38px] items-start gap-2.5 border-b border-line px-3.5 py-2">
        <PartnerIcon iconId={s.partner_skill_icon} size={26} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[14px] font-semibold tracking-wide text-amber-bright">
            {s.partner_skill}
          </div>
          <button
            onClick={() => onSelect(s.id)}
            className="group mt-0.5 flex items-baseline gap-1.5 text-left"
          >
            <span className="truncate text-[12px] text-ink-dim transition-colors group-hover:text-ink">
              {s.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-amber">
              #{String(s.paldex_no).padStart(3, "0")}
            </span>
          </button>
        </div>
      </header>
      <div className="flex flex-1 flex-col px-3 py-2.5">
        {levels ? (
          <PartnerSkillDescription
            template={levels.template}
            values={levels.values}
            className="text-[12px] leading-relaxed text-ink-dim"
          />
        ) : s.partner_skill_desc ? (
          <p className="whitespace-pre-line text-[12px] leading-relaxed text-ink-dim">
            {s.partner_skill_desc}
          </p>
        ) : (
          <div className="text-[12px] italic leading-snug text-ink-faint">
            No description
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Paldb-style partner-skill browser. One card per species that carries a partner
 * skill (the pack ships a name for every species, but ~130 DLC species have
 * none), sorted by paldex number, with a name/species/effect search and a reset.
 * Each card cross-links to the species detail; per-rank values render via the
 * shared partner-skill template tokens (Lv1 value + hover progression).
 */
export default function PartnerIndex({
  species,
  tab,
  onTab,
  onSelectPal,
}: {
  species: SpeciesEntry[];
  tab: DexTab;
  onTab: (t: DexTab) => void;
  onSelectPal: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  // Only species with a partner skill, in paldex order (then name for ties).
  const withPartner = useMemo(
    () =>
      species
        .filter((s) => s.partner_skill)
        .sort((a, b) => a.paldex_no - b.paldex_no || a.name.localeCompare(b.name)),
    [species],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return withPartner;
    return withPartner.filter((s) => haystack(s).includes(q));
  }, [withPartner, query]);

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
                Partner skills
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
            <span className={query.trim() ? "" : "text-ink"}>{withPartner.length}</span> partner
            skills
            <span className="mx-1 text-ink-faint">/</span>
            <span className="text-ink-dim">{species.length}</span> species
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-amber/60"
            placeholder="Search by skill, species, or effect..."
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
            {species.length === 0 ? "Loading partner skills\u2026" : "No partner skills match"}
          </div>
          {species.length > 0 && (
            <p className="max-w-xs text-sm text-ink-faint">
              Nothing matches &ldquo;{query}&rdquo;. Try a different name or effect.
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="mx-auto grid w-full max-w-[1160px] grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((s) => (
              <PartnerCard key={s.id} s={s} onSelect={onSelectPal} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
