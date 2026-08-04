import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import SaveInspector from "./views/SaveInspector";
import Solver from "./views/Solver";
import Paldex from "./views/Paldex";
import IvLab from "./views/IvLab";
import MapView from "./views/map/MapView";
import { AppStateProvider, useAppState } from "./state";
import { hexGuid } from "./components/palbox/selectors";
import ErrorBoundary from "./components/error-boundary";
import AboutButton from "./components/about-panel";
import WebDropZone, { rereadWebSave } from "./components/web-drop-zone";
import { canReread } from "./lib/save-drop";
import { caps } from "./lib/caps";
import { invoke } from "./lib/tauri";
import {
  encodeXboxSource,
  type XboxStore,
  type XboxWorld,
  type XboxWorldRow,
} from "./lib/xbox-save";
import {
  encodeSftpSource,
  readSftpProfile,
  sftpAutoLoginDecision,
  writeSftpProfile,
  type SftpAuth,
  type SftpConnectInfo,
  type SftpProfile,
  type SftpSecret,
} from "./lib/sftp";
import type { View } from "./state";

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
  if (view === "ivlab")
    return (
      <svg {...common}>
        <line x1="4" y1="7" x2="20" y2="7" />
        <circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
        <line x1="4" y1="17" x2="20" y2="17" />
        <circle cx="8" cy="17" r="2" fill="currentColor" stroke="none" />
      </svg>
    );
  if (view === "worldmap")
    return (
      <svg {...common}>
        <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
        <path d="M9 4v14M15 6v14" />
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
  { id: "ivlab", label: "IV Lab", hint: "Stat breeding" },
  { id: "paldex", label: "Pal-dex", hint: "Reference" },
  { id: "worldmap", label: "World Map", hint: "Explore" },
];

/** Two-arrow swap glyph for the "switch save" affordance. */
function SwapIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />
    </svg>
  );
}

/** Folder glyph for the empty "load save" button. */
function FolderIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

/** Compact relative age for a recent-save row ("just now", "2h ago", "3d ago"). */
function relativeTime(epoch: number): string {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor((Date.now() - epoch) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Startup / switch-save dialog. Prefilled from the last-used folder, loads the
 * save through the shared app state (which caches it), and closes once the save
 * lands. "Skip for now" dismisses it — the app is fully usable without a save.
 */
function SaveModal({ onClose }: { onClose: () => void }) {
  const {
    lastSaveDir,
    loadSave,
    saveLoading,
    saveError,
    recentSaves,
    sftpReconnect,
    clearSftpReconnect,
  } = useAppState();
  const [path, setPath] = useState(lastSaveDir);
  const [xboxScanning, setXboxScanning] = useState(false);
  const [xboxNote, setXboxNote] = useState<string | null>(null);
  const [xboxWorlds, setXboxWorlds] = useState<XboxWorldRow[] | null>(null);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [sftpReconnectData, setSftpReconnectData] = useState<{
    worldDir: string;
    profile: SftpProfile | null;
  } | null>(null);

  // Boot-restore: a persisted SFTP save arrives as a one-shot reconnect request
  // (state.tsx never auto-loads it blind). Consume it once on mount — open the
  // connect modal prefilled/reconnecting and clear the request so a later
  // manual "Switch save" reopens the plain load modal.
  useEffect(() => {
    if (!sftpReconnect) return;
    setSftpReconnectData(sftpReconnect);
    setSftpOpen(true);
    clearSftpReconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function browse() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") setPath(picked);
    } catch {
      // No dialog plugin outside the Tauri webview (plain-browser dev) — ignore.
    }
  }

  // Scan the local Game Pass save store and route to a world. Zero stores => an
  // honest inline note; exactly one world loads immediately; several open the
  // picker. Tauri-only (the commands have no browser/fixture backend).
  async function scanXbox() {
    setXboxScanning(true);
    setXboxNote(null);
    setXboxWorlds(null);
    try {
      const stores = await invoke<XboxStore[]>("detect_xbox_stores");
      if (stores.length === 0) {
        setXboxNote("No Xbox Palworld save store found on this PC.");
        return;
      }
      const rows: XboxWorldRow[] = [];
      for (const store of stores) {
        try {
          const worlds = await invoke<XboxWorld[]>("list_xbox_worlds", {
            wgsDir: store.wgs_dir,
          });
          for (const w of worlds) rows.push({ ...w, wgsDir: store.wgs_dir });
        } catch {
          // Skip an unreadable store; the others may still list.
        }
      }
      if (rows.length === 0) {
        setXboxNote("No Palworld worlds found in the Xbox save store.");
        return;
      }
      if (rows.length === 1) {
        loadSave(encodeXboxSource(rows[0].wgsDir, rows[0].save_id));
        return;
      }
      setXboxWorlds(rows);
    } catch (e) {
      setXboxNote(`Couldn't read the Xbox save store: ${String(e)}`);
    } finally {
      setXboxScanning(false);
    }
  }

  const canLoad = !saveLoading && path.trim() !== "";

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-modal-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            Palworld save
          </div>
          <h2
            id="save-modal-title"
            className="mt-0.5 font-display text-lg font-bold tracking-wide text-ink"
          >
            Load your Palworld save
          </h2>
        </div>

        {recentSaves.length > 0 && (
          <div className="border-b border-line px-5 py-4">
            <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Recent saves
            </div>
            <ul className="flex flex-col gap-1.5">
              {recentSaves.map((r) => (
                <li key={r.dir}>
                  <button
                    onClick={() => loadSave(r.dir)}
                    disabled={saveLoading}
                    className="group flex w-full flex-col gap-0.5 rounded-md border border-line bg-raised/50 px-3 py-2 text-left transition-colors hover:border-amber/40 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[13px] font-medium text-ink group-hover:text-ink">
                        {r.worldName}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                        {relativeTime(r.lastLoaded)}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      <span className="text-ink-dim">{r.players}</span>{" "}
                      {r.players === 1 ? "player" : "players"}
                      <span className="mx-1 text-line">&middot;</span>
                      <span className="text-amber">{r.pals}</span> pals
                    </div>
                    <div
                      className="truncate font-mono text-[10px] text-ink-faint/80"
                      title={r.dir}
                    >
                      {r.dir}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Save folder
            </span>
            <div className="flex gap-2">
              <input
                autoFocus
                className="min-w-0 flex-1 rounded-md border border-line bg-abyss px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/60"
                placeholder={"\u2026/Saved/SaveGames/<id>/<world>"}
                value={path}
                onChange={(e) => setPath(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canLoad) {
                    e.preventDefault();
                    loadSave(path);
                  }
                }}
              />
              <button
                className="rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
                onClick={browse}
              >
                Browse
              </button>
            </div>
          </label>
          <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">
            Point at the world folder that contains{" "}
            <span className="font-mono text-ink-dim">Level.sav</span>. Nothing is
            written &mdash; the save is read only.
          </p>
          {saveError && (
            <div className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-bad">
              {saveError}
            </div>
          )}
          {caps.isTauri && (
            <div className="mt-3.5 border-t border-line pt-3.5">
              <button
                onClick={scanXbox}
                disabled={xboxScanning || saveLoading}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:border-amber/40 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {xboxScanning ? "Scanning\u2026" : "Xbox / Game Pass"}
              </button>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
                Reads the Game Pass save store on this PC. Read only &mdash;
                nothing is written.
              </p>
              {xboxNote && (
                <div className="mt-2 rounded-md border border-line bg-abyss/40 px-3 py-2 text-[12px] text-ink-dim">
                  {xboxNote}
                </div>
              )}
              <button
                onClick={() => {
                  setSftpReconnectData(null);
                  setSftpOpen(true);
                }}
                disabled={saveLoading}
                className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:border-amber/40 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                Dedicated server (SFTP)
              </button>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
                Load a world live from a Palworld dedicated server over SSH. Read
                only &mdash; nothing is written to your server.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1.5 text-[13px] font-medium text-ink-faint transition-colors hover:text-ink-dim"
          >
            Skip for now
          </button>
          <button
            onClick={() => loadSave(path)}
            disabled={!canLoad}
            className="rounded-md bg-amber px-4 py-1.5 text-[13px] font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveLoading ? "Loading\u2026" : "Load save"}
          </button>
        </div>
      </div>
    </div>
      {xboxWorlds && (
        <XboxWorldPicker
          worlds={xboxWorlds}
          onPick={(w) => {
            setXboxWorlds(null);
            loadSave(encodeXboxSource(w.wgsDir, w.save_id));
          }}
          onClose={() => setXboxWorlds(null)}
        />
      )}
      {sftpOpen && (
        <SftpConnectModal
          reconnect={sftpReconnectData}
          onClose={() => setSftpOpen(false)}
        />
      )}
    </>
  );
}

/** Last path segment of a POSIX/Windows path, for a compact world label. */
function baseName(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Dedicated-server (SFTP) connect + world-picker dialog. Desktop only. Mirrors
 * {@link SaveModal}/{@link XboxWorldPicker} chrome. Collects a connection
 * profile (host/port/user, password or key-file auth, remote path), invokes
 * `sftp_connect`, then either auto-loads a single/remembered world or shows a
 * picker. Secrets live only in this component's state — never persisted. On
 * boot-restore (`reconnect` set) it prefills the last profile, shows a
 * "Reconnect to load <world>" line, and auto-loads the remembered world when it
 * still appears in the scan.
 */
function SftpConnectModal({
  reconnect,
  onClose,
}: {
  reconnect: { worldDir: string; profile: SftpProfile | null } | null;
  onClose: () => void;
}) {
  const { loadSave } = useAppState();
  const initial = reconnect?.profile ?? readSftpProfile();
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [user, setUser] = useState(initial?.user ?? "");
  const [auth, setAuth] = useState<SftpAuth>(initial?.auth ?? "password");
  const [keyPath, setKeyPath] = useState(initial?.key_path ?? "");
  const [root, setRoot] = useState(initial?.root ?? "");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [phase, setPhase] = useState<"form" | "connecting" | "worlds">("form");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<SftpConnectInfo | null>(null);
  const [remember, setRemember] = useState(initial?.remember ?? false);
  // A secret already vaulted for this endpoint (loaded on a Remember reconnect).
  // Drives the "leave blank to use" placeholder and lets the one-click reconnect
  // / boot auto-login connect without re-typing. NEVER rendered; only merged
  // into the connect payload.
  const [storedSecret, setStoredSecret] = useState<SftpSecret | null>(null);
  const autoAttempted = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Boot auto-login: on a reconnect request whose profile opted into Remember,
  // load the vaulted secret and — when one exists — silently attempt the connect
  // (spinner, no typing). Any failure falls through to the manual prompt with an
  // inline error (connect's catch). Runs at most once, so there is no retry loop.
  useEffect(() => {
    if (autoAttempted.current) return;
    autoAttempted.current = true;
    const rc = reconnect;
    const profile = rc?.profile;
    if (!rc || !profile || !profile.remember) return;
    void (async () => {
      let secret: SftpSecret | null = null;
      try {
        secret = await invoke<SftpSecret | null>("sftp_secret_load", { profile });
      } catch {
        secret = null;
      }
      if (!secret) return;
      setStoredSecret(secret);
      const sentinel = encodeSftpSource(profile, rc.worldDir);
      if (sftpAutoLoginDecision(sentinel, profile, true) === "auto") {
        void connect(secret);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildProfile(): SftpProfile {
    return {
      host: host.trim(),
      port: Number(port) || 22,
      user: user.trim(),
      auth,
      key_path: auth === "key" ? keyPath.trim() || null : null,
      root: root.trim(),
      remember,
    };
  }

  // Native file picker for the private key (Tauri dialog plugin).
  async function pickKey() {
    try {
      const picked = await open({ multiple: false });
      if (typeof picked === "string") setKeyPath(picked);
    } catch {
      // No dialog plugin outside the Tauri webview — ignore.
    }
  }

  // Persist the (secret-free) profile and hand the sentinel to shared state,
  // which invokes `sftp_load_save` + arms the 60s poller.
  function proceed(profile: SftpProfile, world: { world_dir: string; world_name?: string | null }) {
    writeSftpProfile({ ...profile, last_world_name: world.world_name ?? null });
    loadSave(encodeSftpSource(profile, world.world_dir));
    onClose();
  }

  async function connect(secretOverride?: SftpSecret) {
    const profile = buildProfile();
    setPhase("connecting");
    setError(null);
    try {
      // Manual connect: fall back to the vaulted secret for any field left blank
      // (one-click reconnect). Boot auto-login passes the secret directly.
      const typed: SftpSecret = {
        password: auth === "password" ? password || null : null,
        key_passphrase: passphrase || null,
      };
      const secret: SftpSecret =
        secretOverride ??
        (storedSecret
          ? {
              password: typed.password ?? storedSecret.password,
              key_passphrase: typed.key_passphrase ?? storedSecret.key_passphrase,
            }
          : typed);
      const ci = await invoke<SftpConnectInfo>("sftp_connect", {
        profile,
        secret,
      });
      // Connect succeeded — honor the Remember toggle against the OS vault:
      // ticked stores the working secret; unticked scrubs any prior entry.
      try {
        if (remember) {
          await invoke("sftp_secret_store", { profile, secret });
        } else {
          await invoke("sftp_secret_forget", { profile });
        }
      } catch {
        // Vault write failed (locked keychain, etc.) — non-fatal; the live
        // connection stands regardless.
      }
      setInfo(ci);
      // Reconnect: auto-load the remembered world if the scan still lists it.
      const remembered = reconnect?.worldDir
        ? ci.worlds.find((w) => w.world_dir === reconnect.worldDir)
        : undefined;
      if (remembered) {
        proceed(profile, remembered);
        return;
      }
      if (ci.worlds.length === 1) {
        proceed(profile, ci.worlds[0]);
        return;
      }
      if (ci.worlds.length === 0) {
        setError(
          "No Palworld worlds found under that remote path. Try the folder that contains Level.sav (or any parent up to ~5 levels above it) — on most hosts that is /Pal/Saved/SaveGames.",
        );
        setPhase("form");
        return;
      }
      setPhase("worlds");
    } catch (e) {
      setError(String(e));
      setPhase("form");
    }
  }

  const connecting = phase === "connecting";
  const canConnect =
    !connecting &&
    host.trim() !== "" &&
    user.trim() !== "" &&
    root.trim() !== "" &&
    (auth === "password" || keyPath.trim() !== "");
  const reconnectLabel = reconnect
    ? initial?.last_world_name ||
      baseName(reconnect.worldDir) ||
      reconnect.worldDir
    : null;

  const inputClass =
    "min-w-0 flex-1 rounded-md border border-line bg-abyss px-3 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:border-amber/60";
  const fieldLabel =
    "font-mono text-[11px] uppercase tracking-wider text-ink-faint";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sftp-modal-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            Dedicated server (SFTP)
          </div>
          <h2
            id="sftp-modal-title"
            className="mt-0.5 font-display text-lg font-bold tracking-wide text-ink"
          >
            {phase === "worlds" ? "Choose a world" : "Connect to your server"}
          </h2>
          {reconnectLabel && (
            <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">
              Reconnect to load{" "}
              <span className="font-mono text-ink">{reconnectLabel}</span>
            </p>
          )}
        </div>

        {phase === "worlds" ? (
          <>
            {info && !info.known && (
              <div className="border-b border-line px-5 py-3">
                <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[12px] leading-relaxed text-ink-dim">
                  First connection &mdash; fingerprint pinned. If it changes later
                  we refuse and warn.
                  <div className="mt-1 truncate font-mono text-[10px] text-ink-faint">
                    {info.fingerprint}
                  </div>
                </div>
              </div>
            )}
            <ul className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto px-5 py-4">
              {(info?.worlds ?? []).map((w) => (
                <li key={w.world_dir}>
                  <button
                    onClick={() => proceed(buildProfile(), w)}
                    className="group flex w-full items-center justify-between gap-3 rounded-md border border-line bg-raised/50 px-3 py-2 text-left transition-colors hover:border-amber/40 hover:bg-hover"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-ink">
                        {w.world_name || baseName(w.world_dir)}
                      </div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                        <span className="text-ink-dim">{w.players}</span>{" "}
                        {w.players === 1 ? "player" : "players"}
                        <span className="mx-1 text-line">&middot;</span>
                        {relativeTime(w.mtime_ms)}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="flex gap-2">
              <label className="flex flex-[3] flex-col gap-1.5">
                <span className={fieldLabel}>Host</span>
                <input
                  autoFocus
                  className={inputClass}
                  placeholder="server.example.com"
                  value={host}
                  disabled={connecting}
                  onChange={(e) => setHost(e.currentTarget.value)}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1.5">
                <span className={fieldLabel}>Port</span>
                <input
                  className={inputClass}
                  inputMode="numeric"
                  placeholder="22"
                  value={port}
                  disabled={connecting}
                  onChange={(e) => setPort(e.currentTarget.value)}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>User</span>
              <input
                className={inputClass}
                placeholder="steam"
                value={user}
                disabled={connecting}
                onChange={(e) => setUser(e.currentTarget.value)}
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Authentication</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setAuth("password")}
                  disabled={connecting}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                    auth === "password"
                      ? "border-amber/60 bg-amber/10 text-ink"
                      : "border-line bg-raised text-ink-dim hover:bg-hover"
                  }`}
                >
                  Password
                </button>
                <button
                  type="button"
                  onClick={() => setAuth("key")}
                  disabled={connecting}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                    auth === "key"
                      ? "border-amber/60 bg-amber/10 text-ink"
                      : "border-line bg-raised text-ink-dim hover:bg-hover"
                  }`}
                >
                  Key file
                </button>
              </div>
            </div>
            {auth === "password" ? (
              <label className="flex flex-col gap-1.5">
                <span className={fieldLabel}>Password</span>
                <input
                  className={inputClass}
                  type="password"
                  autoComplete="off"
                  placeholder={
                    storedSecret?.password
                      ? "saved \u2014 leave blank to use"
                      : "\u2026"
                  }
                  value={password}
                  disabled={connecting}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                />
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>Private key file</span>
                  <div className="flex gap-2">
                    <input
                      className={inputClass}
                      placeholder="\u2026/.ssh/id_ed25519"
                      value={keyPath}
                      disabled={connecting}
                      onChange={(e) => setKeyPath(e.currentTarget.value)}
                    />
                    <button
                      type="button"
                      onClick={pickKey}
                      disabled={connecting}
                      className="rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
                    >
                      Browse
                    </button>
                  </div>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={fieldLabel}>Key passphrase (optional)</span>
                  <input
                    className={inputClass}
                    type="password"
                    autoComplete="off"
                    placeholder={
                      storedSecret?.key_passphrase
                        ? "saved \u2014 leave blank to use"
                        : "\u2026"
                    }
                    value={passphrase}
                    disabled={connecting}
                    onChange={(e) => setPassphrase(e.currentTarget.value)}
                  />
                </label>
              </>
            )}
            <label className="flex items-center gap-2 text-[12px] text-ink-dim">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-amber disabled:opacity-30"
                checked={remember}
                disabled={connecting}
                onChange={(e) => setRemember(e.currentTarget.checked)}
              />
              <span>
                Remember password
                <span className="ml-1 text-ink-faint">
                  &mdash; kept in your OS credential vault
                </span>
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={fieldLabel}>Remote path</span>
              <input
                className={inputClass}
                placeholder="/home/steam/Pal/Saved/SaveGames"
                value={root}
                disabled={connecting}
                onChange={(e) => setRoot(e.currentTarget.value)}
              />
              <span className="text-[12px] leading-relaxed text-ink-faint">
                The world folder, or its SaveGames parent &mdash; we scan for{" "}
                <span className="font-mono text-ink-dim">Level.sav</span>.
              </span>
            </label>
            {error && (
              <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] leading-relaxed text-bad">
                {error}
              </div>
            )}
          </div>
        )}

        <div className="border-t border-line px-5 py-3">
          <p className="text-[12px] leading-relaxed text-ink-faint">
            Read-only - Pal Lab never writes to your server. Save changes are
            picked up by polling every 60s.
          </p>
        </div>

        {phase !== "worlds" && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
            <button
              onClick={onClose}
              className="rounded-md px-2 py-1.5 text-[13px] font-medium text-ink-faint transition-colors hover:text-ink-dim"
            >
              Cancel
            </button>
            <button
              onClick={() => connect()}
              disabled={!canConnect}
              className="rounded-md bg-amber px-4 py-1.5 text-[13px] font-semibold text-abyss transition-colors hover:bg-amber-bright disabled:cursor-not-allowed disabled:opacity-50"
            >
              {connecting ? "Connecting\u2026" : "Connect"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Xbox world picker. Shown only when a store holds more than one world (a lone
 * world loads immediately). Mirrors {@link ScopeModal}'s modal chrome. Rows show
 * the world name (falling back to the raw save id), player count and last-write
 * age. Picking builds the `xbox://` sentinel and hands it to `loadSave`.
 */
function XboxWorldPicker({
  worlds,
  onPick,
  onClose,
}: {
  worlds: XboxWorldRow[];
  onPick: (world: XboxWorldRow) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="xbox-modal-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            Xbox / Game Pass
          </div>
          <h2
            id="xbox-modal-title"
            className="mt-0.5 font-display text-lg font-bold tracking-wide text-ink"
          >
            Choose a world
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
            Read from the Game Pass save store on this PC. Nothing is written
            &mdash; the save is read only.
          </p>
        </div>

        <ul className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto px-5 py-4">
          {worlds.map((w) => (
            <li key={`${w.wgsDir}#${w.save_id}`}>
              <button
                onClick={() => onPick(w)}
                className="group flex w-full items-center justify-between gap-3 rounded-md border border-line bg-raised/50 px-3 py-2 text-left transition-colors hover:border-amber/40 hover:bg-hover"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">
                    {w.world_name || w.save_id}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                    <span className="text-ink-dim">{w.player_count}</span>{" "}
                    {w.player_count === 1 ? "player" : "players"}
                    <span className="mx-1 text-line">&middot;</span>
                    {relativeTime(w.mtime_ms)}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Player-scope dialog. Asks "who plays this world?" — one row per player (name,
 * short uid hex, owned-pal count) plus an "All players" option. Picking sets the
 * scope (persisted per save dir) and closes. Auto-opened once for a fresh
 * multi-player world; also reachable from the sidebar scope pill.
 */
function ScopeModal({ onClose }: { onClose: () => void }) {
  const { saveSummary, playerScope, setPlayerScope } = useAppState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Owned-pal count per player uid (null-owner / guild-stock pals excluded, as
  // the scope filter itself excludes them).
  const ownedByUid = new Map<string, number>();
  for (const pal of saveSummary?.pals ?? []) {
    if (!pal.owner_player_uid) continue;
    const hex = hexGuid(pal.owner_player_uid);
    ownedByUid.set(hex, (ownedByUid.get(hex) ?? 0) + 1);
  }

  function pick(scope: string) {
    setPlayerScope(scope);
    onClose();
  }

  const players = saveSummary?.players ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/70 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scope-modal-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-4">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">
            Player scope
          </div>
          <h2
            id="scope-modal-title"
            className="mt-0.5 font-display text-lg font-bold tracking-wide text-ink"
          >
            Who plays this world?
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
            Scopes the solver, donors and Pal-dex counts to one player's pals.
            Change it any time from the scope pill.
          </p>
        </div>

        <ul className="flex flex-col gap-1.5 px-5 py-4">
          {players.map((p) => {
            const active = playerScope === p.uid;
            return (
              <li key={p.uid}>
                <button
                  onClick={() => pick(p.uid)}
                  className={`group flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                    active
                      ? "border-amber/50 bg-amber/10"
                      : "border-line bg-raised/50 hover:border-amber/40 hover:bg-hover"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-ink">
                      {p.name || "Unnamed player"}
                    </div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      {p.uid.slice(0, 8)}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                    <span className="text-amber">{ownedByUid.get(p.uid) ?? 0}</span>{" "}
                    pals
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              onClick={() => pick("all")}
              className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                playerScope === "all"
                  ? "border-amber/50 bg-amber/10"
                  : "border-line bg-raised/50 hover:border-amber/40 hover:bg-hover"
              }`}
            >
              <span className="text-[13px] font-medium text-ink">All players</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                <span className="text-amber">{saveSummary?.pals.length ?? 0}</span>{" "}
                pals
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}

function Shell() {
  const {
    view,
    setView,
    saveSummary,
    booting,
    toast,
    playerScope,
    scopePromptOpen,
    setScopePromptOpen,
    clearSave,
  } = useAppState();
  const [modalOpen, setModalOpen] = useState(false);
  const [rereading, setRereading] = useState(false);
  // Human-readable label for the active scope pill: the player's name, or "All".
  const scopeLabel =
    playerScope === "all"
      ? "All"
      : saveSummary?.players.find((p) => p.uid === playerScope)?.name ||
        playerScope.slice(0, 8);

  // Close the startup modal automatically once a save has loaded.
  useEffect(() => {
    if (saveSummary) setModalOpen(false);
  }, [saveSummary]);

  // Boot resolved with no save — open the startup modal (desktop/fixture). Web
  // shows the full-pane WebDropZone instead, so the modal stays closed there.
  useEffect(() => {
    if (!booting && !saveSummary && !caps.isWeb) setModalOpen(true);
  }, [booting, saveSummary]);

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
              PAL&middot;LAB
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

        <div className="mt-auto px-3 pb-4 pt-3">
          {saveSummary ? (
            <div className="rounded-md border border-line bg-raised/50 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div
                    className="truncate text-[13px] font-medium text-ink"
                    title={saveSummary.world_name}
                  >
                    {saveSummary.world_name}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                    <span className="text-ink-dim">
                      {saveSummary.players.length}
                    </span>{" "}
                    {saveSummary.players.length === 1 ? "player" : "players"}
                    <span className="mx-1 text-line">&middot;</span>
                    <span className="text-amber">{saveSummary.pals.length}</span>{" "}
                    pals
                  </div>
                </div>
                <button
                  onClick={() => (caps.isWeb ? clearSave() : setModalOpen(true))}
                  title="Switch save"
                  aria-label="Switch save"
                  className="shrink-0 rounded-md border border-line bg-raised p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                >
                  <SwapIcon />
                </button>
              </div>
              {saveSummary.players.length > 1 && (
                <button
                  onClick={() => setScopePromptOpen(true)}
                  title="Change player scope"
                  className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-line bg-abyss/60 px-2.5 py-1.5 font-mono text-[10px] tracking-wider text-ink-faint transition-colors hover:border-amber/40 hover:text-ink"
                >
                  <span className="uppercase text-ink-faint">Scope:</span>
                  <span className="truncate text-amber">{scopeLabel}</span>
                </button>
              )}
              {caps.isWeb && canReread() && (
                <button
                  onClick={() => {
                    setRereading(true);
                    rereadWebSave().finally(() => setRereading(false));
                  }}
                  disabled={rereading}
                  title="Re-read the save folder"
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-line bg-abyss/60 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint transition-colors hover:border-amber/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {rereading ? "Re-reading\u2026" : "Re-read folder"}
                </button>
              )}
            </div>
          ) : caps.isWeb ? null : (
            <button
              onClick={() => setModalOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-[13px] font-medium text-ink-dim transition-colors hover:border-amber/40 hover:bg-hover hover:text-ink"
            >
              <FolderIcon />
              Load save
            </button>
          )}
          <AboutButton />
        </div>
      </nav>

      <main className="flex-1 overflow-hidden">
        {caps.isWeb && !saveSummary ? (
          <WebDropZone />
        ) : (
          <ErrorBoundary key={view} onReset={() => setView("save")}>
            {view === "save" && <SaveInspector />}
            {view === "solver" && <Solver />}
            {view === "ivlab" && <IvLab />}
            {view === "paldex" && <Paldex />}
            {view === "worldmap" && <MapView />}
          </ErrorBoundary>
        )}
      </main>
      {modalOpen && !caps.isWeb && <SaveModal onClose={() => setModalOpen(false)} />}
      {scopePromptOpen && (
        <ScopeModal onClose={() => setScopePromptOpen(false)} />
      )}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-md border border-amber/40 bg-raised px-3.5 py-2 text-[12px] font-medium text-ink"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber" />
          {toast.text}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}
