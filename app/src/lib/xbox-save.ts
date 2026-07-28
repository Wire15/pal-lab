// Desktop Xbox / Game Pass save source. A loaded Xbox world has no filesystem
// folder path, so it is identified by a *sentinel* string stored in the same
// slot as a folder path (localStorage `pal-lab.saveDir`, the recents list, and
// `AppState.saveDir`). Everything that persists or invokes with a save path
// treats the sentinel like any other string; the desktop Rust commands decode
// it (see `crate::xbox::parse_sentinel`, which mirrors `decodeXboxSource`).
//
// Format: `xbox://<wgsDir>#<saveId>`
//   - wgsDir: absolute path to the per-user WGS store dir (holds containers.index)
//   - saveId: the 32-hex world-folder GUID (never contains '#')
//
// The decoder splits on the LAST '#' so a wgsDir that itself contains '#' still
// resolves its trailing hex saveId — matching the Rust `rsplit_once('#')`.

/** Sentinel scheme marking a save source as an Xbox WGS world. */
export const XBOX_SENTINEL_PREFIX = "xbox://";

/** A decoded Xbox save source. */
export interface XboxSource {
  wgsDir: string;
  saveId: string;
}

/** A discovered Xbox store (from `detect_xbox_stores`). Fields are snake_case
 *  to match the Rust `XboxStore` serde shape. */
export interface XboxStore {
  wgs_dir: string;
  user_id: string;
}

/** One world inside a store (from `list_xbox_worlds`). snake_case to match the
 *  Rust `XboxWorld` serde shape. */
export interface XboxWorld {
  save_id: string;
  world_name: string | null;
  mtime_ms: number;
  player_count: number;
}

/** A world row for the picker: an `XboxWorld` plus the store it came from. */
export interface XboxWorldRow extends XboxWorld {
  wgsDir: string;
}

/** Build the sentinel for an Xbox world source. */
export function encodeXboxSource(wgsDir: string, saveId: string): string {
  return `${XBOX_SENTINEL_PREFIX}${wgsDir}#${saveId}`;
}

/** Decode an `xbox://<wgsDir>#<saveId>` sentinel, or null when `dir` is a plain
 *  path (no scheme) or malformed (scheme but no '#'). */
export function decodeXboxSource(dir: string): XboxSource | null {
  if (!dir.startsWith(XBOX_SENTINEL_PREFIX)) return null;
  const rest = dir.slice(XBOX_SENTINEL_PREFIX.length);
  const hash = rest.lastIndexOf("#");
  if (hash < 0) return null;
  return { wgsDir: rest.slice(0, hash), saveId: rest.slice(hash + 1) };
}
