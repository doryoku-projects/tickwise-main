import type { Metadata } from 'next';
import {
  getChainMetrics,
  getLandingPlans,
  getPublicStats,
  getPublicUnitCosts,
} from '../lib/site-data';
import { Landing } from './landing';

export const metadata: Metadata = {
  // `absolute` opts out of the root layout's "%s · Tickwise" template.
  title: { absolute: 'Tickwise — Uniswap v4 liquidity position data API' },
  description:
    'A JSON API for Uniswap v4 liquidity positions and pools on Ethereum, Arbitrum and Avalanche: underlying value, uncollected fees, PnL, APR and in-range state. Free tier, metered in units.',
  openGraph: {
    type: 'website',
    title: 'Tickwise Dex API',
    description:
      'Near-real-time Uniswap v4 pools and positions. Built for teams that would rather build product than index chains.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Tickwise Dex API',
    description: 'Live DeFi intelligence as one clean, metered API.',
  },
};

/*
 * The proof numbers are fetched here, in the server component, rather than in
 * the client view that renders them: this route stays server-rendered for SEO
 * and the numbers are part of what the crawler should see. None of the three
 * getters throws — each degrades to null or an empty list — so an unreachable
 * API costs the landing page some figures rather than the whole page.
 *
 * EVERY getter below is on ISR, and that is load-bearing rather than incidental:
 * it is what keeps this route PRERENDERED (`○` in the build output) instead of
 * rendered per request. The plan catalogue is read through `getLandingPlans()`
 * rather than `getPublicPlans()` for exactly that reason — see the comment
 * there. Adding an un-cached fetch anywhere in this tree silently makes `/`
 * dynamic again and hands every mobile visitor a blocking upstream round trip
 * ahead of the first byte; check the build output if you add one.
 */
export default async function HomePage() {
  const [stats, chainMetrics, plans, unitCosts] = await Promise.all([
    getPublicStats(),
    getChainMetrics(),
    getLandingPlans(),
    // The demo panels quote what their example call costs. Read from the live
    // pricing table for the same reason `/docs` does: the figure is
    // admin-editable, and a literal in the markup is how `/pricing` once
    // advertised charts at 10 while the guard charged 1.
    getPublicUnitCosts(),
  ]);
  return (
    <Landing stats={stats} chainMetrics={chainMetrics} plans={plans} unitCosts={unitCosts} />
  );
}
