// Live plan tracking: walk a saved breeding plan's node tree, snapshot the
// owned roster when tracking starts, and classify every node against the
// current save so a saved plan checks its steps off automatically as the user
// breeds in-game. Pure functions (no React, no Tauri) so the matching logic is
// deterministic and unit-testable.
//
// Species identity note: a PlanNode carries `species_name` (the DISPLAY name,
// e.g. "Cattiva") while an OwnedPal carries `character_id` (the INTERNAL name,
// e.g. "BadCatgirl"). They are NOT interchangeable. The app bridges the two
// with a `nameToId` map (species display name -> internal id), exactly as
// IvLab's donor pool does. `classifyPlan` therefore requires that map. When a
// node's `species_name` is absent from the map we fail loud: the node is treated
// as unmatchable (a bred node never auto-completes, a wild node counts zero
// owned, a gone owned leaf finds no substitute) rather than silently matching
// the wrong species.

import { hexGuid } from "../components/palbox/selectors";
import type {
  BreedingPlan,
  Gender,
  IvThresholds,
  OwnedPal,
  PlanNode,
} from "./types";

/**
 * Per-plan tracking state, persisted inside a SavedPlan as optional `tracking`.
 * `baseline` freezes the owned roster (hexGuid of every instance) at the moment
 * tracking began, so a bred node can only auto-match a pal that did NOT already
 * exist then. `manualDone`/`manualUndone` are user overrides keyed by node path.
 */
export interface PlanTracking {
  /** epoch-ms when tracking began. */
  startedAt: number;
  /** hexGuid of every owned instance_id present when tracking began. */
  baseline: string[];
  /** nodePaths the user force-marked done. */
  manualDone: string[];
  /** nodePaths the user force-unmarked (override an auto match). */
  manualUndone: string[];
}

/** Status of one plan node against the live save (see `classifyPlan`). */
export type NodeStatus =
  /** Owned leaf whose backing instance is still in the save (or a legacy leaf
   *  with no instance_id — see below). */
  | { kind: "ready" }
  /** Owned leaf whose backing instance is gone from the save; `substitute` is a
   *  same-species/gender stand-in if one is free, else null (drives `stale`). */
  | { kind: "gone"; substitute: OwnedPal | null }
  /** Wild leaf; `ownedCount` = owned pals of the same species (any gender). */
  | { kind: "wild"; ownedCount: number }
  /** Bred node considered done: `matched` is the auto-matched pal if any,
   *  `manual` true when the done state came from a user override. */
  | { kind: "bred-done"; matched: OwnedPal | null; manual: boolean }
  /** Bred node not yet done. */
  | { kind: "bred-pending" };

/** Result of classifying a whole plan against the current save. */
export interface TrackReport {
  /** key = nodePath (Contract item 1: root "r", dot-joined child indices). */
  statuses: Map<string, NodeStatus>;
  /** bred nodes considered done. */
  doneSteps: number;
  /** bred nodes total. */
  totalSteps: number;
  /** any owned leaf gone with no substitute — the plan can no longer be
   *  reproduced exactly from the current save. */
  stale: boolean;
}

/** One walked node with its dot-path (root = "r"). */
export interface WalkedNode {
  path: string;
  node: PlanNode;
}

/**
 * Walk a plan's node tree in pre-order (parent before children), yielding each
 * node with its path. Root is "r"; child `i` of a node at path `P` is `P.i`,
 * walking `node.children` in stored order (Contract item 1).
 */
export function walkPlan(plan: BreedingPlan): WalkedNode[] {
  const out: WalkedNode[] = [];
  const rec = (node: PlanNode, path: string): void => {
    out.push({ path, node });
    node.children.forEach((child, i) => rec(child, `${path}.${i}`));
  };
  rec(plan.root, "r");
  return out;
}

/** Snapshot the current owned roster as a fresh tracking baseline. */
export function newTracking(pals: OwnedPal[]): PlanTracking {
  return {
    startedAt: Date.now(),
    baseline: pals.map((p) => hexGuid(p.instance_id)),
    manualDone: [],
    manualUndone: [],
  };
}

/**
 * Set a node's manual override. `done` true pins the node into `manualDone`;
 * false pins it into `manualUndone`. Either way the path is first removed from
 * both lists so the two never disagree.
 */
export function toggleManual(
  tracking: PlanTracking,
  path: string,
  done: boolean,
): PlanTracking {
  const manualDone = tracking.manualDone.filter((p) => p !== path);
  const manualUndone = tracking.manualUndone.filter((p) => p !== path);
  if (done) manualDone.push(path);
  else manualUndone.push(path);
  return { ...tracking, manualDone, manualUndone };
}

// --- Source discriminators --------------------------------------------------

function isBred(node: PlanNode): boolean {
  return node.source === "Bred";
}

// --- Matching predicates ----------------------------------------------------

/**
 * Same species? A PlanNode names its species by DISPLAY name; an OwnedPal by
 * INTERNAL id. `nameToId` bridges the two; a display name absent from the map
 * resolves to nothing and can never match (fail-loud, never a wrong species).
 */
function sameSpecies(
  node: PlanNode,
  pal: OwnedPal,
  nameToId: Map<string, string>,
): boolean {
  return nameToId.get(node.species_name) === pal.character_id;
}

/**
 * node.passives ⊆ pal.passives. `"(random)"` slots are wildcards (an
 * unspecified inherited passive from `passive_labels`), not real ids, so they
 * are skipped — only the desired passive ids must be present on the pal.
 */
function passivesSubset(nodePassives: string[], palPassives: string[]): boolean {
  const have = new Set(palPassives);
  return nodePassives.every((p) => p === "(random)" || have.has(p));
}

function genderOk(nodeGender: Gender | null, palGender: Gender | null): boolean {
  return nodeGender === null || palGender === nodeGender;
}

function ivFloorOk(pal: OwnedPal, ivFloors: IvThresholds | undefined): boolean {
  if (!ivFloors) return true;
  if (ivFloors.hp > 0 && pal.ivs.hp < ivFloors.hp) return false;
  if (ivFloors.attack > 0 && pal.ivs.attack < ivFloors.attack) return false;
  if (ivFloors.defense > 0 && pal.ivs.defense < ivFloors.defense) return false;
  return true;
}

/**
 * Can `pal` be the bred result of `node`? A bred node auto-matches a pal iff the
 * pal is NOT in the baseline (i.e. bred after tracking began), same species,
 * node.passives ⊆ pal.passives, gender equal when node.gender is non-null, and
 * every IV floor > 0 met.
 */
function bredMatches(
  node: PlanNode,
  pal: OwnedPal,
  baseline: Set<string>,
  ivFloors: IvThresholds | undefined,
  nameToId: Map<string, string>,
): boolean {
  return (
    !baseline.has(hexGuid(pal.instance_id)) &&
    sameSpecies(node, pal, nameToId) &&
    passivesSubset(node.passives, pal.passives) &&
    genderOk(node.gender, pal.gender) &&
    ivFloorOk(pal, ivFloors)
  );
}

/**
 * Can `pal` stand in for a gone owned leaf `node`? Same species + gender,
 * node.passives ⊆ pal.passives, and not the missing instance itself. No
 * baseline restriction: a substitute replaces a lost owned pal, so any owned
 * instance (old or new) is fair game, as long as it is not consumed elsewhere.
 */
function substituteMatches(
  node: PlanNode,
  pal: OwnedPal,
  missingHex: string,
  nameToId: Map<string, string>,
): boolean {
  return (
    hexGuid(pal.instance_id) !== missingHex &&
    sameSpecies(node, pal, nameToId) &&
    genderOk(node.gender, pal.gender) &&
    passivesSubset(node.passives, pal.passives)
  );
}

/**
 * Classify every node of `plan` against the current save.
 *
 * Consumption model (each pal instance is used at most once):
 *  1. Bred nodes are auto-assigned greedily in POST-ORDER (children before
 *     parents), first-fit over pals sorted by hexGuid for stable, deterministic
 *     results. Nodes the user force-unmarked (`manualUndone`) are skipped and
 *     consume nothing. Post-order is obtained by reversing the pre-order walk:
 *     the reverse guarantees every node appears after all its descendants.
 *  2. Substitutes for gone owned leaves are then assigned in walk (pre-order)
 *     order, first-fit over the pals not already consumed in phase 1.
 *
 * Manual overrides win over auto results: `manualUndone` forces bred-pending,
 * `manualDone` forces bred-done (carrying the auto-matched pal as `matched` if
 * one happened to match).
 */
export function classifyPlan(
  plan: BreedingPlan,
  pals: OwnedPal[],
  tracking: PlanTracking,
  ivFloors: IvThresholds | undefined,
  nameToId: Map<string, string>,
): TrackReport {
  const nodes = walkPlan(plan);
  const baseline = new Set(tracking.baseline);
  const manualDone = new Set(tracking.manualDone);
  const manualUndone = new Set(tracking.manualUndone);

  // Deterministic first-fit order.
  const sortedPals = [...pals].sort((a, b) =>
    hexGuid(a.instance_id).localeCompare(hexGuid(b.instance_id)),
  );
  const present = new Map<string, OwnedPal>();
  for (const p of pals) present.set(hexGuid(p.instance_id), p);
  const consumed = new Set<string>();

  // Phase 1: bred auto-assignment, post-order, first-fit.
  const autoMatch = new Map<string, OwnedPal>();
  for (const { path, node } of [...nodes].reverse()) {
    if (!isBred(node) || manualUndone.has(path)) continue;
    for (const pal of sortedPals) {
      const key = hexGuid(pal.instance_id);
      if (consumed.has(key)) continue;
      if (bredMatches(node, pal, baseline, ivFloors, nameToId)) {
        autoMatch.set(path, pal);
        consumed.add(key);
        break;
      }
    }
  }

  // Phase 2: build statuses in pre-order; assign substitutes from remaining pals.
  const statuses = new Map<string, NodeStatus>();
  for (const { path, node } of nodes) {
    const src = node.source;
    if (typeof src === "object" && "Owned" in src) {
      const instId = src.Owned.instance_id;
      if (!instId) {
        // Legacy plan / synthetic queue seed: no instance to track, so it can
        // never go "gone". Treat as ready (species-only, never stale).
        statuses.set(path, { kind: "ready" });
        continue;
      }
      const hex = hexGuid(instId);
      if (present.has(hex)) {
        statuses.set(path, { kind: "ready" });
        continue;
      }
      let substitute: OwnedPal | null = null;
      for (const pal of sortedPals) {
        const key = hexGuid(pal.instance_id);
        if (consumed.has(key)) continue;
        if (substituteMatches(node, pal, hex, nameToId)) {
          substitute = pal;
          consumed.add(key);
          break;
        }
      }
      statuses.set(path, { kind: "gone", substitute });
    } else if (typeof src === "object" && "Wild" in src) {
      const ownedCount = pals.filter((p) => sameSpecies(node, p, nameToId)).length;
      statuses.set(path, { kind: "wild", ownedCount });
    } else {
      // Bred.
      if (manualUndone.has(path)) {
        statuses.set(path, { kind: "bred-pending" });
      } else if (manualDone.has(path)) {
        statuses.set(path, {
          kind: "bred-done",
          matched: autoMatch.get(path) ?? null,
          manual: true,
        });
      } else if (autoMatch.has(path)) {
        statuses.set(path, {
          kind: "bred-done",
          matched: autoMatch.get(path) ?? null,
          manual: false,
        });
      } else {
        statuses.set(path, { kind: "bred-pending" });
      }
    }
  }

  let doneSteps = 0;
  let totalSteps = 0;
  let stale = false;
  for (const { path, node } of nodes) {
    const status = statuses.get(path);
    if (isBred(node)) {
      totalSteps += 1;
      if (status?.kind === "bred-done") doneSteps += 1;
    }
    if (status?.kind === "gone" && status.substitute === null) stale = true;
  }

  return { statuses, doneSteps, totalSteps, stale };
}
