// The Pal-dex section switcher: a segmented [Pals | Passives] control shared by
// the two reference browsers (species grid, passive-skill grid). Matches the
// sort-control treatment (§6): active = amber on `raised`, muted otherwise.

export type DexTab = "pals" | "passives";

const TABS: { key: DexTab; label: string }[] = [
  { key: "pals", label: "Pals" },
  { key: "passives", label: "Passives" },
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
