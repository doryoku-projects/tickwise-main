import { AlertTriangle } from "lucide-react";
import { formatFee } from "../lib/format";

/**
 * Static LP fee (pips) at or above which a pool keeps 5% or more of every
 * swap. Mirrors the backend's `HONEYPOT_FEE_MIN_PIPS` (src/common/pool-fee.ts):
 * the spam pools sit at 99.99% / 99.5% / 9.9993% / 6.0001%, but real pools of
 * two major tokens exist up there too (Arbitrum ETH/USDC at 6.094%, Ethereum
 * ETH/USDT at 21.079%) and are shown — so the fee is flagged, not hidden.
 */
export const HIGH_FEE_MIN_PIPS = 50_000;
/** v4's dynamic-fee flag (backend `DYNAMIC_FEE_FLAG`): a hook sets the fee per swap, so it is not a static fee. */
const DYNAMIC_FEE_FLAG = 0x800000;

export function isDynamicFee(fee: number): boolean {
  return Number.isFinite(fee) && fee >= DYNAMIC_FEE_FLAG;
}

export function isHighFee(fee: number): boolean {
  return Number.isFinite(fee) && fee >= HIGH_FEE_MIN_PIPS && fee < DYNAMIC_FEE_FLAG;
}

/**
 * A pool's fee as the tables and detail panels show it: "dynamic" for a v4
 * dynamic-fee pool (its flag would format as a bogus 838.86%), the percentage
 * otherwise, and a danger sign + explanation when the fee is 5% or more.
 */
export function FeeLabel({ fee, dynamic }: { fee: number; dynamic?: boolean }) {
  if (dynamic ?? isDynamicFee(fee)) return <span>dynamic</span>;
  const text = formatFee(fee);
  if (!isHighFee(fee)) return <span>{text}</span>;
  const warning = `High fee: this pool keeps ${text} of every swap. That is far above normal (0.01%–1%) — check the pool before you trade or add liquidity.`;
  return (
    <span className="feeDanger" title={warning}>
      <AlertTriangle aria-hidden="true" size={12} strokeWidth={2.5} />
      {text}
      <span className="feeDangerText">{warning}</span>
    </span>
  );
}
