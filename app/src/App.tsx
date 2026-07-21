import { useState } from "react";
import SaveInspector from "./views/SaveInspector";
import Solver from "./views/Solver";
import Paldex from "./views/Paldex";

type View = "save" | "solver" | "paldex";

const NAV: { id: View; label: string }[] = [
  { id: "save", label: "Save Inspector" },
  { id: "solver", label: "Solver" },
  { id: "paldex", label: "Pal-dex" },
];

export default function App() {
  const [view, setView] = useState<View>("save");

  return (
    <div className="flex h-full text-gray-900">
      <nav className="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
        <div className="px-4 py-4 text-lg font-bold">Pal Calc</div>
        <ul className="flex flex-col">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                className={`w-full px-4 py-2 text-left text-sm ${
                  view === item.id
                    ? "bg-blue-600 font-medium text-white"
                    : "hover:bg-gray-100"
                }`}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="flex-1 overflow-auto">
        {view === "save" && <SaveInspector />}
        {view === "solver" && <Solver />}
        {view === "paldex" && <Paldex />}
      </main>
    </div>
  );
}
