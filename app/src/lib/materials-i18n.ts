import { useSyncExternalStore } from "react";
import french from "./materials-fr.json";

// Follows the host application's language. Without a language switch (upstream
// standalone build), the material browser defaults to English.
export function materialLocale(): "fr" | "en" {
  return typeof document !== "undefined" && document.documentElement.lang.startsWith("fr") ? "fr" : "en";
}
export function useLocale(): "fr" | "en" {
  return useSyncExternalStore(cb => {
    if (typeof document === "undefined") return () => {};
    const observer = new MutationObserver(cb);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, materialLocale, () => "en");
}
export function t(source: string, values: unknown[] = []): string {
  const value = materialLocale() === "fr" ? (french as Record<string,string>)[source] ?? source : source;
  return value.replace(/\{(\d+)\}/g, (token, index) => index in values ? String(values[index]) : token);
}
