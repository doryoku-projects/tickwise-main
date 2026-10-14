import { Webhook } from "lucide-react";
import { compactAddress } from "../lib/format";

const HOOK_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The tooltip / screen-reader text of a hook badge: the shortened hook address
 * and, for a hook whose address sets a `*_RETURNS_DELTA` permission, what that
 * means for the figures on the row.
 */
export function hookBadgeText(hooks: string, customAccounting?: boolean): string {
  const base = `Hook ${compactAddress(hooks)}.`;
  return customAccounting
    ? `${base} Custom accounting hook: may take fees or redirect value not shown in swap events.`
    : base;
}

/**
 * A pool's v4 hook, as a small badge beside its fee (2026-10-06). The backend
 * sends `hooks` / `customAccounting` only for a pool that has one, so a row
 * without them renders nothing — and so does a value that is not an address,
 * rather than a badge with a made-up tooltip. Styled like RiskBadges' and
 * FeeLabel's pills (same shape, the explanation in the tooltip and for screen
 * readers), in the info colours; a custom-accounting hook gets the amber
 * variant, because for those the indexed fee and volume figures are not
 * provably complete. A dynamic-fee pool reads "dynamic" in FeeLabel and keeps
 * this badge beside it: the hook is what sets that fee.
 */
export function HookBadge({ hooks, customAccounting }: { hooks?: string; customAccounting?: boolean }) {
  if (typeof hooks !== "string" || !HOOK_ADDRESS.test(hooks)) return null;
  const text = hookBadgeText(hooks, customAccounting === true);
  return (
    <span className={customAccounting === true ? "hookBadge hookBadgeCustom" : "hookBadge"} title={text}>
      <Webhook aria-hidden="true" size={12} strokeWidth={2.5} />
      Hook
      <span className="feeDangerText">{text}</span>
    </span>
  );
}
