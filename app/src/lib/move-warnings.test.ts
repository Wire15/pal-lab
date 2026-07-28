// Unit tests for the Solver's advisory move-warning classifier. Run with
// `bun test`. The `bun:test` import type-resolves via app/src/bun-test.d.ts.
import { expect, test } from "bun:test";

import { classifyMoveWarnings } from "./move-warnings";
import type { ActiveSkill, ActiveSkills } from "./types";

function mkSkill(over: Partial<ActiveSkill> & { name: string }): ActiveSkill {
  return {
    element: "Normal",
    power: null,
    cool_time: null,
    description: null,
    can_inherit: true,
    has_skill_fruit: false,
    ...over,
  };
}

const MAP: ActiveSkills = {
  AirCanon: mkSkill({ name: "Air Cannon", can_inherit: true, has_skill_fruit: true }),
  Inheritable: mkSkill({ name: "Inheritable Move", can_inherit: true, has_skill_fruit: false }),
  FruitOnly: mkSkill({ name: "Fruit Move", can_inherit: false, has_skill_fruit: true }),
  Exclusive: mkSkill({ name: "Exclusive Move", can_inherit: false, has_skill_fruit: false }),
  LearnsetMove: mkSkill({ name: "Learnset Move", can_inherit: false, has_skill_fruit: false }),
};

const NO_LEARNSET = new Set<string>();

test("no warnings for a single breedable move", () => {
  expect(classifyMoveWarnings(["Inheritable"], MAP, NO_LEARNSET)).toEqual([]);
});

test("unteachable move (non-inheritable + non-fruitable) warns", () => {
  const w = classifyMoveWarnings(["Exclusive"], MAP, NO_LEARNSET);
  expect(w).toHaveLength(1);
  expect(w[0].kind).toBe("unteachable");
  expect(w[0].moves).toEqual(["Exclusive Move"]);
  expect(w[0].text).toContain("can");
  expect(w[0].text).toContain("no path");
});

test("a learnset (auto-satisfied) move never warns, even if unteachable", () => {
  // LearnsetMove is non-inheritable + non-fruitable but IS in the target's
  // learnset -> levelable, so no warning.
  const learnset = new Set(["LearnsetMove"]);
  expect(classifyMoveWarnings(["LearnsetMove"], MAP, learnset)).toEqual([]);
});

test(">1 breeding-required (non-learnset) move warns about the one-per-line cap", () => {
  const w = classifyMoveWarnings(["Inheritable", "FruitOnly"], MAP, NO_LEARNSET);
  const tooMany = w.find((x) => x.kind === "too-many");
  expect(tooMany).toBeDefined();
  expect(tooMany!.moves).toEqual(["Inheritable Move", "Fruit Move"]);
  expect(tooMany!.text).toContain("Skill Fruits");
});

test("one non-learnset + one learnset move does NOT trip the cap warning", () => {
  // Only "Inheritable" is breeding-required; "LearnsetMove" is auto-satisfied.
  const learnset = new Set(["LearnsetMove"]);
  const w = classifyMoveWarnings(["Inheritable", "LearnsetMove"], MAP, learnset);
  expect(w.find((x) => x.kind === "too-many")).toBeUndefined();
});

test("unknown ids are ignored (left to the server to reject)", () => {
  expect(classifyMoveWarnings(["NopeNotReal"], MAP, NO_LEARNSET)).toEqual([]);
});

test("exclusive move is excluded from the threadable count", () => {
  // Exclusive is unteachable (its own warning); only Inheritable is threadable,
  // so no cap warning fires — just the unteachable one.
  const w = classifyMoveWarnings(["Exclusive", "Inheritable"], MAP, NO_LEARNSET);
  expect(w.filter((x) => x.kind === "too-many")).toEqual([]);
  expect(w.filter((x) => x.kind === "unteachable")).toHaveLength(1);
});
