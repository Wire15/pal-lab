// Desktop SFTP save source: a Palworld world loaded live from a dedicated
// server over SSH. Like the Xbox source, an SFTP world has no local filesystem
// folder, so it is identified by a *sentinel* string stored in the same slot as
// a folder path (localStorage `pal-lab.saveDir`, the recents list, and
// `AppState.saveDir`). Everything that persists or invokes with a save path
// treats the sentinel like any other string; the desktop Rust commands decode
// it (mirrors `decodeSftpSource` / Rust `rsplit_once('#')`).
//
// Format: `sftp://<user>@<host>:<port>#<remoteWorldDir>`
//   - user/host/port: the SSH connection endpoint
//   - remoteWorldDir: absolute remote path of the folder containing Level.sav
//
// The decoder splits on the LAST '#' so a remote path that itself contains '#'
// still resolves — matching the Rust `rsplit_once('#')`. Secrets (password, key
// passphrase) are NEVER part of the sentinel and NEVER persisted; only the
// non-secret profile is stored (see read/writeSftpProfile).

/** Sentinel scheme marking a save source as a live SFTP dedicated-server save. */
export const SFTP_SENTINEL_PREFIX = "sftp://";

/** SSH auth method. */
export type SftpAuth = "password" | "key";

/** Connection profile (no secrets). snake_case fields match the Rust
 *  `SftpProfile` serde shape (no rename_all). `root` is the remote dir to
 *  scan: a world dir, a SaveGames dir, or a server base dir. */
export interface SftpProfile {
  host: string;
  port: number;
  user: string;
  auth: SftpAuth;
  key_path: string | null;
  root: string;
  /** Display name of the last-loaded world (prettifies the reconnect prompt).
   *  Never sent to the backend — buildProfile constructs invoke payloads fresh. */
  last_world_name?: string | null;
}

/** Connection secrets — memory only, NEVER persisted. snake_case matches the
 *  Rust `SftpSecret` serde shape. */
export interface SftpSecret {
  password: string | null;
  key_passphrase: string | null;
}

/** One discovered world from a connect scan. snake_case matches the Rust
 *  `SftpWorld` serde shape. */
export interface SftpWorld {
  world_dir: string;
  world_name: string | null;
  players: number;
  mtime_ms: number;
}

/** Result of `sftp_connect`: the pinned/observed host key fingerprint, whether
 *  it matched the stored one (known:true = matched a prior stored entry;
 *  known:false = first-ever-seen, just pinned this call), and the worlds found
 *  under `root`. A fingerprint MISMATCH is not represented here — `sftp_connect`
 *  returns Err instead and no connection is established. snake_case matches the
 *  Rust `SftpConnectInfo` serde shape. */
export interface SftpConnectInfo {
  fingerprint: string;
  known: boolean;
  worlds: SftpWorld[];
}

/** Build the sentinel for an SFTP world source from the connection endpoint. */
export function encodeSftpSource(
  profile: Pick<SftpProfile, "user" | "host" | "port">,
  worldDir: string,
): string {
  return `${SFTP_SENTINEL_PREFIX}${profile.user}@${profile.host}:${profile.port}#${worldDir}`;
}

/** A decoded SFTP save source. */
export interface SftpSource {
  user: string;
  host: string;
  port: number;
  worldDir: string;
}

/** Decode an `sftp://<user>@<host>:<port>#<worldDir>` sentinel, or null when
 *  `dir` is a plain path / other scheme, or is malformed. Splits on the LAST
 *  '#' so a '#' inside the remote path survives (matches Rust `rsplit_once`). */
export function decodeSftpSource(dir: string): SftpSource | null {
  if (!dir.startsWith(SFTP_SENTINEL_PREFIX)) return null;
  const rest = dir.slice(SFTP_SENTINEL_PREFIX.length);
  const hash = rest.lastIndexOf("#");
  if (hash < 0) return null;
  const endpoint = rest.slice(0, hash);
  const worldDir = rest.slice(hash + 1);
  const at = endpoint.lastIndexOf("@");
  if (at < 0) return null;
  const user = endpoint.slice(0, at);
  const hostPort = endpoint.slice(at + 1);
  const colon = hostPort.lastIndexOf(":");
  if (colon < 0) return null;
  const host = hostPort.slice(0, colon);
  const port = Number(hostPort.slice(colon + 1));
  if (!user || !host || !Number.isFinite(port)) return null;
  return { user, host, port, worldDir };
}

/** localStorage key for the last-used SFTP profile (no secrets). */
export const SFTP_PROFILE_KEY = "pal-lab.sftpProfile";

/** Persist the non-secret connection profile for prefilling the connect modal
 *  and boot-restore reconnect. Only the profile fields are written — never
 *  a password or key passphrase, even if the caller hands over an object that
 *  happens to carry them. */
export function writeSftpProfile(profile: SftpProfile): void {
  try {
    const safe: SftpProfile = {
      host: profile.host,
      port: profile.port,
      user: profile.user,
      auth: profile.auth,
      key_path: profile.key_path,
      root: profile.root,
      last_world_name: profile.last_world_name ?? null,
    };
    localStorage.setItem(SFTP_PROFILE_KEY, JSON.stringify(safe));
  } catch {
    // Ignore storage failures (private mode, quota) — non-fatal.
  }
}

/** Read the last-used SFTP profile, or null when none is stored / unreadable. */
export function readSftpProfile(): SftpProfile | null {
  try {
    const raw = localStorage.getItem(SFTP_PROFILE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    return {
      host: String(o.host ?? ""),
      port: Number(o.port) || 22,
      user: String(o.user ?? ""),
      auth: o.auth === "key" ? "key" : "password",
      key_path: o.key_path != null ? String(o.key_path) : null,
      root: String(o.root ?? ""),
    };
  } catch {
    return null;
  }
}

/** What the boot auto-load should do with the persisted `saveDir`. Pure so it
 *  is unit-testable: an SFTP sentinel MUST NOT auto-load blind (there is no
 *  live connection on boot) — it prompts a reconnect instead; anything else
 *  (folder or Xbox sentinel) loads through the normal path. */
export type BootRestore =
  | { kind: "none" }
  | { kind: "load"; dir: string }
  | { kind: "sftp"; worldDir: string; profile: SftpProfile | null };

/** Decide the boot-restore action for a persisted `saveDir` + stored profile. */
export function bootRestoreAction(
  lastSaveDir: string,
  profile: SftpProfile | null,
): BootRestore {
  const dir = lastSaveDir.trim();
  if (!dir) return { kind: "none" };
  const sftp = decodeSftpSource(dir);
  if (sftp) return { kind: "sftp", worldDir: sftp.worldDir, profile };
  return { kind: "load", dir };
}
