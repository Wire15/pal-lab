// Partner-skill icon chip. Renders the species' bundled partner glyph
// (public/partner/<textureId>.png) or a neutral fallback mark when the pack has
// no resolved icon — never a broken <img>. Sourced from the own-install
// extraction; see crates/pal-data/vendor/NOTICE.

import { useState } from "react";
import { partnerIconUrl, PARTNER_FALLBACK_ICON } from "../lib/assets";

/**
 * The partner-skill icon for a species, keyed by its `partner_skill_icon`
 * texture id. Falls back to {@link PARTNER_FALLBACK_ICON} for a null id or a
 * load error, so the row always shows a clean glyph beside the skill name.
 */
export function PartnerIcon({
  iconId,
  size = 22,
  className = "",
}: {
  iconId: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const resolved = partnerIconUrl(iconId);
  const src = resolved && !failed ? resolved : PARTNER_FALLBACK_ICON;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md bg-abyss/60 object-contain p-0.5 ring-1 ring-line/70 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
