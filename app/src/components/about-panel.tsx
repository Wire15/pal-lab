// About panel: app version, data-pack identity, a manual update check, and the
// license note. Mounted from the sidebar footer via <AboutButton /> (which
// renders the "Offline · v0.2" chip as its own trigger and owns the modal
// state), so App.tsx only needs the one import + usage.
//
// The update check hits GitHub's releases/latest via the Rust `check_update`
// command (see src-tauri/src/updater.rs); any failure degrades to a quiet
// "couldn't check" line. In plain-browser dev (`bun run dev`) there is no
// backend, so we short-circuit to the "disabled" shape rather than error.

import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke, isFixtureMode } from "../lib/tauri";

/** Mirror of `updater::UpdateCheck`. `status` drives every rendered branch. */
interface UpdateCheck {
  status: "disabled" | "up_to_date" | "update_available" | "error";
  latest?: string;
  url?: string;
  notes?: string;
}

/** Mirror of `updater::DataPackInfo`. */
interface DataPackInfo {
  pack_version: string;
  game_build: string;
}

/** Repository home, opened from the About footer's GitHub link. */
const REPO_URL = "https://github.com/Wire15/pal-lab";

/** Neutral standing copy shown before any check runs and for the backend
 *  "disabled" status (browser preview / fixture mode, where there is no
 *  updater). */
const DISABLED_MESSAGE =
  "Compares your version against the latest GitHub release.";

/** The clickable sidebar-footer chip + its About modal. Self-contained: owns
 *  its own open/close state so the mount site needs no extra wiring. */
export default function AboutButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="About Pal Lab"
        className="mt-2.5 flex w-full items-center gap-2 rounded px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-dim"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-good" />
        Pal Lab &middot; v1.0
      </button>
      {open && <AboutModal onClose={() => setOpen(false)} />}
    </>
  );
}

function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string>("");
  const [pack, setPack] = useState<DataPackInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheck | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // App version + data-pack identity. Both degrade gracefully in browser dev
  // (no Tauri backend): version falls back to "dev", pack row is hidden.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (isFixtureMode()) {
        if (alive) setVersion("dev");
      } else {
        try {
          const v = await getVersion();
          if (alive) setVersion(v);
        } catch {
          if (alive) setVersion("unknown");
        }
      }
      try {
        const p = await invoke<DataPackInfo>("data_pack_info");
        if (alive) setPack(p);
      } catch {
        // No fixture in browser dev — leave the pack row hidden.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setResult(null);
    try {
      if (isFixtureMode()) {
        setResult({ status: "disabled" });
        return;
      }
      const current = version || (await getVersion().catch(() => "0.0.0"));
      const r = await invoke<UpdateCheck>("check_update", {
        currentVersion: current,
      });
      setResult(r);
    } catch (e) {
      setResult({ status: "error", notes: String(e) });
    } finally {
      setChecking(false);
    }
  }, [version]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-modal-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            About
          </div>
          <h2
            id="about-modal-title"
            className="mt-0.5 font-display text-lg font-bold tracking-wide text-ink"
          >
            Pal Lab
          </h2>
          <div className="mt-1 font-mono text-[12px] text-ink-dim">
            v{version || "\u2026"}
          </div>
        </div>

        <div className="border-b border-line px-5 py-4">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Data pack
          </div>
          {pack ? (
            <dl className="flex flex-col gap-1 font-mono text-[12px]">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Pack version</dt>
                <dd className="text-ink-dim">{pack.pack_version}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-faint">Game build</dt>
                <dd className="text-ink-dim">{pack.game_build}</dd>
              </div>
            </dl>
          ) : (
            <p className="font-mono text-[12px] text-ink-faint">
              Unavailable in browser preview.
            </p>
          )}
        </div>

        <div className="border-b border-line px-5 py-4">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <div className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Updates
            </div>
            <button
              onClick={check}
              disabled={checking}
              className="rounded-md border border-line bg-raised px-3 py-1.5 text-[12px] font-medium text-ink-dim transition-colors hover:border-amber/40 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              {checking ? "Checking\u2026" : "Check for updates"}
            </button>
          </div>
          <UpdateResult result={result} />
        </div>

        <div className="px-5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => openUrl(REPO_URL).catch(() => {})}
              className="font-mono text-[11px] text-ink-dim transition-colors hover:text-amber"
            >
              github.com/Wire15/pal-lab
            </button>
            <button
              onClick={onClose}
              className="shrink-0 rounded-md px-3 py-1.5 text-[13px] font-medium text-ink-faint transition-colors hover:text-ink-dim"
            >
              Close
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            GPL-3.0 licensed. Read-only &mdash; Pal Lab never modifies your
            saves.
          </p>
          <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint/70">
            Unofficial fan tool. Palworld is © Pocketpair, Inc. Not affiliated
            with or endorsed by Pocketpair.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Renders the current update-check state. Idle (no result yet) falls back to
 *  the neutral standing copy so the panel reads correctly before any click. */
function UpdateResult({ result }: { result: UpdateCheck | null }) {
  const status = result?.status ?? "disabled";

  if (status === "update_available") {
    return (
      <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2.5">
        <div className="text-[12px] font-medium text-ink">
          Update available{result?.latest ? `: v${result.latest}` : ""}
        </div>
        {result?.notes && (
          <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-ink-dim">
            {result.notes}
          </p>
        )}
        {result?.url && (
          <button
            onClick={() => openUrl(result.url!).catch(() => {})}
            className="mt-2 rounded-md bg-amber px-3 py-1 text-[12px] font-semibold text-abyss transition-colors hover:bg-amber-bright"
          >
            Open release page
          </button>
        )}
      </div>
    );
  }

  if (status === "up_to_date") {
    return (
      <p className="text-[12px] text-ink-dim">
        You&rsquo;re up to date{result?.latest ? ` (v${result.latest})` : ""}.
      </p>
    );
  }

  if (status === "error") {
    return (
      <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-bad">
        Couldn&rsquo;t check for updates{result?.notes ? `: ${result.notes}` : "."}
      </div>
    );
  }

  return (
    <p className="text-[12px] leading-relaxed text-ink-faint">
      {DISABLED_MESSAGE}.
    </p>
  );
}
