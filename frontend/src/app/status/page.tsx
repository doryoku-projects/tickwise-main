import type { Metadata } from 'next';
import { MarketingShell } from '@/components/marketing/MarketingShell';
import { getCoverage } from '@/lib/site-data';
import { StatusRows } from './status-rows';

export const metadata: Metadata = {
  title: 'Status',
  description: 'Indexing freshness and lag by chain for the Tickwise Dex API.',
  openGraph: {
    title: 'Tickwise status',
    description: 'Live indexing freshness per chain.',
  },
};

/**
 * Server component, so the rows are in the HTML — but the rows themselves keep
 * polling once they reach the browser. See `StatusRows`: a page whose subject
 * is freshness cannot render once and sit there.
 *
 * The page's own promise — "we show real indexing lag rather than an uptime
 * number we can't back up" — is the reason it cannot fall back to a fixture.
 * The design source printed "5 min" and "7 min" from a constant, which is
 * precisely the thing the sentence says the page doesn't do.
 *
 * The rows come from `GET /v1/chains` rather than being authored: a chain with
 * an enabled integration is servable, one without is registered and dark. The
 * design source hard-coded Arbitrum and Optimism rows reading "indexed, not
 * servable" — a claim about chains this deployment does not index at all.
 */
export default async function StatusPage() {
  const rows = await getCoverage();

  return (
    <MarketingShell>
      <div className="container-page py-16">
        {/* Heading takes the reading measure; the panel below spans the whole
            frame. Its rows are chain/lag pairs on a `justify-between`, which is
            a status table — that reads correctly at full width. */}
        <div className="container-prose">
          <div className="text-xs uppercase tracking-widest text-primary">Status</div>
          <h1 className="mt-2 font-display text-4xl font-semibold">Indexing freshness</h1>
          <p className="mt-2 text-muted-foreground">
            We show real indexing lag per chain rather than an uptime number we can’t back up.
          </p>
        </div>

        <StatusRows initialRows={rows} />

        <div className="mt-6 rounded-md border border-border/60 bg-surface p-4 text-sm text-muted-foreground">
          No open incidents. Historical incident notes will appear here once we ship the log.
        </div>
      </div>
    </MarketingShell>
  );
}
