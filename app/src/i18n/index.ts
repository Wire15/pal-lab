import { useSyncExternalStore } from "react";
import fr from "./ui-fr.json";
import game from "./game-fr.json";
import gameIds from "./game-ids-fr.json";

export type Locale = "fr" | "en";
const KEY = "pal-lab.language";
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "fr") return saved;
  } catch { /* storage may be disabled */ }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}
let locale = initialLocale();
const listeners = new Set<() => void>();
const normal = (s: string) => s.replace(/\s+/g, " ").trim();
const french: Record<string, string> = Object.assign(Object.create(null), game, fr);
const english: Record<string, string> = Object.assign(Object.create(null), { GenerateElectricity: "Electricity" });
const ids: Record<string, string> = Object.assign(Object.create(null), gameIds);

export function getLocale(): Locale { return locale; }
export function setLocale(next: Locale): void {
  if (next !== "fr" && next !== "en" || locale === next) return;
  locale = next;
  try { localStorage.setItem(KEY, next); } catch { /* optional persistence */ }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  listeners.forEach(fn => fn());
}
export function useLocale(): Locale {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, getLocale, getLocale);
}

/** Translate display text only. IDs, save values and solver requests stay intact. */
export function t(source: string, values: unknown[] = []): string {
  const key = normal(source);
  const dictionary = locale === "fr" ? french : english;
  let translated = dictionary[key] ?? source;
  if (dictionary[key] !== undefined) {
    translated = (source.match(/^\s*/)?.[0] ?? "") + translated + (source.match(/\s*$/)?.[0] ?? "");
  }
  return translated.replace(/\{(\d+)\}/g, (token, index) => index in values ? String(values[index]) : token);
}

/** Labels can also be booleans or nodes on shared components. */
export function tr<T>(value: T): T {
  return (typeof value === "string" ? t(value) : value) as T;
}
export function gameName(id: string, fallback: string): string {
  return locale === "fr" ? ids[id] ?? t(fallback) : fallback;
}
export function matchesText(query: string, ...texts: string[]): boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
  const q = fold(query.trim());
  return texts.some(s => fold(s).includes(q) || fold(french[normal(s)] ?? s).includes(q));
}
if (typeof document !== "undefined") document.documentElement.lang = locale;
