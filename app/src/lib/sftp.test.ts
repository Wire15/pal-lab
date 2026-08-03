// Unit tests for the SFTP save-source codec, profile persistence, and the
// boot-restore decision. Run with `bun test`. `bun:test` type-resolves via
// app/src/bun-test.d.ts (no @types/bun here).
import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  SFTP_PROFILE_KEY,
  SFTP_SENTINEL_PREFIX,
  type SftpProfile,
  bootRestoreAction,
  decodeSftpSource,
  encodeSftpSource,
  readSftpProfile,
  writeSftpProfile,
} from "./sftp";

const PROFILE: SftpProfile = {
  host: "server.example.com",
  port: 2222,
  user: "steam",
  auth: "key",
  key_path: "/home/me/.ssh/id_ed25519",
  root: "/home/steam/Pal/Saved/SaveGames",
};
const WORLD = "/home/steam/Pal/Saved/SaveGames/0/ABCDEF0123456789";

// ---- codec --------------------------------------------------------------

test("encodeSftpSource builds the sftp:// sentinel from the endpoint", () => {
  expect(encodeSftpSource(PROFILE, WORLD)).toBe(
    `${SFTP_SENTINEL_PREFIX}steam@server.example.com:2222#${WORLD}`,
  );
});

test("decodeSftpSource round-trips an encoded sentinel", () => {
  const decoded = decodeSftpSource(encodeSftpSource(PROFILE, WORLD));
  expect(decoded).toEqual({
    user: "steam",
    host: "server.example.com",
    port: 2222,
    worldDir: WORLD,
  });
});

test("decodeSftpSource returns null for a plain folder path or other scheme", () => {
  expect(decodeSftpSource("C:/Palworld/Saved/SaveGames/0/ABC")).toBeNull();
  expect(decodeSftpSource("/home/me/save")).toBeNull();
  expect(decodeSftpSource("xbox://C:/wgs/AAAA#0001")).toBeNull();
});

test("decodeSftpSource returns null for a scheme with no '#'", () => {
  expect(decodeSftpSource("sftp://steam@host:22")).toBeNull();
});

test("decodeSftpSource returns null when the endpoint lacks user@ or :port", () => {
  expect(decodeSftpSource("sftp://host:22#/w")).toBeNull();
  expect(decodeSftpSource("sftp://steam@host#/w")).toBeNull();
  expect(decodeSftpSource("sftp://steam@host:abc#/w")).toBeNull();
});

test("decodeSftpSource splits on the LAST '#' (matches Rust rsplit_once)", () => {
  // rsplit at the last '#': the tail is worldDir, the head must still parse as
  // user@host:port. An embedded '#' in the remote path leaves a non-numeric
  // port in the head, so decode rejects it (null) rather than mis-parsing —
  // consistent with the Rust side, which splits identically.
  expect(decodeSftpSource("sftp://steam@server.example.com:22#/srv/od#d/world"))
    .toBeNull();
});

// ---- profile persistence (NO secrets) -----------------------------------

// Bun has no `localStorage`; install a Map-backed stub for the persistence
// tests, matching the extra-passives/plan-link global-stub pattern.
beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("writeSftpProfile persists only the non-secret profile fields", () => {
  writeSftpProfile(PROFILE);
  const raw = localStorage.getItem(SFTP_PROFILE_KEY);
  expect(raw).not.toBeNull();
  const stored = JSON.parse(raw as string);
  expect(stored).toEqual({
    host: "server.example.com",
    port: 2222,
    user: "steam",
    auth: "key",
    key_path: "/home/me/.ssh/id_ed25519",
    root: "/home/steam/Pal/Saved/SaveGames",
    last_world_name: null,
  });
});

test("writeSftpProfile never persists a password or key passphrase", () => {
  // Even if a caller hands over an object carrying secrets, they must not land
  // in storage.
  writeSftpProfile({
    ...PROFILE,
    // @ts-expect-error — secrets are not part of SftpProfile; guarding runtime.
    password: "hunter2",
    key_passphrase: "s3cret",
  });
  const raw = localStorage.getItem(SFTP_PROFILE_KEY) as string;
  expect(raw).not.toContain("hunter2");
  expect(raw).not.toContain("s3cret");
  expect(raw).not.toContain("password");
  expect(raw).not.toContain("passphrase");
});

test("readSftpProfile round-trips a written profile", () => {
  writeSftpProfile(PROFILE);
  expect(readSftpProfile()).toEqual(PROFILE);
});

test("readSftpProfile returns null when nothing is stored", () => {
  expect(readSftpProfile()).toBeNull();
});

test("readSftpProfile defaults a missing/blank port to 22 and auth to password", () => {
  localStorage.setItem(SFTP_PROFILE_KEY, JSON.stringify({ host: "h", user: "u" }));
  const p = readSftpProfile();
  expect(p?.port).toBe(22);
  expect(p?.auth).toBe("password");
  expect(p?.key_path).toBeNull();
});

// ---- boot-restore decision ----------------------------------------------

test("bootRestoreAction returns none for an empty/blank saveDir", () => {
  expect(bootRestoreAction("", PROFILE)).toEqual({ kind: "none" });
  expect(bootRestoreAction("   ", PROFILE)).toEqual({ kind: "none" });
});

test("bootRestoreAction returns load for a plain folder or xbox sentinel", () => {
  expect(bootRestoreAction("C:/Palworld/save", null)).toEqual({
    kind: "load",
    dir: "C:/Palworld/save",
  });
  expect(bootRestoreAction("xbox://C:/wgs/AAAA#0001", null)).toEqual({
    kind: "load",
    dir: "xbox://C:/wgs/AAAA#0001",
  });
});

test("bootRestoreAction returns sftp (no blind load) for an sftp sentinel", () => {
  const sentinel = encodeSftpSource(PROFILE, WORLD);
  expect(bootRestoreAction(sentinel, PROFILE)).toEqual({
    kind: "sftp",
    worldDir: WORLD,
    profile: PROFILE,
  });
});

test("bootRestoreAction carries a null profile through unchanged", () => {
  const sentinel = encodeSftpSource(PROFILE, WORLD);
  expect(bootRestoreAction(sentinel, null)).toEqual({
    kind: "sftp",
    worldDir: WORLD,
    profile: null,
  });
});
