// Unit tests for the live plan-tracking classifier. Run with `bun test`. The
// `bun:test` import type-resolves via the ambient app/src/bun-test.d.ts shim
// (there is no @types/bun in this project).
import { expect, test } from "bun:test";

import { hexGuid } from "../components/palbox/selectors";
import {
  classifyPlan,
  newTracking,
  toggleManual,
  walkPlan,
  type NodeStatus,
  type TrackReport,
} from "./plan-tracking";
import type {
  BreedingPlan,
  IvThresholds,
  OwnedPal,
  PlanNode,
} from "./types";

// --- Fixtures ---------------------------------------------------------------

/** 16-byte guid whose first byte is `n` (distinct hexGuid per n < 256). */
const guid = (n: number): number[] => [n, ...new Array(15).fill(0)];

function mkPal(
  over: Partial<OwnedPal> & { instance_id: number[]; character_id: string },
): OwnedPal {
  return {
    is_boss: false,
    is_lucky: false,
    is_human: false,
    gender: "Male",
    level: 1,
    rank: 0,
    passives: [],
    active_skills: [],
    ivs: { hp: 0, attack: 0, defense: 0 },
    nickname: null,
    owner_player_uid: null,
    container_id: null,
    slot_index: null,
    container_kind: "Palbox",
    ...over,
  };
}

function mkNode(over: Partial<PlanNode> & { species_name: string }): PlanNode {
  return {
    species: 0,
    gender: null,
    passives: [],
    source: "Bred",
    probability: 1,
    est_time_secs: 0,
    children: [],
    ...over,
  };
}

// species DISPLAY name -> INTERNAL id (character_id), mirroring the app's
// nameToId. "Cattiva" is deliberately renamed to "BadCatgirl" to prove the
// classifier never falls back to a display==internal shortcut.
const nameToId = new Map<string, string>([
  ["Cattiva", "BadCatgirl"],
  ["Lamball", "Lamball"],
  ["Foxparks", "Foxparks"],
  ["Chikipi", "Chikipi"],
  ["Pengullet", "PenguinPal"],
]);

// Baseline roster present when tracking begins.
const pengA = mkPal({ instance_id: guid(1), character_id: "PenguinPal", gender: "Female" });
const foxB = mkPal({ instance_id: guid(2), character_id: "Foxparks" });
const chik = mkPal({ instance_id: guid(3), character_id: "Chikipi" });
const base: OwnedPal[] = [pengA, foxB, chik];

// 5-node plan: root(bred Cattiva) -> [ bredChild(bred Lamball) -> [ownedB Foxparks, wildC Chikipi], ownedA Pengullet ]
// Paths: r (bred), r.0 (bred), r.0.0 (owned), r.0.1 (wild), r.1 (owned).
function buildPlan(): BreedingPlan {
  const ownedA = mkNode({
    species_name: "Pengullet",
    gender: "Female",
    source: { Owned: { location: "Palbox", instance_id: guid(1) } },
  });
  const ownedB = mkNode({
    species_name: "Foxparks",
    source: { Owned: { location: "Palbox", instance_id: guid(2) } },
  });
  const wildC = mkNode({
    species_name: "Chikipi",
    source: { Wild: { captures: 1, min_wild_level: 3 } },
  });
  const bredChild = mkNode({
    species_name: "Lamball",
    gender: "Female",
    passives: ["Runner"],
    source: "Bred",
    children: [ownedB, wildC],
  });
  const root = mkNode({
    species_name: "Cattiva",
    passives: ["Swift"],
    source: "Bred",
    children: [bredChild, ownedA],
  });
  return {
    root,
    total_time_secs: 0,
    total_steps: 2,
    total_wild_pals: 1,
    cake: "Normal",
    cake_count: 0,
  };
}

const plan = buildPlan();

// Typed accessors for the discriminated NodeStatus union.
type WildStatus = Extract<NodeStatus, { kind: "wild" }>;
type GoneStatus = Extract<NodeStatus, { kind: "gone" }>;
type BredDoneStatus = Extract<NodeStatus, { kind: "bred-done" }>;

function statusAt(report: TrackReport, path: string): NodeStatus {
  const status = report.statuses.get(path);
  if (!status) throw new Error(`no status at ${path}`);
  return status;
}

// --- Tests ------------------------------------------------------------------

test("walkPlan enumerates every node in pre-order with dot paths", () => {
  expect(walkPlan(plan).map((w) => w.path)).toEqual([
    "r",
    "r.0",
    "r.0.0",
    "r.0.1",
    "r.1",
  ]);
});

test("newTracking snapshots the baseline via hexGuid", () => {
  const t = newTracking(base);
  expect(t.baseline).toEqual([hexGuid(guid(1)), hexGuid(guid(2)), hexGuid(guid(3))]);
  expect(t.manualDone).toEqual([]);
  expect(t.manualUndone).toEqual([]);
});

test("toggleManual moves a path between manualDone and manualUndone", () => {
  const t1 = toggleManual(newTracking(base), "r", true);
  expect(t1.manualDone).toEqual(["r"]);
  expect(t1.manualUndone).toEqual([]);
  const t2 = toggleManual(t1, "r", false);
  expect(t2.manualDone).toEqual([]);
  expect(t2.manualUndone).toEqual(["r"]);
});

test("fresh tracking: owned leaves ready, wild counts, bred pending", () => {
  const r = classifyPlan(plan, base, newTracking(base), undefined, nameToId);
  expect(statusAt(r, "r.1").kind).toBe("ready");
  expect(statusAt(r, "r.0.0").kind).toBe("ready");
  const wild = statusAt(r, "r.0.1");
  expect(wild.kind).toBe("wild");
  expect((wild as WildStatus).ownedCount).toBe(1);
  expect(statusAt(r, "r.0").kind).toBe("bred-pending");
  expect(statusAt(r, "r").kind).toBe("bred-pending");
  expect(r.doneSteps).toBe(0);
  expect(r.totalSteps).toBe(2);
  expect(r.stale).toBe(false);
});

test("auto-match excludes baseline ids, accepts newly-bred ones", () => {
  const oldCat = mkPal({ instance_id: guid(4), character_id: "BadCatgirl", passives: ["Swift"] });
  const roster = [...base, oldCat];
  const t = newTracking(roster); // guid(4) is in the baseline
  const before = classifyPlan(plan, roster, t, undefined, nameToId);
  expect(statusAt(before, "r").kind).toBe("bred-pending");

  const newCat = mkPal({ instance_id: guid(5), character_id: "BadCatgirl", passives: ["Swift"] });
  const after = classifyPlan(plan, [...roster, newCat], t, undefined, nameToId);
  const root = statusAt(after, "r");
  expect(root.kind).toBe("bred-done");
  expect((root as BredDoneStatus).manual).toBe(false);
  expect((root as BredDoneStatus).matched?.instance_id).toEqual(guid(5));
});

test("bred match requires node.passives to be a subset of the pal's", () => {
  const t = newTracking(base);
  const wrong = mkPal({ instance_id: guid(6), character_id: "Lamball", gender: "Female", passives: ["Swift"] });
  expect(statusAt(classifyPlan(plan, [...base, wrong], t, undefined, nameToId), "r.0").kind).toBe(
    "bred-pending",
  );
  const superset = mkPal({ instance_id: guid(7), character_id: "Lamball", gender: "Female", passives: ["Runner", "Swift"] });
  expect(statusAt(classifyPlan(plan, [...base, superset], t, undefined, nameToId), "r.0").kind).toBe(
    "bred-done",
  );
});

test("bred match enforces gender when the node gender is non-null", () => {
  const t = newTracking(base);
  const male = mkPal({ instance_id: guid(8), character_id: "Lamball", gender: "Male", passives: ["Runner"] });
  expect(statusAt(classifyPlan(plan, [...base, male], t, undefined, nameToId), "r.0").kind).toBe(
    "bred-pending",
  );
  const female = mkPal({ instance_id: guid(9), character_id: "Lamball", gender: "Female", passives: ["Runner"] });
  expect(statusAt(classifyPlan(plan, [...base, female], t, undefined, nameToId), "r.0").kind).toBe(
    "bred-done",
  );
});

test("bred match gates on IV floors only where the floor is > 0", () => {
  const t = newTracking(base);
  const floors: IvThresholds = { hp: 50, attack: 0, defense: 0 };
  const lowIv = mkPal({ instance_id: guid(10), character_id: "Lamball", gender: "Female", passives: ["Runner"], ivs: { hp: 40, attack: 0, defense: 0 } });
  expect(statusAt(classifyPlan(plan, [...base, lowIv], t, floors, nameToId), "r.0").kind).toBe(
    "bred-pending",
  );
  const okIv = mkPal({ instance_id: guid(11), character_id: "Lamball", gender: "Female", passives: ["Runner"], ivs: { hp: 60, attack: 0, defense: 0 } });
  expect(statusAt(classifyPlan(plan, [...base, okIv], t, floors, nameToId), "r.0").kind).toBe(
    "bred-done",
  );
  // Same low-IV pal matches once the floor is lifted.
  expect(statusAt(classifyPlan(plan, [...base, lowIv], t, undefined, nameToId), "r.0").kind).toBe(
    "bred-done",
  );
});

test("one pal cannot satisfy two nodes; post-order gives it to the child", () => {
  const leaf = mkNode({ species_name: "Foxparks", source: { Owned: { location: "Palbox", instance_id: guid(2) } } });
  const mid = mkNode({ species_name: "Cattiva", passives: ["Swift"], source: "Bred", children: [leaf] });
  const rt = mkNode({ species_name: "Cattiva", passives: ["Swift"], source: "Bred", children: [mid] });
  const miniPlan: BreedingPlan = { root: rt, total_time_secs: 0, total_steps: 2, total_wild_pals: 0, cake: "Normal", cake_count: 0 };
  const one = mkPal({ instance_id: guid(12), character_id: "BadCatgirl", passives: ["Swift"] });
  const r = classifyPlan(miniPlan, [foxB, one], newTracking([foxB]), undefined, nameToId);
  expect(statusAt(r, "r.0").kind).toBe("bred-done");
  expect(statusAt(r, "r").kind).toBe("bred-pending");
  expect(r.doneSteps).toBe(1);
  expect(r.totalSteps).toBe(2);
});

test("manualDone forces done; manualUndone overrides an auto match", () => {
  // Force-done with no matching pal: done, manual, no matched instance.
  const done = classifyPlan(plan, base, toggleManual(newTracking(base), "r", true), undefined, nameToId);
  const root = statusAt(done, "r");
  expect(root.kind).toBe("bred-done");
  expect((root as BredDoneStatus).manual).toBe(true);
  expect((root as BredDoneStatus).matched).toBeNull();
  expect(done.doneSteps).toBe(1);

  // A pal that WOULD auto-match r.0, but the user force-unmarked it.
  const female = mkPal({ instance_id: guid(9), character_id: "Lamball", gender: "Female", passives: ["Runner"] });
  const undo = toggleManual(newTracking(base), "r.0", false);
  const r = classifyPlan(plan, [...base, female], undo, undefined, nameToId);
  expect(statusAt(r, "r.0").kind).toBe("bred-pending");
  expect(r.doneSteps).toBe(0);
});

test("gone owned leaf finds a same-species/gender substitute", () => {
  const t = newTracking(base); // baseline still records guid(1)
  const subF = mkPal({ instance_id: guid(13), character_id: "PenguinPal", gender: "Female" });
  const r = classifyPlan(plan, [foxB, chik, subF], t, undefined, nameToId); // pengA removed
  const gone = statusAt(r, "r.1");
  expect(gone.kind).toBe("gone");
  expect((gone as GoneStatus).substitute?.instance_id).toEqual(guid(13));
  expect(r.stale).toBe(false);
});

test("gone owned leaf with no valid substitute drives stale", () => {
  const t = newTracking(base);
  // No PenguinPal at all -> no substitute -> stale.
  const none = classifyPlan(plan, [foxB, chik], t, undefined, nameToId);
  expect((statusAt(none, "r.1") as GoneStatus).substitute).toBeNull();
  expect(none.stale).toBe(true);
  // A wrong-gender PenguinPal is not a valid substitute (node gender Female).
  const male = mkPal({ instance_id: guid(14), character_id: "PenguinPal", gender: "Male" });
  const stillGone = classifyPlan(plan, [foxB, chik, male], t, undefined, nameToId);
  expect((statusAt(stillGone, "r.1") as GoneStatus).substitute).toBeNull();
  expect(stillGone.stale).toBe(true);
});

test("doneSteps/totalSteps count every bred node done", () => {
  const t = newTracking(base);
  const newCat = mkPal({ instance_id: guid(5), character_id: "BadCatgirl", passives: ["Swift"] });
  const female = mkPal({ instance_id: guid(9), character_id: "Lamball", gender: "Female", passives: ["Runner"] });
  const r = classifyPlan(plan, [...base, newCat, female], t, undefined, nameToId);
  expect(statusAt(r, "r").kind).toBe("bred-done");
  expect(statusAt(r, "r.0").kind).toBe("bred-done");
  expect(r.doneSteps).toBe(2);
  expect(r.totalSteps).toBe(2);
});

test("a species_name absent from nameToId is unmatchable (stays pending)", () => {
  const leaf = mkNode({ species_name: "Foxparks", source: { Owned: { location: "Palbox", instance_id: guid(2) } } });
  const rt = mkNode({ species_name: "UnknownMon", source: "Bred", children: [leaf] });
  const p: BreedingPlan = { root: rt, total_time_secs: 0, total_steps: 1, total_wild_pals: 0, cake: "Normal", cake_count: 0 };
  const cand = mkPal({ instance_id: guid(15), character_id: "WhateverInternal" });
  const r = classifyPlan(p, [foxB, cand], newTracking([foxB]), undefined, nameToId);
  expect(statusAt(r, "r").kind).toBe("bred-pending");
});
