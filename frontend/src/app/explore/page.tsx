import type { Metadata } from 'next';
import { MarketingShell } from '@/components/marketing/MarketingShell';
import { PositionsDashboard } from '@/components/PositionsDashboard';

export const metadata: Metadata = {
  title: 'Explore Uniswap v4 positions and pools',
  description:
    'Browse indexed Uniswap v4 liquidity positions and pools on Ethereum, Arbitrum and Avalanche — value, fees, PnL, APR and in-range state. Free and un-gated.',
};

/**
 * The dashboard used to live at `/`. It moved here so the front page can
 * explain the product; this page stays public and un-gated because it is the
 * best proof the data is real.
 *
 * It now renders inside `MarketingShell` like every other public route, so the
 * site header, footer and theme toggle are the same ones /pricing, /docs and
 * /status carry. `PositionsDashboard` previously rendered its own `revertShell`
 * + `AppNav`; both were removed rather than hidden, because two headers is a
 * worse outcome than the one it was trying to avoid.
 */
export default function ExplorePage() {
  return (
    <MarketingShell>
      <PositionsDashboard />
    </MarketingShell>
  );
}
