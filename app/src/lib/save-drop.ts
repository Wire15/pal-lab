// Web-mode save acquisition. The desktop app hands the backend a filesystem
// path; a browser has no such path, so this module turns a dropped folder (or a
// File System Access directory pick, or an <input webkitdirectory>) into the
// in-memory `{ paths, buffers }` bundle the wasm `load_save_bundle` expects.
//
// It locates the directory that actually contains `Level.sav` (at any depth —
// people drop the whole `SaveGames` tree), then collects exactly the files the
// native reader reads, keyed folder-relative to that directory:
//   Level.sav          (required)
//   LevelMeta.sav      (world name; optional)
//   LocalData.sav      (map fog + markers; optional)
//   WorldOption.sav    (egg-hatch option; optional)
//   Players/*.sav      (party/palbox classification + *_dps.sav storage)
//
// `backup/` subdirectories (Palworld keeps rolling save copies there) are
// skipped so a stale Level.sav never wins, and the total is hard-capped so a
// mis-drop of a huge tree can't exhaust memory. A File System Access pick keeps
// its directory handle so "Re-read folder" can re-scan in place; a drag-drop or
// <input> has no persistent handle, so re-reading prompts a re-drop.

/** Files the native reader consumes, matched folder-relative to the save dir. */
const WANTED_ROOT = new Set([
  "Level.sav",
  "LevelMeta.sav",
  "LocalData.sav",
  "WorldOption.sav",
]);
/** Any `.sav` directly under `Players/` (party saves + `*_dps.sav` storage). */
const PLAYERS_SAV = /^Players\/[^/]+\.sav$/i;
/** Directory name whose contents are ignored (rolling save backups). */
const SKIP_DIR = "backup";
/** Hard cap on the summed bundle size (bytes). */
const MAX_BUNDLE_BYTES = 400 * 1024 * 1024;

/** The active save source. A handle can be re-read in place; a collected file
 *  map (drop / <input>) is a one-shot snapshot. */
type Source =
  | { kind: "handle"; handle: FileSystemDirectoryHandle; rootLabel: string }
  | { kind: "files"; files: Map<string, File>; rootLabel: string };

let source: Source | null = null;

/** The chosen bundle: folder-relative paths and their matching File objects. */
interface Selection {
  paths: string[];
  files: File[];
  /** Basename of the directory holding Level.sav (the world folder). */
  label: string;
}

/** True when the browser exposes the File System Access directory picker (keeps
 *  a re-readable handle). Chromium-family only; other browsers use drop/<input>. */
export function isFsAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function"
  );
}

/** Whether the current source can be re-read without user re-interaction. */
export function canReread(): boolean {
  return source?.kind === "handle";
}

/** The live directory handle when the current source is a re-readable pick (or a
 *  restored handle), else null. Lets the web dropzone persist it across visits. */
export function currentHandle(): FileSystemDirectoryHandle | null {
  return source?.kind === "handle" ? source.handle : null;
}

/** Human label for the loaded save (world folder name), or "" when none. */
export function currentLabel(): string {
  return source?.rootLabel ?? "";
}

// ------------------------------------------------------------------ acquire */

/** Prompt the OS directory picker, validate it holds a save, and store the
 *  handle for later re-reads. Returns the world label, or null if the user
 *  cancelled. Throws with friendly copy when the folder holds no `Level.sav`.
 *
 *  The `id` makes Chromium remember the last-picked location for this picker
 *  (per-origin), so repeat visits reopen where the user left off — the closest
 *  the web platform allows to defaulting into the save directory (arbitrary
 *  `startIn` paths are deliberately unsupported). Note Chromium's blocklist
 *  refuses picks inside AppData outright ("contains system files"); the
 *  dropzone offers the classic <input webkitdirectory> dialog as the escape
 *  hatch for that. */
export async function pickDirectory(): Promise<string | null> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({
      mode: "read",
      id: "palworld-save",
    });
  } catch {
    // AbortError on cancel (and SecurityError outside a user gesture) — treat as
    // "nothing picked" rather than an error surface.
    return null;
  }
  return acceptHandle(handle);
}

/** Install a previously-stored (or freshly-picked) directory handle as the active
 *  source, walking it to confirm it still holds a Level.sav. Returns the world
 *  label. Read permission must already be granted by the caller. */
export async function acceptHandle(
  handle: FileSystemDirectoryHandle,
): Promise<string> {
  const files = new Map<string, File>();
  await walkHandle(handle, "", files);
  const selection = select(files, handle.name);
  source = { kind: "handle", handle, rootLabel: selection.label };
  return selection.label;
}

/** Ingest a drag-drop of a folder. Returns the world label. Throws friendly copy
 *  when the drop holds no `Level.sav`. */
export async function acceptDrop(dt: DataTransfer): Promise<string> {
  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) roots.push(entry);
  }
  const files = new Map<string, File>();
  let rootLabel = "";
  for (const entry of roots) {
    if (entry.isDirectory && !rootLabel) rootLabel = entry.name;
    await walkEntry(entry, "", files);
  }
  const selection = select(files, rootLabel || "save");
  source = { kind: "files", files, rootLabel: selection.label };
  return selection.label;
}

/** Ingest an `<input type="file" webkitdirectory>` selection (the fallback when
 *  File System Access is unavailable). Returns the world label. */
export async function acceptInput(list: FileList): Promise<string> {
  const files = new Map<string, File>();
  let rootLabel = "";
  for (const file of Array.from(list)) {
    // webkitRelativePath is "<rootDir>/.../name"; drop the leading root segment
    // so paths line up with the drag-drop tree (root name becomes the label).
    const rel = file.webkitRelativePath || file.name;
    const slash = rel.indexOf("/");
    if (slash > 0 && !rootLabel) rootLabel = rel.slice(0, slash);
    const path = slash >= 0 ? rel.slice(slash + 1) : rel;
    if (!path.toLowerCase().endsWith(".sav")) continue;
    if (path.split("/").some((seg) => seg.toLowerCase() === SKIP_DIR)) continue;
    files.set(path, file);
  }
  const selection = select(files, rootLabel || "save");
  source = { kind: "files", files, rootLabel: selection.label };
  return selection.label;
}

/** Install a byte snapshot (restored from IndexedDB — see lib/idb-snapshot.ts) as
 *  the active source. Powers the universal "Restore <folder>" path on browsers
 *  without a re-readable directory handle. `paths` are already folder-relative to
 *  the save dir, so we rebuild a `path -> File` map (naming each File by its base
 *  name) and let `select()` re-derive the identical selection at read time.
 *  Returns the label. */
export function acceptSnapshot(
  paths: string[],
  buffers: ArrayBuffer[],
  label: string,
): string {
  const files = new Map<string, File>();
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    const base = path.split("/").pop() || path;
    files.set(path, new File([buffers[i]!], base));
  }
  source = { kind: "files", files, rootLabel: label };
  return label;
}

// ------------------------------------------------------------------ read */

/** Materialize the current source into the wasm bundle. For a handle source this
 *  re-walks the folder (picking up external changes — the web "watcher"); for a
 *  file-map source it re-reads the snapshot captured at drop time. */
export async function readBundle(): Promise<{
  paths: string[];
  buffers: ArrayBuffer[];
}> {
  if (!source) throw new Error("No save folder loaded.");
  let selection: Selection;
  if (source.kind === "handle") {
    if (!(await ensureReadPermission(source.handle))) {
      throw new Error("Permission to read the save folder was denied.");
    }
    const files = new Map<string, File>();
    await walkHandle(source.handle, "", files);
    selection = select(files, source.handle.name);
  } else {
    selection = select(source.files, source.rootLabel);
  }
  const total = selection.files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Save bundle is ${(total / 1024 / 1024).toFixed(0)} MB — over the ${
        MAX_BUNDLE_BYTES / 1024 / 1024
      } MB limit.`,
    );
  }
  const buffers = await Promise.all(selection.files.map((f) => f.arrayBuffer()));
  return { paths: selection.paths, buffers };
}

// ------------------------------------------------------------------ select */

/** Pick the wanted files out of a collected `path -> File` map, re-keyed
 *  relative to the directory that holds `Level.sav`. Throws when none is found. */
function select(files: Map<string, File>, rootLabel: string): Selection {
  // Shallowest Level.sav wins — the live save, not a nested backup copy.
  let levelPath: string | null = null;
  for (const path of files.keys()) {
    if (!/(^|\/)Level\.sav$/i.test(path)) continue;
    if (levelPath === null || depth(path) < depth(levelPath)) levelPath = path;
  }
  if (levelPath === null) {
    throw new Error(
      "No Level.sav found — drop the world folder inside SaveGames.",
    );
  }
  const cut = levelPath.lastIndexOf("/");
  const prefix = cut >= 0 ? levelPath.slice(0, cut + 1) : "";
  const dirName = cut >= 0 ? levelPath.slice(0, cut).split("/").pop() ?? "" : "";

  const paths: string[] = [];
  const picked: File[] = [];
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (WANTED_ROOT.has(rel) || PLAYERS_SAV.test(rel)) {
      paths.push(rel);
      picked.push(file);
    }
  }
  return { paths, files: picked, label: dirName || rootLabel };
}

function depth(path: string): number {
  let n = 0;
  for (const ch of path) if (ch === "/") n++;
  return n;
}

// ------------------------------------------------------------------ walk */

/** Recursively collect `.sav` files under a drag-drop FileSystemEntry tree,
 *  skipping `backup/` directories. Keys are relative to the dropped root. */
async function walkEntry(
  entry: FileSystemEntry,
  path: string,
  out: Map<string, File>,
): Promise<void> {
  const here = path ? `${path}/${entry.name}` : entry.name;
  if (entry.isFile) {
    if (!entry.name.toLowerCase().endsWith(".sav")) return;
    // Well-known DOM narrowing (isFile guards it); the lib has no discriminant.
    const fileEntry = entry as FileSystemFileEntry;
    out.set(here, await fileFromEntry(fileEntry));
    return;
  }
  if (entry.isDirectory) {
    if (entry.name.toLowerCase() === SKIP_DIR) return;
    const dirEntry = entry as FileSystemDirectoryEntry;
    for (const child of await readAllEntries(dirEntry)) {
      await walkEntry(child, here, out);
    }
  }
}

/** Recursively collect `.sav` files under a File System Access directory handle,
 *  skipping `backup/` directories. Keys are relative to `handle`. */
async function walkHandle(
  dir: FileSystemDirectoryHandle,
  path: string,
  out: Map<string, File>,
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    const here = path ? `${path}/${name}` : name;
    if (handle.kind === "file") {
      if (!name.toLowerCase().endsWith(".sav")) continue;
      const fileHandle = handle as FileSystemFileHandle;
      out.set(here, await fileHandle.getFile());
    } else {
      if (name.toLowerCase() === SKIP_DIR) continue;
      const subDir = handle as FileSystemDirectoryHandle;
      await walkHandle(subDir, here, out);
    }
  }
}

/** Drain a DirectoryReader (which returns entries in bounded batches). */
function readAllEntries(
  dir: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<FileSystemEntry[]>();
  const readBatch = () => {
    reader.readEntries((batch) => {
      if (batch.length === 0) {
        resolve(all);
        return;
      }
      all.push(...batch);
      readBatch();
    }, reject);
  };
  readBatch();
  return promise;
}

/** Promise wrapper over FileSystemFileEntry.file's callback form. */
function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  const { promise, resolve, reject } = Promise.withResolvers<File>();
  entry.file(resolve, reject);
  return promise;
}

/** Ensure (re-)read permission on a stored handle, prompting once if needed. */
async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const opts = { mode: "read" } as const;
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}
