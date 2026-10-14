import type { Metadata } from 'next';
import { getPublicPlans, getPublicUnitCosts } from '../../lib/site-data';
import { Pricing } from './PricingView';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Simple monthly plans for the Tickwise Uniswap v4 API. Metered by units, not by request. Every plan uses the same endpoints.',
  openGraph: {
    title: 'Tickwise pricing',
    description: 'Metered by units. Pay in USDC. No surprise overage.',
  },
};

/*
 * Plans and unit costs are fetched here and passed down, rather than read by
 * the view. The view is `"use client"` because the monthly/annual toggle is
 * state, but the DATA must be in the server-rendered HTML — a pricing page
 * whose prices only appear after hydration is a pricing page a crawler cannot
 * read. Fetching in the server component keeps both.
 */
export default async function PricingPage() {
  const [plans, unitCosts] = await Promise.all([getPublicPlans(), getPublicUnitCosts()]);
  return <Pricing plans={plans} unitCosts={unitCosts} />;
}
