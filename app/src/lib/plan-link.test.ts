// Unit tests for the shareable plan-link codec. Run with `bun test`. The
// `bun:test` import type-resolves via app/src/bun-test.d.ts (no @types/bun here).
//
// plan-link reads globals (`location`, `history`); bun has no DOM, so each test
// installs a minimal stub on `globalThis`. `isTauri` (from ./caps) is baked false
// at module load in this environment (no `window`), so `planUrl` exercises the
// web `location.origin` branch — the desktop canonical-origin branch is a compile
// time const swap, covered by tsc.
import { afterEach, expect, test } from "bun:test";

import { clearPlanLink, planUrl, readPlanLink } from "./plan-link";

interface LocationStub {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
}

/** Install a location + history stub and return the location for mutation. */
function stubUrl(over: Partial<LocationStub> = {}): LocationStub {
  const loc: LocationStub = {
    origin: "https://preview.pal-lab.pages.dev",
    pathname: "/",
    search: "",
    hash: "",
    ...over,
  };
  Object.defineProperty(globalThis, "location", {
    value: loc,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "history", {
    value: {
      replaceState: (_s: unknown, _t: string, url?: string | null) => {
        // Mirror the browser: replaceState with a hashless URL drops the hash.
        loc.hash = "";
        if (typeof url === "string") {
          const h = url.indexOf("#");
          if (h >= 0) loc.hash = url.slice(h);
        }
      },
    },
    configurable: true,
    writable: true,
  });
  return loc;
}

afterEach(() => {
  // Leave no stub behind for sibling test files sharing the runtime.
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "history");
});

test("planUrl builds an origin-rooted #plan fragment", () => {
  stubUrl({ origin: "https://preview.pal-lab.pages.dev" });
  expect(planUrl("ABC123")).toBe(
    "https://preview.pal-lab.pages.dev/#plan=ABC123",
  );
});

test("planUrl uses the live origin so preview deploys stay self-referential", () => {
  stubUrl({ origin: "https://deadbeef.pal-lab.pages.dev" });
  expect(planUrl("xyz")).toBe("https://deadbeef.pal-lab.pages.dev/#plan=xyz");
});

test("planUrl percent-encodes payloads that aren't URL-safe", () => {
  stubUrl();
  expect(planUrl("a b/c+d=e&f")).toBe(
    "https://preview.pal-lab.pages.dev/#plan=a%20b%2Fc%2Bd%3De%26f",
  );
});

test("readPlanLink returns null when there is no fragment", () => {
  stubUrl({ hash: "" });
  expect(readPlanLink()).toBeNull();
});

test("readPlanLink returns null for an unrelated fragment", () => {
  stubUrl({ hash: "#solver" });
  expect(readPlanLink()).toBeNull();
});

test("readPlanLink decodes a #plan= fragment", () => {
  stubUrl({ hash: "#plan=ABC123" });
  expect(readPlanLink()).toBe("ABC123");
});

test("readPlanLink tolerates plan as a later &-param", () => {
  stubUrl({ hash: "#view=solver&plan=CODE" });
  expect(readPlanLink()).toBe("CODE");
});

test("readPlanLink returns null for an empty plan value", () => {
  stubUrl({ hash: "#plan=" });
  expect(readPlanLink()).toBeNull();
});

test("readPlanLink returns null for a malformed escape", () => {
  stubUrl({ hash: "#plan=%E0%A4%A" });
  expect(readPlanLink()).toBeNull();
});

test("planUrl -> readPlanLink round-trips base64url and weird chars", () => {
  for (const code of [
    "eyJyZXF1ZXN0Ijp7fX0",
    "a-b_c-D_0123456789",
    "spaces and /slashes+plus=eq&amp",
    "unicode \u00e9\u00f1\u2764",
  ]) {
    const loc = stubUrl();
    // planUrl -> #plan=<enc>; feed that fragment back through readPlanLink.
    const url = planUrl(code);
    loc.hash = url.slice(url.indexOf("#"));
    expect(readPlanLink()).toBe(code);
  }
});

test("clearPlanLink strips the fragment in place", () => {
  const loc = stubUrl({ pathname: "/", search: "", hash: "#plan=ABC123" });
  clearPlanLink();
  expect(loc.hash).toBe("");
  expect(readPlanLink()).toBeNull();
});

test("clearPlanLink preserves pathname and search", () => {
  const loc = stubUrl({ pathname: "/app", search: "?x=1", hash: "#plan=Z" });
  let seen: string | null | undefined;
  Object.defineProperty(globalThis, "history", {
    value: {
      replaceState: (_s: unknown, _t: string, url?: string | null) => {
        seen = url;
        loc.hash = "";
      },
    },
    configurable: true,
    writable: true,
  });
  clearPlanLink();
  expect(seen).toBe("/app?x=1");
});
