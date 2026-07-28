// Unit tests for the per-step odds breakdown formatting. Run with `bun test`.
// `bun:test` type-resolves via app/src/bun-test.d.ts.
import { expect, test } from "bun:test";

import { buildOddsRows, eggsSummary } from "./odds";
import type { StepOdds } from "./types";

test("passives + ivs render; move and gender omitted when absent", () => {
  const odds: StepOdds = { passives: 0.25, ivs: 0.5 };
  expect(buildOddsRows(odds)).toEqual([
    { label: "Passives", value: "25%" },
    { label: "IVs", value: "50%" },
  ]);
});

test("no Move row when move_pass is absent", () => {
  const rows = buildOddsRows({ passives: 0.5, ivs: 1 });
  expect(rows.some((r) => r.label === "Move")).toBe(false);
});

test("Move row appears when move_pass is present", () => {
  const rows = buildOddsRows({ passives: 0.5, ivs: 1, move_pass: 0.5 });
  expect(rows).toEqual([
    { label: "Passives", value: "50%" },
    { label: "Move", value: "50%" },
  ]);
});

test("IVs row is suppressed when the factor is a no-op (ivs === 1)", () => {
  const rows = buildOddsRows({ passives: 0.5, ivs: 1 });
  expect(rows.some((r) => r.label === "IVs")).toBe(false);
});

test("Gender row appears only when the gender factor is present", () => {
  const rows = buildOddsRows({ passives: 0.5, ivs: 1, gender: 0.5 });
  expect(rows).toEqual([
    { label: "Passives", value: "50%" },
    { label: "Gender", value: "50%" },
  ]);
});

test("full breakdown keeps the Passives → Move → IVs → Gender order", () => {
  const odds: StepOdds = { passives: 0.25, ivs: 0.5, move_pass: 0.5, gender: 0.5 };
  expect(buildOddsRows(odds).map((r) => r.label)).toEqual([
    "Passives",
    "Move",
    "IVs",
    "Gender",
  ]);
});

test("eggsSummary rounds up to at least one egg", () => {
  expect(eggsSummary(2.4)).toBe("\u2192 ~2 eggs");
  expect(eggsSummary(12)).toBe("\u2192 ~12 eggs");
  expect(eggsSummary(0)).toBe("\u2192 ~1 eggs");
});
