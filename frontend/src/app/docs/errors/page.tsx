import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';

export const metadata: Metadata = {
  title: 'Errors',
  description: 'Every status code the Tickwise API returns, what causes it, and whether retrying will help.',
};

export default function DocsErrorsPage() {
  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-widest text-primary">Reference</div>
        <h1 className="font-display text-4xl font-semibold">Errors</h1>
        <p className="text-muted-foreground">
          Errors are JSON with an <code>error</code> string.{' '}
          <strong>Branch on the status code, never on the message</strong> — the prose is written for humans and
          we reserve the right to reword it.
        </p>
      </div>

      <CodeBlock lang="json" code={`{"error":"Monthly quota exceeded","retryAfterSec":1738368000}`} />

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Status codes</h2>
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Meaning</th>
                <th className="px-4 py-2 font-medium">Retry?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              <tr>
                <td className="px-4 py-2 font-mono text-xs">400</td>
                <td className="px-4 py-2">
                  A parameter is malformed or unrecognised — a bad <code>sort</code>, an unsupported{' '}
                  <code>protocol</code>, a <code>poolId</code> that is not 0x-prefixed hex.
                </td>
                <td className="px-4 py-2">No. Fix the request. Costs no units.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">401</td>
                <td className="px-4 py-2">
                  The <code>KC-APIKey</code> header is missing, unknown, revoked, or belongs to a suspended
                  account.
                </td>
                <td className="px-4 py-2">No.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">403</td>
                <td className="px-4 py-2">
                  The key is valid but not allowed here. Almost always one of two things: a{' '}
                  <strong>server key used from a browser</strong> (any request carrying an <code>Origin</code>{' '}
                  header), or a <strong>browser key used from an origin it is not bound to</strong>.
                </td>
                <td className="px-4 py-2">
                  No — see <Link href="/docs/authentication">Authentication</Link>.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">404</td>
                <td className="px-4 py-2">No such position, pool or route.</td>
                <td className="px-4 py-2">No.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">429</td>
                <td className="px-4 py-2">
                  Burst rate limit or monthly quota. <code>Retry-After</code> tells you which by how long it is:
                  seconds for a burst, up to a month for a quota.
                </td>
                <td className="px-4 py-2">
                  Yes, after <code>Retry-After</code>.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">5xx</td>
                <td className="px-4 py-2">
                  Our problem. A <code>503</code> with <code>Retry-After</code> means a read did not finish in
                  time — on a list, often a very deep page still being reached. Costs no units.
                </td>
                <td className="px-4 py-2">
                  Yes, with backoff — after <code>Retry-After</code> when it is present.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Retrying well</h2>
        <p className="text-muted-foreground">
          Honour <code>Retry-After</code> when it is present; otherwise back off exponentially from about a
          second, with jitter, and give up after a handful of attempts. Do not retry a 4xx other than 429 — the
          answer will not change, and a tight loop against a 400 is the fastest way to look like an attack.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Two responses that are not errors</h2>
        <p className="text-muted-foreground">
          <strong>An empty list is a valid answer.</strong> The list endpoints apply visibility filters —
          minimum value, minimum pool TVL, and an exclusion of positions whose token has no corroborated
          on-chain market. A wallet with only small or spam-token positions returns{' '}
          <code>{'{ "data": [], "pagination": { "total": 0 } }'}</code> and a 200. Widen the filters (
          <code>minValueUsd=0&amp;minPoolTvl=0&amp;includeRisky=true&amp;status=all</code>) if you want
          everything.
        </p>
        <p className="text-muted-foreground">
          <strong>A missing price is reported, not faked.</strong> When a token genuinely cannot be priced from
          any independent source, the position carries <code>metrics.priceUnavailable: true</code> rather than a
          misleading <code>0</code>. Treat that as &ldquo;unknown&rdquo;, not as &ldquo;worthless&rdquo; — the
          two are different, and a valid <code>0</code> also exists.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Coverage</h2>
        <p className="text-muted-foreground">
          We serve <strong>Uniswap v4 on Ethereum (1), Arbitrum One (42161) and Avalanche (43114)</strong>. Any
          other chain or protocol is a 400, and that is a coverage statement rather than a bug — no v3, no
          Optimism today. <code>GET /v1/chains</code> is the live list.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Still stuck</h2>
        <p className="text-muted-foreground">
          Check <code>GET /health</code> for indexing status: it reports the last indexed block against the
          chain head, so you can tell &ldquo;the data is missing&rdquo; apart from &ldquo;the data has not been
          indexed yet&rdquo;. When the live chain head cannot be read, <code>chainHeadBlock</code> is
          estimated from the last good reading for up to 15 minutes and{' '}
          <code>chainHeadEstimated</code> is <code>true</code>, and <code>lagBlocks</code> and{' '}
          <code>lagSeconds</code> are estimates with it, while <code>indexedUpToTimestamp</code> is{' '}
          <code>null</code> (so is that chain&rsquo;s <code>byChain[].indexedUpToTimestamp</code> on{' '}
          <code>GET /v1/stats</code>); otherwise{' '}
          <code>chainHeadEstimated</code> is <code>false</code>. Past those 15 minutes, or with no good
          reading yet, the head and lag are <code>null</code>.
        </p>
      </div>
    </>
  );
}
