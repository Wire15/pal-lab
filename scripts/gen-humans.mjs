#!/usr/bin/env bun
// Regenerates app/src/lib/humans.json and downloads human/bounty portrait icons
// into app/public/humans/. Humans are presentation-only in Pal Lab (no Rust /
// pack changes) — this vendors the aggregated human-NPC data + portrait art from
// oMaN-Rod/palworld-save-pal (MIT), which is ultimately Palworld game data/art
// (c) Pocketpair. See THIRD-PARTY-NOTICES.md.
//
//   Run:  bun scripts/gen-humans.mjs
//
// The OUTPUT (humans.json + *.webp) is committed; this script is for
// regeneration, not build-time. It is idempotent: re-running produces identical
// output and only downloads icons not already on disk.

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url); // repo root (scripts/ -> ..)
const HUMANS_JSON = fileURLToPath(new URL("app/src/lib/humans.json", ROOT));
const ICON_DIR = fileURLToPath(new URL("app/public/humans/", ROOT));

const RAW = "https://raw.githubusercontent.com/oMaN-Rod/palworld-save-pal/main";
const PALS_URL = `${RAW}/data/json/pals.json`;
const L10N_URL = `${RAW}/data/json/l10n/en/pals.json`;
const IMG_URL = (base) => `${RAW}/ui/src/lib/assets/img/${base}.webp`;
const GENERIC_ICON = "t_commonhuman_icon_normal"; // guaranteed fallback

// --- work-suitability: game-internal key -> app canonical name -------------
// Matches WORK_KINDS in crates/pal-data (and app/public/work/*.png). Game keys
// with no canonical equivalent (OilExtraction) are dropped.
const WORK_MAP = {
  EmitFlame: "Kindling",
  Watering: "Watering",
  Seeding: "Planting",
  GenerateElectricity: "GenerateElectricity",
  Handcraft: "Handiwork",
  Collection: "Gathering",
  Deforest: "Lumbering",
  Mining: "Mining",
  ProductMedicine: "MedicineProduction",
  Cool: "Cooling",
  Transport: "Transporting",
  MonsterFarm: "Farming",
};

// --- faction resolution (pinned pattern table; applied to the base id) ------
// BOSS_-prefixed rows inherit the faction of their base id.
function factionOf(fid) {
  if (fid.startsWith("Hunter_")) return "Rayne Syndicate";
  if (fid.startsWith("Police_")) return "PIDF";
  if (fid.startsWith("Believer_")) return "Free Pal Alliance";
  if (fid.startsWith("FireCult_")) return "Brothers of the Eternal Pyre";
  if (fid.includes("Scientist")) return "PAL Genetic Research Unit";
  if (fid.includes("Ninja")) return "Moonflower";
  if (fid.startsWith("SalesPerson") || fid === "VisitingMerchant" || fid === "Visitor_Present")
    return "Wandering Merchant";
  if (fid.startsWith("PalDealer") || fid.startsWith("PalTrader") || fid === "Inspector")
    return "Pal Merchant";
  if (fid.startsWith("Male_DarkTrader")) return "Black Marketeer";
  if (
    fid.startsWith("MobuCitizen") ||
    fid.startsWith("Male_People") ||
    fid.startsWith("Female_People") ||
    fid.startsWith("Male_Trader")
  )
    return "Villager";
  if (fid.startsWith("Guard_")) return "Guard";
  return "Unknown";
}

// --- icon candidates -------------------------------------------------------
// Ordered most-specific -> generic. First candidate whose .webp exists in the
// save-pal asset repo (verified by a 200 download) wins.

// Bounty (BOSS_) rows: derive t_boss_npc_<suffix> art from the base archetype.
function bossNpcSuffixes(base) {
  const s = base.toLowerCase();
  const out = [];
  const num = () => {
    const m = s.match(/(\d{2})(?!.*\d)/); // trailing 2-digit variant (02/03/04)
    return m ? m[1] : "";
  };
  const gender = s.includes("female") ? "female" : "male";

  if (s.includes("hunter")) out.push(s.includes("fat") ? "hunter_fat" : "hunter");
  if (s.includes("believer")) out.push(s.includes("fat") ? "believer_fat" : "believer");
  if (s.includes("firecult")) out.push("firecult");
  if (s.includes("police")) out.push(s.includes("old") ? "police_old" : "police");
  if (s.includes("scientist")) out.push("male_scientist");
  if (s.includes("ninjaelite")) out.push("male_ninjaelite");
  else if (s.includes("ninja")) out.push("male_ninja");
  if (s.includes("viking")) out.push(s.includes("elite") ? "vikingelite" : "viking");
  if (s.includes("darktrader")) out.push("darktrader");
  if (s.includes("soldier")) {
    const n = num();
    out.push(`${gender}_soldier${n && n !== "01" ? n : ""}`);
  }
  if (s.includes("desert") && s.includes("people")) out.push(`${gender}_desertpeople`);
  if (s.includes("trader") && s.startsWith("male_trader")) {
    const m = s.match(/(\d{2})/);
    out.push(`male_trader${m ? m[1] : "01"}`);
  }
  if (s.includes("people") && !s.includes("desert")) {
    const n = num();
    out.push(n === "02" ? `${gender}02` : n === "03" ? `${gender}03` : gender);
  }
  return out;
}

// Named non-boss archetype art (merchants / dealers / black marketeer).
function namedArchetypeCandidates(base) {
  const low = base.toLowerCase();
  const named = [];
  if (
    low.startsWith("salesperson") ||
    low.startsWith("paldealer") ||
    low.startsWith("paltrader") ||
    low === "visitingmerchant" ||
    low.startsWith("male_darktrader")
  ) {
    // exact id then progressive trailing-segment trims, e.g.
    // salesperson_desert2 -> salesperson; male_darktrader01_02 -> male_darktrader01.
    // Stop before a lone "male"/"female" (segment 1) — those aren't archetype
    // art, so such ids fall through to the generic fallback instead.
    const segs = low.split("_");
    const min = segs.length > 1 ? 2 : 1;
    for (let n = segs.length; n >= min; n--) named.push(segs.slice(0, n).join("_"));
  }
  return named;
}

function iconCandidates(id, base, isBoss, ownIcon) {
  const c = [];
  if (isBoss) for (const s of bossNpcSuffixes(base)) c.push(`t_boss_npc_${s}`);
  c.push(...namedArchetypeCandidates(base));
  if (ownIcon && ownIcon !== GENERIC_ICON) c.push(ownIcon); // honor the entry's own icon field
  c.push(GENERIC_ICON);
  // dedupe, preserve order
  return [...new Set(c)];
}

// --- icon download cache ---------------------------------------------------
const iconStatus = new Map(); // base -> true(present) | false(missing)

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Ensure the icon <base>.webp is on disk (download once, verify HTTP 200).
// Returns true if the file is present after the call.
async function ensureIcon(base) {
  if (iconStatus.has(base)) return iconStatus.get(base);
  const dest = `${ICON_DIR}${base}.webp`;
  if (await exists(dest)) {
    iconStatus.set(base, true);
    return true;
  }
  let ok = false;
  try {
    const res = await fetch(IMG_URL(base));
    if (res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0) {
        await writeFile(dest, buf);
        ok = true;
      }
    }
  } catch {
    ok = false;
  }
  iconStatus.set(base, ok);
  return ok;
}

async function resolveIcon(id, base, isBoss, ownIcon) {
  for (const cand of iconCandidates(id, base, isBoss, ownIcon)) {
    if (await ensureIcon(cand)) return cand;
  }
  throw new Error(`no icon landed for ${id} (generic fallback missing?)`);
}

// --- main ------------------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url);
  if (res.status !== 200) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function main() {
  await mkdir(ICON_DIR, { recursive: true });

  const [pals, l10n] = await Promise.all([fetchJson(PALS_URL), fetchJson(L10N_URL)]);

  const ids = Object.keys(pals)
    .filter((id) => pals[id].is_pal === false)
    .sort();

  const out = {};
  const unknownFaction = [];
  const cov = { archetype: 0, generic: 0 }; // icon coverage

  for (const id of ids) {
    const e = pals[id];
    const isBoss = e.is_boss === true || id.startsWith("BOSS_");
    const base = id.startsWith("BOSS_") ? id.slice("BOSS_".length) : id;

    const faction = factionOf(base);
    if (faction === "Unknown") unknownFaction.push(id);

    const work = {};
    for (const [gk, canon] of Object.entries(WORK_MAP)) {
      const lvl = e.work_suitability?.[gk] ?? 0;
      if (lvl > 0) work[canon] = lvl;
    }

    const icon = await resolveIcon(id, base, isBoss, e.icon);
    if (icon === GENERIC_ICON) cov.generic++;
    else cov.archetype++;

    const name = l10n[id]?.localized_name;
    if (!name) throw new Error(`missing en localized_name for ${id}`);

    const row = {
      name,
      faction,
      icon,
      work,
      stats: {
        hp: e.scaling.hp,
        attack: e.scaling.attack,
        defense: e.scaling.defense,
      },
      bounty: isBoss,
    };
    if (typeof e.price === "number" && e.price > 0) row.price = e.price;

    out[id] = row;
  }

  await writeFile(HUMANS_JSON, JSON.stringify(out, null, 2) + "\n");

  // --- report --------------------------------------------------------------
  console.log(`humans: ${ids.length}`);
  console.log(
    `icon coverage: ${cov.archetype} archetype art, ${cov.generic} generic (${GENERIC_ICON})`,
  );
  console.log(`distinct icons on disk referenced: ${new Set(Object.values(out).map((r) => r.icon)).size}`);
  console.log(`bounty rows: ${Object.values(out).filter((r) => r.bounty).length}`);
  console.log(`faction=Unknown: ${unknownFaction.length}`);
  console.log(unknownFaction.join(", "));
}

await main();
