// SOLVE PROGRESS — the in-flight panel that replaces the results area while a
// solve or queue-solve runs. It renders the FROZEN `solve-progress` stream
// (via `useSolve().progress`): the current phase, an animated per-step progress
// bar, humanized pair counts + throughput, a client-ticking elapsed timer, and
// an HONEST remaining estimate for the CURRENT step only (never a total-solve
// ETA — cross-step working-set sizes are unknowable). A danger-outline CANCEL
// calls back into the hook, which resolves the solve quietly to idle.
//
// Design system (UI-DESIGN.md §17): raised/panel surface, single amber accent,
// mono labels — matching the SETUP strip and queue header voice.

import { useEffect, useRef, useState } from "react";
import type { SolveProgressEvent } from "../lib/types";

/** Compact count: 3_600_000 -> "3.6M", 210_000 -> "210k", 840 -> "840". */
function humanCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** Ticking elapsed clock: "0:03", "1:47". */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Short remaining estimate: "8s", "1m20s". */
function formatRemain(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Human phase line, matching the contract's four phases. */
function phaseLabel(p: SolveProgressEvent): string {
  switch (p.phase) {
    case "seeding":
      return "Seeding working set\u2026";
    case "step":
      return `Breeding step ${p.step} of ${p.max_steps}`;
    case "catch_fallback":
      return "Retrying with catching allowed\u2026";
    case "finalizing":
      return "Finalizing plans\u2026";
  }
}

export interface SolveProgressProps {
  /** Latest event for the live generation, or null before the first arrives. */
  progress: SolveProgressEvent | null;
  /** Cancel the in-flight solve/queue (danger-outline button). */
  onCancel: () => void;
  /** Queue target names by index, so queue mode can name the current target. */
  queueTargets?: string[];
}

export function SolveProgress({
  progress,
  onCancel,
  queueTargets,
}: SolveProgressProps) {
  // Elapsed ticks client-side, resyncing to each event's authoritative
  // `elapsed_ms` so the timer stays honest between ~100ms emits.
  const [displayMs, setDisplayMs] = useState(0);
  const syncRef = useRef({ base: 0, at: performance.now() });
  useEffect(() => {
    if (!progress) return;
    syncRef.current = { base: progress.elapsed_ms, at: performance.now() };
    setDisplayMs(progress.elapsed_ms);
  }, [progress]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const { base, at } = syncRef.current;
      setDisplayMs(base + (performance.now() - at));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  // Throughput from event deltas within the SAME step (pairs_done resets each
  // step, so a step boundary just rebaselines — never a negative rate). Smoothed
  // with a light EMA so the readout doesn't jitter.
  const [rate, setRate] = useState(0);
  const rateRef = useRef<{ pairs: number; ms: number; key: string } | null>(null);
  useEffect(() => {
    if (!progress || progress.phase !== "step") {
      rateRef.current = null;
      return;
    }
    const key = `${progress.queue_index ?? 0}:${progress.step}`;
    const prev = rateRef.current;
    if (
      prev &&
      prev.key === key &&
      progress.pairs_done > prev.pairs &&
      progress.elapsed_ms > prev.ms
    ) {
      const inst =
        ((progress.pairs_done - prev.pairs) / (progress.elapsed_ms - prev.ms)) *
        1000;
      setRate((r) => (r > 0 ? r * 0.6 + inst * 0.4 : inst));
    }
    rateRef.current = {
      pairs: progress.pairs_done,
      ms: progress.elapsed_ms,
      key,
    };
  }, [progress]);

  const phase = progress?.phase ?? "seeding";
  const done = progress?.pairs_done ?? 0;
  const total = progress?.pairs_total ?? 0;
  const workingSet = progress?.working_set ?? 0;
  const hasPairs = phase === "step" && total > 0;
  const pct = hasPairs ? Math.min(100, Math.round((done / total) * 100)) : 0;

  // Honest remaining estimate — current step only.
  let remainLabel = "";
  if (hasPairs) {
    if (rate > 0) {
      remainLabel = `~${formatRemain((total - done) / rate)} left in this step`;
    } else {
      remainLabel = "step est.\u2026";
    }
  }

  const isQueue = progress?.kind === "queue";
  const qIndex = progress?.queue_index ?? 0;
  const qLen = progress?.queue_len ?? 0;
  const qName = queueTargets?.[qIndex];

  return (
    <div className="m-6 flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      {isQueue && qLen > 0 && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber">
            Queue
          </span>
          <span className="text-[13px] text-ink-dim">
            Target {qIndex + 1} of {qLen}
            {qName ? ` \u2014 ${qName}` : ""}
          </span>
        </div>
      )}

      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber" />
          <span className="font-display text-base font-semibold tracking-wide text-ink">
            {progress ? phaseLabel(progress) : "Seeding working set\u2026"}
          </span>
        </div>
        <span className="font-mono text-[12px] tabular-nums text-ink-dim">
          {formatClock(displayMs)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="h-2 overflow-hidden rounded-full bg-abyss">
          {hasPairs ? (
            <div
              className="h-full rounded-full bg-amber transition-[width] duration-200 ease-out"
              style={{ width: `${pct}%` }}
            />
          ) : (
            // Seeding / finalizing: no pair batch to measure — indeterminate.
            <div className="h-full w-full animate-pulse rounded-full bg-amber/40" />
          )}
        </div>
        <div className="flex items-center justify-between gap-3 font-mono text-[11px] tabular-nums text-ink-faint">
          <span>
            {hasPairs
              ? `${humanCount(done)} / ${humanCount(total)} pairs${
                  rate > 0 ? ` \u00b7 ${humanCount(rate)} pairs/s` : ""
                }`
              : "\u2014"}
          </span>
          <span className="text-ink-dim">{remainLabel}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          Working set:{" "}
          <span className="tabular-nums text-ink-dim">
            {humanCount(workingSet)}
          </span>
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-bad/50 px-3 py-1 text-[12px] font-medium text-bad transition-colors hover:bg-bad/10"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
