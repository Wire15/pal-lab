import { useState } from "react";
import SaveInspector from "./views/SaveInspector";
import Solver from "./views/Solver";
import Paldex from "./views/Paldex";

type View = "save" | "solver" | "paldex";

/** Inline nav glyphs: crate (roster), lineage fork (solver), grid (dex). */
function NavIcon({ view }: { view: View }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (view === "save")
    return (
      <svg {...common}>
        <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
        <path d="M3 7l9 4 9-4M12 11v10" />
      </svg>
    );
  if (view === "solver")
    return (
      <svg {...common}>
        <circle cx="6" cy="19" r="2.4" />
        <circle cx="18" cy="19" r="2.4" />
        <circle cx="12" cy="5" r="2.4" />
        <path d="M6 16.5v-2a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v2M12 7.4v4" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
    </svg>
  );
}

const NAV: { id: View; label: string; hint: string }[] = [
  { id: "save", label: "Save Inspector", hint: "Roster" },
  { id: "solver", label: "Solver", hint: "Breeding plans" },
  { id: "paldex", label: "Pal-dex", hint: "Reference" },
];

export default function App() {
  const [view, setView] = useState<View>("save");

  return (
    <div className="flex h-full bg-abyss text-ink">
      <nav className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        {/* Wordmark */}
        <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-amber/15 ring-1 ring-amber/40">
            <span className="font-display text-lg font-bold leading-none text-amber">
              P
            </span>
          </span>
          <div className="leading-tight">
            <div className="font-display text-[15px] font-bold tracking-[0.14em] text-ink">
              PAL&middot;CALC
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
              Breeding lab
            </div>
          </div>
        </div>

        <div className="mx-4 mb-3 h-px bg-line-soft" />

        <ul className="flex flex-col gap-0.5 px-2.5">
          {NAV.map((item) => {
            const active = view === item.id;
            return (
              <li key={item.id}>
                <button
                  onClick={() => setView(item.id)}
                  aria-current={active ? "page" : undefined}
                  className={`group relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                    active
                      ? "bg-raised text-ink"
                      : "text-ink-dim hover:bg-hover/60 hover:text-ink"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-amber transition-opacity ${
                      active ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <span className={active ? "text-amber" : "text-ink-faint group-hover:text-ink-dim"}>
                    <NavIcon view={item.id} />
                  </span>
                  <span className="flex flex-col">
                    <span className="text-[13px] font-medium leading-tight">{item.label}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      {item.hint}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-auto px-4 py-4">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            <span className="h-1.5 w-1.5 rounded-full bg-good" />
            Offline &middot; v0.1
          </div>
        </div>
      </nav>

      <main className="flex-1 overflow-hidden">
        {view === "save" && <SaveInspector />}
        {view === "solver" && <Solver />}
        {view === "paldex" && <Paldex />}
      </main>
    </div>
  );
}
