// The Pal-dex section switcher: a segmented [Pals | Passives | Moves] control
// shared by the reference browsers (species grid, passive-skill grid, active-
// skill/moves reference). Matches the sort-control treatment (§6): active =
// amber on `raised`, muted otherwise.

export type DexTab = "pals" | "passives" | "moves";

const TABS: { key: DexTab; label: string }[] = [
  { key: "pals", label: "Pals" },
  { key: "passives", label: "Passives" },
  { key: "moves", label: "Moves" },
];

export function DexTabs({ tab, onTab }: { tab: DexTab; onTab: (t: DexTab) => void }) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border border-line">
      {TABS.map((t) => {
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onTab(t.key)}
            aria-pressed={active}
            className={`select-none border-l border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors first:border-l-0 ${
              active
                ? "bg-raised text-amber"
                : "bg-panel text-ink-faint hover:bg-hover hover:text-ink-dim"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
