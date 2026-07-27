// Ambient declarations for the File System Access API surface Pal Lab's web
// save-loading uses (lib/save-drop.ts). TS's lib.dom ships `FileSystemHandle` /
// `FileSystemDirectoryHandle` (via drag-drop) but omits the non-standard
// directory picker, the async `entries()` iterator, and the permission methods.
// No imports/exports here — this file stays a global script so the interface
// declarations merge into lib.dom rather than shadowing it.

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: string | FileSystemHandle;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

interface DataTransferItem {
  // Chromium-only: yields a live handle for a dropped folder (kind
  // "directory") so it can be persisted for re-reads. Absent in Firefox/Safari.
  getAsFileSystemHandle(): Promise<FileSystemHandle | null>;
}

interface Window {
  showDirectoryPicker(
    options?: DirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>;
}
