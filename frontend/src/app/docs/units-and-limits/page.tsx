import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';

export const metadata: Metadata = {
  title: 'Units and limits',
  description:
    'What each Tickwise endpoint costs in units, how the burst rate limit and the monthly quota differ, and exactly when the quota resets.',
};

export default function DocsUnitsPage() {
  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-widest text-primary">Getting started</div>
        <h1 className="font-display text-4xl font-semibold">Units and limits</h1>
        <p className="text-muted-foreground">
          There are <strong>two independent limits</strong>, and they fail in different ways. Confusing them is
          the usual reason an integration behaves oddly under load.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/60">
        <table className="w-full text-sm">
          <thead className="bg-surface">
            <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
              <th className="px-4 py-2 font-medium" />
              <th className="px-4 py-2 font-medium">Burst rate limit</th>
              <th className="px-4 py-2 font-medium">Monthly quota</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            <tr>
              <td className="px-4 py-2">Counted per</td>
              <td className="px-4 py-2">API key</td>
              <td className="px-4 py-2">Account (all your keys together)</td>
            </tr>
            <tr>
              <td className="px-4 py-2">Unit of account</td>
              <td className="px-4 py-2">Requests</td>
              <td className="px-4 py-2">Units — endpoints cost different amounts</td>
            </tr>
            <tr>
              <td className="px-4 py-2">Window</td>
              <td className="px-4 py-2">60 seconds, rolling</td>
              <td className="px-4 py-2">Calendar month, UTC</td>
            </tr>
            <tr>
              <td className="px-4 py-2">Headers</td>
              <td className="px-4 py-2 font-mono text-xs">X-RateLimit-*</td>
              <td className="px-4 py-2 font-mono text-xs">X-Quota-*</td>
            </tr>
            <tr>
              <td className="px-4 py-2">When it trips</td>
              <td className="px-4 py-2">429 — wait seconds and retry</td>
              <td className="px-4 py-2">429 — wait until the 1st, or upgrade</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Why units and not requests</h2>
        <p className="text-muted-foreground">
          A request is not a request. A metadata read is an in-process lookup; a charts call is a multi-query
          fan-out to a paid upstream that we pay for per call. Charging both the same would mean either
          overcharging for the cheap one or subsidising the expensive one out of everybody else&rsquo;s
          allowance.
        </p>

        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2 font-medium">Tier</th>
                <th className="px-4 py-2 font-medium">Units</th>
                <th className="px-4 py-2 font-medium">Endpoints</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              <tr>
                <td className="px-4 py-2">Metadata</td>
                <td className="px-4 py-2 font-mono text-xs">0</td>
                <td className="px-4 py-2 font-mono text-xs">/v1/chains, /v1/protocols</td>
              </tr>
              <tr>
                <td className="px-4 py-2">Detail</td>
                <td className="px-4 py-2 font-mono text-xs">1</td>
                <td className="px-4 py-2 font-mono text-xs">/v1/positions/:chainId/:protocol/:id, /v1/pools/:chainId/:protocol/:id</td>
              </tr>
              <tr>
                <td className="px-4 py-2">List</td>
                <td className="px-4 py-2 font-mono text-xs">2</td>
                <td className="px-4 py-2 font-mono text-xs">/v1/positions, /v1/pools</td>
              </tr>
              <tr>
                <td className="px-4 py-2">Charts</td>
                <td className="px-4 py-2 font-mono text-xs">10</td>
                <td className="px-4 py-2 font-mono text-xs">…/charts on either resource</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground">
          The live table is served from <code>GET /v1/pricing/units</code> and rendered on{' '}
          <Link href="/pricing#units">the pricing page</Link>. Read it from the API rather than hard-coding
          these numbers.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">When the quota resets</h2>
        <p className="text-muted-foreground">
          <strong>00:00 UTC on the 1st of each month.</strong> Not a rolling 30 days, and not the anniversary of
          when you subscribed. <code>X-Quota-Reset</code> is the number of seconds until that instant, so you
          can act on it without doing calendar arithmetic.
        </p>
        <p className="text-muted-foreground">
          The consequence worth planning for: subscribing on the 20th gives you the whole month&rsquo;s
          allowance, and it resets eleven days later. We would rather be clear about that than quietly prorate
          an allowance nobody can predict.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Requests we refuse are not billed</h2>
        <p className="text-muted-foreground">
          Units are consumed before your request is served, and <strong>credited back on any 4xx</strong>. A
          malformed filter, an unknown position id, a 403 from a server key used in a browser — none of them
          cost anything. Billing for a request the API declined is not defensible, so we do not.
        </p>
        <p className="text-muted-foreground">
          A 429 is the exception, and only technically: it is rejected before anything is consumed, so there is
          nothing to credit.
        </p>
        <p className="text-muted-foreground">
          <strong>Every 5xx is credited back too</strong>, including the <code>503</code> with{' '}
          <code>Retry-After</code> returned when a read does not finish in time, such as a very deep list page
          that is still being reached. So is a
          200 that reports it did not deliver everything asked for: a list or chart carrying{' '}
          <code>&quot;partial&quot;: true</code>, or a position detail carrying{' '}
          <code>&quot;transactionsDegraded&quot;: true</code> or <code>&quot;transactionsPartial&quot;: true</code>.
          A response flagged <code>&quot;stale&quot;: true</code> is complete, only older, and is billed
          normally.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Handling a 429</h2>
        <p className="text-muted-foreground">
          Both kinds carry <code>Retry-After</code> in seconds. Honour it rather than retrying on a fixed timer
          — a burst 429 clears in seconds, a quota 429 clears at the month boundary, and the header is how you
          tell them apart without parsing prose. The body also carries <code>retryAfterSec</code>.
        </p>
        <CodeBlock lang="http" code={`HTTP/1.1 429 Too Many Requests
Retry-After: 12
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 0

{"error":"Rate limit exceeded","retryAfterSec":12}`} />
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">If a paid plan lapses</h2>
        <p className="text-muted-foreground">
          Your account moves to Free and <strong>your keys keep working</strong> at Free limits. Nothing is
          revoked and nothing is deleted. Your consumed units for the current month are also reset at that
          point, so a downgrade cannot leave you locked out for the rest of the month on an allowance you had
          already spent.
        </p>
      </div>
    </>
  );
}
