import { useEffect, useMemo, useState } from "react";
import { t, useLocale } from "../lib/materials-i18n";
import { useAppState } from "../state";
import { loadMaterials, searchMaterials, sortMaterialSources, expectedAmount, materialLocations, merchantOffers, rewardPoolLabel,
  type MaterialCatalog, type MaterialSource, type MaterialSort } from "../lib/materials";
import { loadMapData } from "../lib/map-data";
import type { MapData } from "../lib/map-coords";
import { palIconUrl, UNKNOWN_ICON } from "../lib/assets";
import { invoke } from "../lib/tauri";
import type { NamedEntry } from "../lib/types";

const panel = "rounded-lg border border-line bg-panel p-4";
const button = "rounded-md border border-line px-3 py-1.5 text-xs text-ink-dim hover:border-amber/50 hover:text-amber disabled:opacity-40";
const select = "rounded-md border border-line bg-panel px-3 py-2 text-sm";
function stored(key: string, fallback: string): string { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
const kinds = { drop: "Combat and capture", ranch: "Ranch", merchant: "Purchase", craft: "Crafting", gather: "Gathering", fishing: "Fishing", expedition: "Expeditions" };
const variants: Record<string,string> = { normal: "Normal", alpha: "Alpha", predator: "Predator", tower: "Tower boss", raid: "Raid boss", battle: "Battle victory reward" };

export default function Materials() {
  const locale = useLocale();
  const { roster, requestDex, materialTarget, clearMaterialTarget, requestMapMaterial } = useAppState();
  const [catalog, setCatalog] = useState<MaterialCatalog | null>(null);
  const [map, setMap] = useState<MapData | null>(null);
  const [species, setSpecies] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(() => stored("pal-lab.materialQuery", ""));
  const [selected, setSelected] = useState(() => stored("pal-lab.materialId", "WorldTreeHolyWater"));
  const [sort, setSort] = useState<MaterialSort>("expected");
  const [variant, setVariant] = useState("all");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [rank, setRank] = useState(0);
  useEffect(() => {
    let active = true;
    loadMaterials().then(d => active && setCatalog(d)).catch(e => active && setError(String(e)));
    loadMapData().then(d => active && setMap(d)).catch(() => {});
    invoke<NamedEntry[]>("list_species").then(s => active && setSpecies(new Set(s.map(p => p.id)))).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (materialTarget) { setSelected(materialTarget); setQuery(""); setVariant("all"); setOwnedOnly(false); clearMaterialTarget(); }
  }, [materialTarget, clearMaterialTarget]);
  useEffect(() => { try { localStorage.setItem("pal-lab.materialId", selected); localStorage.setItem("pal-lab.materialQuery", query); } catch { /* optional */ } }, [selected, query]);
  const name = (id: string) => {
    const label = catalog?.labels[id]; return label ? locale === "fr" ? label.name_fr : label.name : id;
  };
  const label = (s: MaterialSource) => (locale === "fr" ? s.name_fr : s.name) ?? s.name ?? "";
  const results = useMemo(() => searchMaterials(catalog?.items ?? [], query)
    .sort((a,b) => (locale === "fr" ? a.name_fr : a.name).localeCompare(locale === "fr" ? b.name_fr : b.name, locale)), [catalog, query, locale]);
  const material = catalog?.items.find(i => i.id === selected);
  const ownedCount = (id: string) => (roster?.[id]?.male ?? 0) + (roster?.[id]?.female ?? 0);
  const drops = sortMaterialSources((material?.sources ?? []).filter(s => s.kind === "drop"
    && (variant === "all" || s.variant === variant) && (!ownedOnly || ownedCount(s.species_id ?? "") > 0)), sort, locale);
  const ranch = sortMaterialSources((material?.sources ?? []).filter(s => s.kind === "ranch"
    && s.rank === (rank || s.base_rank) && (!ownedOnly || ownedCount(s.species_id ?? "") > 0)), sort, locale);
  function MapButton({ source }: { source: MaterialSource }) {
    const locations = map ? materialLocations(source, map) : [];
    const layers = [...new Set(locations.map(p => p.map))];
    return <div className="flex flex-wrap gap-1">{layers.map(layer => <button key={layer} className={button}
      onClick={() => requestMapMaterial(locations.find(p => p.map === layer)!)}>{t("Map")} · {layer === "Tree" ? t("World Tree") : t("Palpagos")} ({locations.filter(p => p.map === layer).length})</button>)}</div>;
  }
  function PalRows({ sources, isRanch = false }: { sources: MaterialSource[]; isRanch?: boolean }) {
    return <div className="overflow-x-auto"><table className="mt-3 w-full text-left text-sm">
      <thead className="border-b border-line text-xs text-ink-faint"><tr><th className="p-2">{t("Pal")}</th><th className="p-2">{isRanch ? t("Farming level") : t("Encounter")}</th><th className="p-2">{t("Qty")}</th><th className="p-2">{t("Rate")}</th><th className="p-2">{t("Expected amount")}</th><th className="p-2">{t("Your Pals")}</th><th className="p-2">{t("Location")}</th></tr></thead>
      <tbody>{sources.map((s, i) => <tr key={`${s.character_id}-${s.level_min}-${s.rank}-${i}`} className="border-b border-line-soft align-top">
        <td className="p-2"><button disabled={!species.has(s.species_id!)} onClick={() => requestDex(s.species_id!)} className="flex items-center gap-2 text-ink hover:text-amber disabled:cursor-default">
          <img className="h-8 w-8" src={palIconUrl(s.species_id!)} onError={e => { e.currentTarget.onerror = null; e.currentTarget.src = UNKNOWN_ICON; }} alt="" />{label(s)}</button></td>
        <td className="p-2 text-ink-dim">{isRanch ? `${t("Lv")} ${s.rank}` : <>{t(variants[s.variant!] ?? "Normal")}<br />{s.level_min ? `${t("Lv")} ${s.level_min}${s.level_max === s.level_min ? "" : s.level_max !== undefined ? `–${s.level_max}` : "+"}` : s.level_max !== undefined ? t("Up to level {0}", [s.level_max]) : t("All levels")}
          {s.variant === "battle" && <span className="block">{s.battle_id === "WorldTreeMiddleBoss3" ? t("Boss rush") : ""} {s.difficulty === "Hard" ? t("Hard") : t("Normal")}</span>}
          {s.first_defeat && <span className="block text-amber">{t("First defeat only")}</span>}</>}</td>
        <td className="whitespace-nowrap p-2 font-mono text-amber">{s.min === s.max ? s.min : `${s.min}–${s.max}`}</td>
        <td className="p-2 font-mono">{s.rate}%</td><td className="p-2 font-mono">{Number(expectedAmount(s).toFixed(2))}</td>
        <td className="p-2 font-mono">{roster ? ownedCount(s.species_id!) : "—"}</td>
        <td className="p-2">{s.variant === "predator" ? <span className="text-xs text-ink-faint">{t("Random encounter; no fixed spawn")}</span> : <MapButton source={s} />}</td>
      </tr>)}</tbody></table>{sources.length === 0 && <p className="py-4 text-sm text-ink-faint">{t("No sources match these filters.")}</p>}</div>;
  }
  if (error) return <div className="p-8"><p role="alert" className="text-warn">{t("Could not load materials.")} {error}</p><button className={`${button} mt-3`} onClick={() => { setError(null); loadMaterials().then(setCatalog).catch(e => setError(String(e))); }}>{t("Retry")}</button></div>;
  if (!catalog) return <div className="p-8 text-ink-dim">{t("Loading materials…")}</div>;
  return <div className="h-full overflow-y-auto p-5 md:p-8">
    <h1 className="font-display text-2xl font-bold">{t("Materials")}</h1>
    <p className="mt-2 text-sm text-ink-dim">{t("Find who drops a material, how much, and where to obtain it.")}</p>
    <div className="mt-5 grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside><input type="search" aria-label={t("Search materials")} placeholder={t("Search in English or French…")} value={query} onChange={e => setQuery(e.target.value)} className={`${select} w-full`} />
        <p className="my-2 text-xs text-ink-faint">{t(results.length === 1 ? "{0} material" : "{0} materials", [results.length])}</p>
        <div className="max-h-48 overflow-y-auto lg:max-h-[65vh] rounded-lg border border-line bg-panel">{results.map(i => <button key={i.id} aria-pressed={selected === i.id} onClick={() => { setSelected(i.id); setVariant("all"); }} className={`block w-full border-b border-line-soft px-3 py-2 text-left text-sm hover:bg-hover ${selected === i.id ? "bg-raised text-amber" : "text-ink-dim"}`}>{name(i.id)}</button>)}</div>
        {results.length === 0 && <p className="mt-3 text-sm text-ink-faint">{t("No material found.")}</p>}
      </aside>
      {material ? <article className="min-w-0 space-y-5" data-material-id={material.id}>
        <div className={panel}><h2 className="font-display text-xl text-amber">{name(material.id)}</h2>
          <p className="mt-1 text-xs text-ink-faint">{t("Weight")}: {new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(material.weight)} · {locale === "fr" ? material.name : material.name_fr}</p>
          <div className="mt-3 flex flex-wrap gap-2">{Object.entries(kinds).filter(([k]) => material.sources.some(s => s.kind === k)).map(([k,v]) => <a key={k} href={`#material-${k}`} className={button}>{t(v)}</a>)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-ink-dim">{t("Sort sources")} <select className={select} aria-label={t("Sort sources")} value={sort} onChange={e => setSort(e.target.value as MaterialSort)}>
            <option value="expected">{t("Expected amount")}</option><option value="max">{t("Maximum quantity")}</option><option value="rate">{t("Drop chance")}</option><option value="name">{t("Name")}</option></select></label>
          <label className="text-xs text-ink-dim">{t("Encounter")} <select className={select} aria-label={t("Encounter")} value={variant} onChange={e => setVariant(e.target.value)}><option value="all">{t("All")}</option>{Object.entries(variants).map(([k,v]) => <option key={k} value={k}>{t(v)}</option>)}</select></label>
          <label className="flex items-center gap-2 text-sm text-ink-dim"><input type="checkbox" checked={ownedOnly} disabled={!roster} onChange={e => setOwnedOnly(e.target.checked)} />{t("Owned species only")}</label>
        </div>
        {material.sources.some(s => s.kind === "drop") && <section id="material-drop" className={panel}><h3 className="font-display text-lg">{t(kinds.drop)}</h3><PalRows sources={drops} />
          <p className="mt-3 text-xs text-ink-faint">{t("Base quantities per encounter. Level ranges select different loot tables; server multipliers and drop bonuses are not included.")}</p>
          <p className="mt-2 text-xs text-ink-faint">{t("Battle rewards are awarded for victory in the named encounter, separately from an individual Pal’s loot.")}</p>
          <p className="mt-2 text-xs text-ink-faint">{t("Expected amount assumes a uniform quantity roll and includes the drop chance. It is not a production rate per hour.")}</p></section>}
        {material.sources.some(s => s.kind === "ranch") && <section id="material-ranch" className={panel}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-display text-lg">{t(kinds.ranch)}</h3>
          <label className="text-xs text-ink-dim">{t("Farming level")} <select aria-label={t("Farming level")} className={select} value={rank} onChange={e => setRank(Number(e.target.value))}><option value="0">{t("Each Pal's base level")}</option>{Array.from({ length: 10 }, (_,i) => <option key={i} value={i+1}>{i+1}</option>)}</select></label></div>
          <PalRows sources={ranch} isRanch /><p className="mt-3 text-xs text-ink-faint">{t("Quantities per production cycle at the selected farming level. Farming level is distinct from condensation stars.")}</p></section>}
        {material.sources.some(s => s.kind === "merchant") && <section id="material-merchant" className={panel}><h3 className="font-display text-lg">{t(kinds.merchant)}</h3>
          <div className="mt-3 space-y-2">{merchantOffers(material.sources).map((s,i) => <div key={i} className="flex flex-wrap justify-between gap-2 border-b border-line-soft pb-2 text-sm"><span>{t(s.name!)}</span><span className="font-mono text-amber">{s.price} {name(s.currency!)} / {s.qty} {t("item(s)")}</span></div>)}</div>
          <p className="mt-3 text-xs text-ink-faint">{t("Catalog prices. Stock varies between merchants and visits; a listed offer does not guarantee current availability.")}</p></section>}
        {material.sources.filter(s => s.kind === "gather").map(s => <section key={s.category} id="material-gather" className={panel}><h3 className="font-display text-lg">{t(kinds.gather)}</h3><div className="mt-3"><MapButton source={s} />{(!map || materialLocations(s, map).length === 0) && <p className="text-xs text-ink-faint">{t("No mapped gathering points in this map dataset.")}</p>}</div></section>)}
        {(["fishing", "expedition"] as const).filter(k => material.sources.some(s => s.kind === k)).map(kind => <section key={kind} id={`material-${kind}`} className={panel}><h3 className="font-display text-lg">{t(kinds[kind])}</h3>
          <div className="mt-3 space-y-2">{material.sources.filter(s => s.kind === kind).map((s,i) => <div key={i} className="flex flex-wrap justify-between gap-2 text-sm"><span>{t(rewardPoolLabel(s.pool!))}</span><span className="font-mono text-amber">{s.min === s.max ? s.min : `${s.min}–${s.max}`} · {Number(s.rate!.toFixed(2))}% · {t("Slot {0}", [s.slot])}</span></div>)}</div>
          <p className="mt-3 text-xs text-ink-faint">{t("Chance per reward slot, conditional on obtaining this reward pool.")}</p></section>)}
        {material.sources.some(s => s.kind === "craft") && <section id="material-craft" className={panel}><h3 className="font-display text-lg">{t(kinds.craft)}</h3><div className="mt-3 space-y-3">{material.sources.filter(s => s.kind === "craft").map(s => <div key={s.recipe_id} className="text-sm"><span className="text-amber">{s.qty} × {name(material.id)}</span><div className="mt-1 flex flex-wrap gap-2">{s.ingredients!.map(i => <button key={i.id} className={button} disabled={!catalog.items.some(m => m.id === i.id)} onClick={() => { setSelected(i.id); setQuery(""); }}>{i.qty} × {name(i.id)}</button>)}</div></div>)}</div></section>}
        {material.uses.length > 0 && <section className={panel}><h3 className="font-display text-lg">{t("Used to craft")}</h3><div className="mt-3 grid gap-2 sm:grid-cols-2">{material.uses.map((u,i) => <button key={i} className={`${button} text-left`} disabled={!catalog.items.some(m => m.id === u.id)} onClick={() => { setSelected(u.id); setQuery(""); }}>{u.qty} × {name(material.id)} → {u.output_qty} × {name(u.id)}</button>)}</div></section>}
        <p className="text-xs text-ink-faint">{t("Sources shown are those covered by the reference data. Other quest or scripted rewards may exist.")}</p>
      </article> : <p className="text-sm text-ink-faint">{t("Select a material.")}</p>}
    </div>
  </div>;
}
