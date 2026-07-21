export default function Paldex() {
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line bg-panel/60 px-6 pb-4 pt-5">
        <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
          Pal-dex
        </div>
        <h1 className="font-display text-xl font-bold tracking-wide text-ink">
          Reference
        </h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <div className="font-display text-lg text-ink-dim">Coming next</div>
        <p className="max-w-xs text-sm text-ink-faint">
          The full pal reference &mdash; base stats, elements, and breeding
          combinations &mdash; lands in the next pass.
        </p>
      </div>
    </div>
  );
}
