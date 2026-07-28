// Shareable breeding-plan LINKS. A "plan code" (the base64url payload from
// plan-export's `encodePlanCode`) already round-trips a whole solve request; this
// module wraps one in a URL so it can be pasted into a chat / issue and opened
// straight into the Solver.
//
// WHY the URL HASH fragment (`#plan=<code>`) and never a query string: a hash is
// never sent to the server on navigation, so shared codes stay out of the Pages
// access logs and any client analytics that reflect `location.search`. It also
// lets the SPA read + strip the code entirely client-side with no round-trip.
//
// WHY the origin is mode-dependent: on the web build we want the link to point at
// whatever origin the user is on, so preview deploys (`*.pal-lab.pages.dev`)
// produce self-referential links instead of always bouncing to production. But a
// Tauri desktop user has no shareable URL of their own (the app runs from a
// `tauri://` / custom-scheme origin no one else can open), so a desktop "Copy
// link" MUST hand out the canonical public web app instead.

import { isTauri } from "./caps";

/** The public web app a desktop-generated link must point at (desktop has no
 *  shareable origin of its own). Kept as the deployed production host, not a
 *  preview alias. */
const CANONICAL_ORIGIN = "https://pal-lab.pages.dev";

/** The hash-fragment key carrying a shared plan code (`#plan=<code>`). */
const PLAN_KEY = "plan";

/**
 * Build a shareable URL for a plan `code`. On the web the link is rooted at the
 * current {@link location.origin} (so preview deploys stay self-referential);
 * under Tauri it is rooted at the canonical public web app, since a desktop
 * origin isn't openable by anyone else. The code rides the hash fragment,
 * percent-encoded so any future non-base64url payload survives intact.
 */
export function planUrl(code: string): string {
  const origin = isTauri ? CANONICAL_ORIGIN : location.origin;
  return `${origin}/#${PLAN_KEY}=${encodeURIComponent(code)}`;
}

/**
 * Read a shared plan code out of the current URL hash, or null when none is
 * present. Matches `#plan=<code>` (also tolerating it as a later `&plan=` param)
 * and reverses the {@link planUrl} percent-encoding. A malformed escape or an
 * empty value yields null rather than throwing, so a garbage fragment simply
 * boots the app normally.
 */
export function readPlanLink(): string | null {
  const match = /[#&]plan=([^&]*)/.exec(location.hash);
  if (!match) return null;
  let code: string;
  try {
    code = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return code.length > 0 ? code : null;
}

/**
 * Strip the plan fragment from the address bar WITHOUT reloading, so a shared
 * link doesn't re-import on the next in-app hash change or get re-shared with the
 * code still attached. Uses `history.replaceState` (no history entry, no
 * navigation) and drops the whole hash — the app routes via state, not the URL
 * fragment, so nothing else lives there.
 */
export function clearPlanLink(): void {
  history.replaceState(null, "", location.pathname + location.search);
}
