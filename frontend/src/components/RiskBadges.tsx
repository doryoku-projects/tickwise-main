import { AlertTriangle } from "lucide-react";
import type { RiskFlag, RowRisk } from "../lib/api";

/**
 * The backend's per-row `risk.flags` (2026-10-06) as badges beside the pair.
 * Ranked lists already leave these rows out; search, an owner's or a pool's
 * own list, and a detail panel keep them — the badge is what tells a reader
 * the row is spam or unreliable. Styled like FeeLabel's danger sign (same
 * class: the red badge, the explanation in the tooltip and for screen
 * readers). Both spam reasons read "Spam", so a row shows each label once.
 */
const COPY: Record<RiskFlag, { label: string; text: string }> = {
  "symbol-spoof": {
    label: "Spam",
    text: "Spam token: a token in this pair uses the symbol of a major token, such as USDT or WETH, but it is not that token's contract.",
  },
  "phishing-symbol": {
    label: "Spam",
    text: "Spam token: a token in this pair has a link or \"visit\" in its symbol, a common airdrop-phishing lure. Don't open the link.",
  },
  "excluded-token": {
    label: "Flagged",
    text: "Flagged token: a security scan marked a token in this pair as unsafe or fake, or it has no real trading market. It is left out of the ranked lists.",
  },
  "risky-pool": {
    label: "Risky pool",
    text: "Risky pool: its value can't be relied on. Most of it is in tokens without a trusted price, its fee is 5% or more, or its reserves are broken.",
  },
};

export function RiskBadges({ risk }: { risk?: RowRisk }) {
  const flags = Array.isArray(risk?.flags) ? risk.flags : [];
  const byLabel = new Map<string, string[]>();
  for (const flag of flags) {
    const copy = COPY[flag];
    if (!copy) continue; // a flag this build does not know: say nothing rather than guess
    const texts = byLabel.get(copy.label) ?? [];
    if (!texts.includes(copy.text)) texts.push(copy.text);
    byLabel.set(copy.label, texts);
  }
  if (byLabel.size === 0) return null;
  return (
    <>
      {[...byLabel].map(([label, texts]) => {
        const text = texts.join(" ");
        return (
          <span key={label} className="feeDanger" title={text}>
            <AlertTriangle aria-hidden="true" size={12} strokeWidth={2.5} />
            {label}
            <span className="feeDangerText">{text}</span>
          </span>
        );
      })}
    </>
  );
}
