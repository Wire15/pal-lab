// Logic-level tests for the captured-human card + its click routing. Run with
// `bun test`. We test the extracted presentation model (humanCardModel) and the
// isHuman/isAlpha predicates that gate routing, the roster IV dashes, and the
// Alpha badge — behavior, not rendering.
import { expect, test } from "bun:test";

import humansData from "../lib/humans.json";
import { humanCardModel } from "./human-card-model";
import { isHuman } from "./palbox/selectors";
import { isAlpha, type OwnedPal } from "../lib/types";

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

// Pull a real profile from the shipped humans.json so the test tracks the data
// contract rather than a hard-coded name that data edits would break.
const humans = humansData as Record<
  string,
  { name: string; faction: string; work: Record<string, number> }
>;
const [KNOWN_ID, KNOWN] = Object.entries(humans)[0]!;

const known = (over: Partial<OwnedPal> = {}): OwnedPal =>
  mkPal({ instance_id: guid(1), character_id: KNOWN_ID, is_human: true, gender: null, ...over });

test("humanCardModel resolves a known human from its profile", () => {
  const m = humanCardModel(known());
  expect(m.info).not.toBeNull();
  expect(m.name).toBe(KNOWN.name);
  expect(m.faction).toBe(KNOWN.faction);
});

test("humanCardModel work rows are nonzero and sorted high to low", () => {
  const m = humanCardModel(known());
  const expected = Object.values(KNOWN.work).filter((v) => v > 0).length;
  expect(m.work.length).toBe(expected);
  for (const [, lv] of m.work) expect(lv > 0).toBe(true);
  const levels = m.work.map(([, lv]) => lv);
  expect(levels).toEqual([...levels].sort((a, b) => b - a));
});

test("unknown human id degrades to an honest empty (name=id, faction Unknown, no stats)", () => {
  const id = "NotAHuman_ZzZ_0000";
  const m = humanCardModel(mkPal({ instance_id: guid(2), character_id: id, is_human: true }));
  expect(m.info).toBeNull(); // null info drives: no stats section rendered
  expect(m.name).toBe(id);
  expect(m.faction).toBe("Unknown");
  expect(m.work).toEqual([]);
});

test("a human click routes to the card, a pal to the Pal-dex (isHuman gate)", () => {
  expect(isHuman(known())).toBe(true);
  expect(isHuman(mkPal({ instance_id: guid(3), character_id: "PenguinPal" }))).toBe(false);
});

test("roster IV cells dash for humans (isHuman gate drives the dash)", () => {
  // RosterRow renders em-dash IV cells iff isHuman(pal); guard the gate.
  expect(isHuman(known())).toBe(true);
  expect(isHuman(mkPal({ instance_id: guid(4), character_id: "PenguinPal" }))).toBe(false);
});

test("a bounty human keeps the Alpha badge (isAlpha true for is_boss, no human gating)", () => {
  const bounty = mkPal({
    instance_id: guid(5),
    character_id: "BOSS_Hunter_Rifle",
    is_human: true,
    is_boss: true,
    gender: null,
  });
  expect(isAlpha(bounty)).toBe(true);
});
