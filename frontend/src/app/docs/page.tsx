import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';
import { QUICKSTART_BASE } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Quickstart',
  description:
    'Make your first authenticated call to the Tickwise Uniswap v4 position and pool API in about two minutes.',
};

export default function DocsQuickstartPage() {
  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-widest text-primary">Getting started</div>
        <h1 className="font-display text-4xl font-semibold">Quickstart</h1>
        <p className="text-muted-foreground">
          The API serves indexed Uniswap v4 liquidity-position and pool data for <strong>Ethereum</strong>,{' '}
          <strong>Arbitrum One</strong> and <strong>Avalanche</strong>. Responses are JSON over HTTPS.
          There is no SDK to install.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">1. Get a key</h2>
        <p className="text-muted-foreground">
          <Link href="/signup">Create an account</Link>, verify your email, then issue a key from{' '}
          <Link href="/portal/keys">API keys</Link>. The Free plan needs no payment details.
        </p>
        <p className="text-muted-foreground">
          The secret is shown <strong>once</strong>. It is stored hashed, so nobody — including us — can read it
          back; if you lose it, revoke it and issue another.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">2. Call an endpoint</h2>
        <p className="text-muted-foreground">
          Every metered request carries your key in the <code>KC-APIKey</code> header. Not a bearer token, and
          not a query parameter — a key in a URL ends up in browser history, proxy logs and <code>Referer</code>{' '}
          headers.
        </p>
        <CodeBlock
          lang="bash"
          code={`curl -s ${QUICKSTART_BASE}/v1/positions?limit=5 \\
  -H "KC-APIKey: $TICKWISE_API_KEY"`}
        />
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">3. Read the limit headers</h2>
        <p className="text-muted-foreground">
          Every metered response tells you exactly where you stand. Read these rather than guessing:
        </p>
        <CodeBlock
          lang="http"
          code={`X-RateLimit-Limit: 300      # requests per minute, per key
X-RateLimit-Remaining: 299
X-RateLimit-Reset: 47       # seconds until the burst window rolls
X-Quota-Limit: 5000000      # units per month, per account
X-Quota-Remaining: 4999998
X-Quota-Reset: 1738368000   # seconds until 00:00 UTC on the 1st`}
        />
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">What you can ask for</h2>
        {/* `overflow-x-auto`, not `overflow-hidden` — the same wrapper every docs
            table uses, and /pricing's unit table already used. The clip was only
            ever there to round the table's corners against the border, which a
            scroll container does just as well; what it also did was make a
            710px table inside a 375px phone unreadable, silently amputating the
            "What it returns" column with no way to reach it. */}
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2 font-medium">Endpoint</th>
                <th className="px-4 py-2 font-medium">Units</th>
                <th className="px-4 py-2 font-medium">What it returns</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              <tr>
                <td className="px-4 py-2 font-mono text-xs">GET /v1/positions</td>
                <td className="px-4 py-2 font-mono text-xs">2</td>
                <td className="px-4 py-2">
                  A ranked, filterable page of positions. Filter by <code>owner</code>, <code>poolId</code>,{' '}
                  <code>positionId</code>, status, range, minimum value; sort by APR, PnL, ROI, age or value.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">
                  GET /v1/positions/:chainId/:protocol/:positionId
                </td>
                <td className="px-4 py-2 font-mono text-xs">1</td>
                <td className="px-4 py-2">One position in full.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">
                  GET /v1/positions/:chainId/:protocol/:positionId/charts
                </td>
                <td className="px-4 py-2 font-mono text-xs">10</td>
                <td className="px-4 py-2">
                  Time series for one position. <code>?range=30d|60d|90d|180d|all</code>.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">GET /v1/pools</td>
                <td className="px-4 py-2 font-mono text-xs">2</td>
                <td className="px-4 py-2">
                  Ranked pools with TVL, volume, fee APR, open-position and holder counts.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">
                  GET /v1/pools/:chainId/:protocol/:poolId
                </td>
                <td className="px-4 py-2 font-mono text-xs">1</td>
                <td className="px-4 py-2">One pool in full.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">
                  GET /v1/pools/:chainId/:protocol/:poolId/charts
                </td>
                <td className="px-4 py-2 font-mono text-xs">10</td>
                <td className="px-4 py-2">Time series for one pool.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">GET /v1/chains, /v1/protocols</td>
                <td className="px-4 py-2 font-mono text-xs">0</td>
                <td className="px-4 py-2">Metadata. Free and unmetered, but still needs a valid key.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Two things that catch people out</h2>
        <p className="text-muted-foreground">
          <strong>
            Omitting <code>chainId</code> means every chain, not Ethereum.
          </strong>{' '}
          The list endpoints scatter-gather across all enabled chains and merge the results. Pass{' '}
          <code>?chainId=1</code> or <code>?chainId=43114</code> when you want one.
        </p>
        <p className="text-muted-foreground">
          <strong>A request that we refuse does not spend units.</strong> Any 4xx is refunded automatically, so
          a malformed filter costs you nothing; so is any 5xx, and any response flagged{' '}
          <code>partial</code> or <code>transactionsDegraded</code>. A 429 is not refunded, because it never consumed anything in the
          first place.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Next</h2>
        <p className="text-muted-foreground">
          <Link href="/docs/authentication">Authentication</Link> — server keys, browser keys and origin
          binding. <Link href="/docs/units-and-limits">Units and limits</Link> — what each call costs and when
          the quota resets. <Link href="/docs/errors">Errors</Link> — every status code we return and what to do
          about it.
        </p>
      </div>
    </>
  );
}
