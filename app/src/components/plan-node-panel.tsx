// The Solver graph's node inspector: a right-side detail panel the graph view
// mounts when a pal node is clicked. It reads ONLY what a plan node carries
// (see PlanNode in lib/types.ts) — the solver payload has no IVs, level,
// owner, or instance id, so an Owned node shows its location + passives, a
// Bred node its breeding odds/time + passives (incl. the "(random)" roll
// slot), and a Wild node its catch count + minimum level. Chassis mirrors the
// pal-dex detail panel (raised bg, mono eyebrow header, Section blocks) so the
// app reads as one surface; portrait, gender glyph, passive strips, and the
// hover card are all reused primitives, no new tokens.
//
// CONTRACT FILE: GraphView imports { PlanNodePanel, PlanNodeSelection } from
// here and consumes the selection shape verbatim. This file owns the panel and
// the selection type; it never touches Solver.tsx or plan-graph.tsx.

import { useEffect, useRef } from "react";
import type { Gender, PlanSource } from "../lib/types";
import { formatDuration, genderView, probBand } from "../lib/ui";
import { PalIcon, Tag } from "./primitives";
import { PassiveStrip } from "./passive-strip";
import { PalHoverCard } from "./pal-hover-card";

/** The random-roll sentinel a plan node uses for an unpinned passive slot. */
const RANDOM_PASSIVE = "(random)";

/**
 * A single clicked plan-tree node, flattened from `PlanNode` for the panel.
 * `species` is the RESOLVED internal species id (list_species id) used for the
 * portrait and dex navigation — NOT the numeric `species` field of the raw
 * payload; it is null when the id could not be resolved. Everything else is
 * lifted straight off the node. `probability`/`estTimeSecs` are only
 * meaningful for Bred nodes (leaves report 1.0 / 0).
 */
export type PlanNodeSelection = {
  species: string | null;
  speciesName: string;
  source: PlanSource;
  gender: Gender | null;
  planIndex: number;
  passives: string[];
  probability: number;
  estTimeSecs: number;
};

/** Narrow the externally-tagged source to its variant payloads. */
function readSource(source: PlanSource): {
  kind: "bred" | "owned" | "wild";
  location: string | null;
  captures: number;
  minWildLevel: number;
} {
  if (source === "Bred")
    return { kind: "bred", location: null, captures: 0, minWildLevel: 0 };
  if ("Owned" in source)
    return { kind: "owned", location: source.Owned.location, captures: 0, minWildLevel: 0 };
  return {
    kind: "wild",
    location: null,
    captures: source.Wild.captures,
    minWildLevel: source.Wild.min_wild_level,
  };
}

/** A panel block with a mono eyebrow header (mirrors the pal-dex detail Section). */
function Section({
  eyebrow,
  right,
  children,
}: {
  eyebrow: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-panel/40">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-raised px-3.5 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-dim">
          {eyebrow}
        </span>
        {right}
      </header>
      <div className="p-3.5">{children}</div>
    </section>
  );
}

/** A labelled provenance row: mono faint label left, value right. */
function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[13px] text-ink">{children}</dd>
    </div>
  );
}

/** Passive strips laid out one-per-row; the "(random)" slot renders as the
 *  neutral "random roll" strip like the list renderer. Empty → a quiet note. */
function Passives({ passives }: { passives: string[] }) {
  if (passives.length === 0)
    return <p className="text-[12px] leading-relaxed text-ink-faint">No passives carried.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {passives.map((p, i) => (
        <PassiveStrip key={`${p}-${i}`} id={p} size="sm" />
      ))}
    </div>
  );
}

/**
 * The Solver graph's node inspector. The parent (GraphView) mounts this only
 * when a node is selected, so `selection` is always present; `onClose` clears
 * the selection (the parent also wires Escape) and `onNavigateDex` jumps to the
 * pal-dex. Own scroll container so long passive lists never clip.
 */
export function PlanNodePanel({
  selection,
  onClose,
  onNavigateDex,
}: {
  selection: PlanNodeSelection;
  onClose: () => void;
  onNavigateDex: (speciesId: string, instanceId?: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { species, speciesName, gender, planIndex, passives, probability, estTimeSecs } =
    selection;
  const src = readSource(selection.source);
  const g = genderView(gender);
  const prob = probBand(probability);
  const hasRandomRoll = passives.includes(RANDOM_PASSIVE);

  // Move focus into the panel on open / when the selected node changes, so the
  // keyboard path lands somewhere actionable (matches the app's panel a11y).
  useEffect(() => {
    closeRef.current?.focus();
  }, [species, speciesName, planIndex]);

  const eyebrow =
    src.kind === "bred"
      ? `Plan ${planIndex + 1} \u00b7 bred node`
      : src.kind === "wild"
        ? `Plan ${planIndex + 1} \u00b7 wild node`
        : `Plan ${planIndex + 1} \u00b7 owned node`;

  const kindChip =
    src.kind === "bred" ? (
      <Tag tone="amber">Bred</Tag>
    ) : src.kind === "wild" ? (
      <span
        className="rounded-sm border border-el-leaf/50 bg-el-leaf/12 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wider text-el-leaf"
        title="Catch this pal in the wild"
      >
        Catch{src.captures > 1 ? `\u00a0\u00d7${src.captures}` : ""}
      </span>
    ) : (
      <Tag>Owned</Tag>
    );

  const portrait = (
    <PalIcon id={species} name={speciesName} size={56} />
  );

  return (
    <aside
      role="dialog"
      aria-label={`${speciesName} plan node detail`}
      className="flex h-full w-[340px] shrink-0 flex-col border-l border-line bg-panel"
    >
      {/* eyebrow header + close */}
      <header className="flex items-center justify-between gap-3 border-b border-line bg-raised px-4 py-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-amber">
          {eyebrow}
        </span>
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close node detail"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line text-ink-faint transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/60"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      {/* scrollable body */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* identity */}
        <div className="flex items-center gap-3">
          {species ? (
            <PalHoverCard speciesId={species}>
              <button
                onClick={() => onNavigateDex(species)}
                className="shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/60"
                aria-label={`Open ${speciesName} in the Pal-dex`}
              >
                {portrait}
              </button>
            </PalHoverCard>
          ) : (
            portrait
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-display text-lg font-bold tracking-wide text-ink">
                {speciesName}
              </h2>
              <span className={`text-base leading-none ${g.className}`} title={g.label}>
                {g.glyph}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">{kindChip}</div>
          </div>
        </div>

        {/* per-kind content */}
        {src.kind === "bred" && (
          <Section
            eyebrow="Breeding step"
            right={
              <span
                className={`rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${prob.text} ${prob.ring}`}
                title={`${prob.label} odds`}
              >
                {(probability * 100).toFixed(0)}%
              </span>
            }
          >
            <dl className="flex flex-col gap-2">
              <FactRow label="Odds">
                <span className={prob.text}>{prob.label}</span>
                <span className="ml-1.5 font-mono tabular-nums text-ink-dim">
                  {(probability * 100).toFixed(0)}%
                </span>
              </FactRow>
              <FactRow label="Est. time">
                <span className="font-mono tabular-nums">{formatDuration(estTimeSecs)}</span>
              </FactRow>
            </dl>
          </Section>
        )}

        {src.kind === "owned" && (
          <Section eyebrow="Owned pal">
            <dl className="flex flex-col gap-2">
              <FactRow label="Location">{src.location ?? "\u2014"}</FactRow>
              <FactRow label="Ready">
                <span className="text-good">{"In your box \u2014 no breeding"}</span>
              </FactRow>
            </dl>
          </Section>
        )}

        {src.kind === "wild" && (
          <Section
            eyebrow="Wild capture"
            right={
              src.minWildLevel ? (
                <span
                  className="rounded-sm border border-el-leaf/35 bg-el-leaf/[0.08] px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none tabular-nums text-el-leaf"
                  title={`Wild spawns from level ${src.minWildLevel}`}
                >
                  Lv {src.minWildLevel}+
                </span>
              ) : undefined
            }
          >
            <dl className="flex flex-col gap-2">
              <FactRow label="Catches">
                <span className="font-mono tabular-nums text-el-leaf">
                  {"\u00d7"}
                  {src.captures}
                </span>
              </FactRow>
              {src.minWildLevel ? (
                <FactRow label="Min level">
                  <span className="font-mono tabular-nums text-el-leaf">{src.minWildLevel}</span>
                </FactRow>
              ) : null}
            </dl>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
              {src.minWildLevel
                ? `Catch in the wild at level ${src.minWildLevel} or higher.`
                : "Catch this pal in the wild."}
            </p>
          </Section>
        )}

        {/* passives (all kinds carry them) */}
        <Section eyebrow="Passives">
          <Passives passives={passives} />
          {hasRandomRoll && (
            <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
              One passive slot rolls at random each time this pair breeds.
            </p>
          )}
        </Section>

        {/* dex action — only when the species id resolved */}
        {species && (
          <button
            onClick={() => onNavigateDex(species)}
            className="mt-auto flex items-center justify-center gap-1.5 rounded-md border border-line bg-raised px-3 py-2 text-[13px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/60"
          >
            View in Pal-dex
            <span aria-hidden>{"\u2192"}</span>
          </button>
        )}
      </div>
    </aside>
  );
}
