import { expect, test } from "bun:test";
import { getLocale, setLocale, t, tr, matchesText, gameName } from "./index";
import game from "./game-fr.json";
import pack from "../../../crates/pal-data/vendor/extracted-game-data.json";
declare const Bun: { file(path: URL): { json(): Promise<unknown> } };

test("language switch translates menus and preserves unknown user text", () => {
  const previous = getLocale();
  setLocale("fr");
  expect(t("Save plan")).toBe("Enregistrer le plan");
  expect(t("Save Inspector")).toBe("Mes Pals");
  expect(t("My custom Anubis goal 100/100/100")).toBe("My custom Anubis goal 100/100/100");
  expect(t("toString")).toBe("toString");
  expect(matchesText("__proto__", "__proto__")).toBe(true);
  expect(tr(100)).toBe(100);
  setLocale("en");
  expect(t("Save plan")).toBe("Save plan");
  expect(t("Save Inspector")).toBe("Save Inspector");
  setLocale(previous);
});

test("In-game names use stable IDs and bilingual accent-insensitive search", () => {
  const previous = getLocale();
  setLocale("fr");
  expect(gameName("Legend", "Legend")).toBe("Légende");
  expect(t("Serenity")).toBe("Sérénité");
  expect(t("Demon’s Hand")).toBe("Main du Démon");
  expect(matchesText("legende", "Legend")).toBe(true);
  expect(matchesText("sérénité", "Serenity")).toBe(true);
  expect(matchesText("swift", "Swift")).toBe(true);
  setLocale("en");
  expect(gameName("Legend", "Legend")).toBe("Legend");
  expect(matchesText("serenite", "Serenity")).toBe(true);
  setLocale(previous);
});

test("interpolated UI messages preserve parameters, slots and spacing", () => {
  const previous = getLocale();
  setLocale("fr");
  expect(t("Remove {0}", ["My named Pal"])).toBe("Retirer My named Pal");
  expect(t(" Lv ")).toBe(" Niv. ");
  expect(t("{0} minimum IV", ["HP"])).toBe("IV minimum de HP");
  expect(t("Unknown {0}", [100])).toBe("Unknown 100");
  setLocale(previous);
});

test("every ranked partner description retains the exact rank slots", () => {
  const translations = game as Record<string, string>;
  let count = 0;
  for (const species of Object.values(pack.species)) {
    const template = species.partner_skill?.template;
    if (!template) continue;
    const key = template.replace(/\s+/g, " ").trim();
    const translated = translations[key];
    expect(typeof translated).toBe("string");
    expect((translated?.match(/\{\d+\}/g) ?? []).sort()).toEqual((template.match(/\{\d+\}/g) ?? []).sort());
    count++;
  }
  expect(count > 200).toBe(true);
});

test("map game names and composed statuses translate without changing identifiers", () => {
  const previous = getLocale();
  setLocale("fr");
  expect(t("Lamball Effigy")).toBe("Statue de Lamball");
  expect(t("Herbil Effigy")).toBe("Statue d'Herbil");
  expect(t("Rotmist Root")).toBe("Source de la brume corrosive");
  expect(t("Sealed Sanctum")).toBe("Chambre du sceau");
  expect(t("{0} · collected", [t("Lamball Effigy")])).toBe("Statue de Lamball · collectée");
  expect(t("Tower · reached · {0}", [t("Forbidden Laboratory")])).toBe("Tour · atteinte · Laboratoire interdit");
  expect(t("Bounty · defeated · {0}", ["My named target"])).toBe("Prime · vaincu · My named target");
  expect(t("Alpha Pal{0}", [t(", level {0}", [60])])).toBe("Pal Alpha, niveau 60");
  expect(t("{0}/{1} tracked towers reached", [2, 6])).toBe("2/6 tours suivies atteintes");
  expect(t("Defeated / total")).toBe("Vaincus / total");
  expect(t("Relic_01")).toBe("Relic_01");
  expect(t("Tower_Grass")).toBe("Tower_Grass");
  setLocale("en");
  expect(t("Lamball Effigy")).toBe("Lamball Effigy");
  expect(t("Tower · reached · {0}", [t("Forbidden Laboratory")])).toBe("Tower · reached · Forbidden Laboratory");
  setLocale(previous);
});

test("every named fast-travel point, tower and effigy type has a French game label", async () => {
  const map = await Bun.file(new URL("../../public/map/map-data.json", import.meta.url)).json() as {
    fast_travel: { name?: string | null }[];
    towers: { name?: string | null }[];
    effigy_types?: { name: string }[];
  };
  const names = [...map.fast_travel, ...map.towers, ...(map.effigy_types ?? [])]
    .flatMap(p => p.name ? [p.name] : []);
  const translations = game as Record<string, string>;
  for (const name of new Set(names)) {
    expect(Object.hasOwn(translations, name)).toBe(true);
    expect(translations[name].length > 0).toBe(true);
  }
  expect(names.length > 150).toBe(true);
});
