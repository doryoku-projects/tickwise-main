import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingShell } from '@/components/marketing/MarketingShell';

export const metadata: Metadata = {
  title: 'Support',
  description:
    'The failures people actually hit against the Tickwise Dex API, the exact response each one produces, and what to do about it.',
  openGraph: {
    title: 'Tickwise support',
    description: 'The common failures, their exact responses, and the fix for each.',
  },
};

/**
 * The triage page.
 *
 * Every row below is the response the API really produces — the strings are
 * lifted from `backend/src/v1/api-key.guard.ts` and `metering.guard.ts` rather
 * than paraphrased. The design source listed machine-readable codes
 * (`server_key_from_browser`, `origin_not_allowed`) that this API has never
 * emitted; somebody would have written `if (err.code === 'origin_not_allowed')`
 * against a field that does not exist.
 *
 * Two other things from the design source are deliberately absent. It opened
 * with "ninety percent of tickets are one of these five things", which is a
 * statistic about a support queue nobody here has measured. And its escalation
 * block asked for "the request id from the response headers" — there is no
 * request-id middleware anywhere in the backend and no such header is set, so
 * following that instruction leaves a reader hunting for something that is not
 * there. The escalation block asks for what a trace can actually start from.
 */
const FAILURES = [
  {
    status: '401',
    body: 'Missing KC-APIKey header',
    cause:
      'The header is absent. Usually a proxy or client library that drops unknown headers, or an Authorization: Bearer that was never read.',
    fix: 'Send the key as KC-APIKey. Not a bearer token, and never a query parameter.',
  },
  {
    status: '401',
    body: 'Invalid or revoked API key',
    cause:
      'The key is not recognised, has been revoked, or belongs to a suspended account. A whitespace-padded copy-paste looks identical and fails the same way.',
    fix: 'Issue a fresh key in the portal. The secret is shown once and stored hashed, so a lost key is replaced rather than recovered.',
  },
  {
    status: '403',
    body: 'This API key is server-only and cannot be used from a browser',
    cause:
      'A server key sent a request carrying an Origin header — which is to say, from a browser. The key is valid; the place it was used is not.',
    fix: 'Call the API from your backend, or issue a browser key with your origins listed. This 403 is the feature: it stops a secret key going public silently.',
  },
  {
    status: '403',
    body: 'Origin not allowed for this API key',
    cause:
      'A browser key was used from an origin it is not bound to. Origins are matched exactly on scheme://host[:port], so https://app.example.com and https://www.app.example.com are different entries, as are ports in local development.',
    fix: 'Add the exact origin to the key. Paths and wildcards are rejected at issue time, not silently ignored.',
  },
  {
    status: '429',
    body: 'Rate limit exceeded',
    cause:
      'The burst limit, counted in requests per key over a rolling window. Retry-After will be seconds.',
    fix: 'Honour Retry-After. This one clears on its own; a tight retry loop is what turns it into a sustained one.',
  },
  {
    status: '429',
    body: 'Monthly quota exceeded',
    cause:
      'The monthly unit allowance, counted across every key on the account. Retry-After will be large — it points at 00:00 UTC on the 1st.',
    fix: 'Upgrade, or wait for the reset. A quota 429 consumes nothing, so there is no charge for hitting it.',
  },
  {
    status: '400',
    body: 'Unsupported chainId · Unsupported protocol · Invalid poolId',
    cause:
      'A coverage or format boundary. We serve Uniswap v4 on Ethereum (1), Arbitrum One (42161) and Avalanche (43114); a v4 poolId is 0x plus 64 hex, a v3 one 0x plus 40.',
    fix: 'Check coverage before treating it as a bug. Any 4xx is refunded, so a malformed request costs no units.',
  },
  {
    status: '404',
    body: 'Position not found · Pool not found',
    cause:
      'No such id on that chain and protocol. Distinct from an empty list: a filtered search that matches nothing returns 200 with an empty array.',
    fix: 'Confirm the chainId and protocol in the path. An id from one chain will 404 against another.',
  },
] as const;

export default function SupportPage() {
  return (
    <MarketingShell>
      <div className="container-page py-16">
        <div className="container-narrow">
          <div className="text-xs uppercase tracking-widest text-primary">Support</div>
          <h1 className="mt-2 font-display text-4xl font-semibold">Help centre</h1>
          <p className="mt-2 text-muted-foreground">
            The failures worth recognising on sight. Each row is the literal response the API
            returns, so you can match what you are looking at against it — but branch your code on
            the status code, never on the message.
          </p>

          <ul className="mt-10 space-y-3">
            {FAILURES.map((f) => (
              <li key={f.body} className="rounded-xl border border-border/60 bg-surface p-4">
                <div className="font-mono text-sm">
                  <span className="text-primary">{f.status}</span>
                  <span className="text-muted-foreground"> · </span>
                  {f.body}
                </div>
                <div className="mt-2 text-sm text-muted-foreground">{f.cause}</div>
                <div className="mt-1 text-sm">{f.fix}</div>
              </li>
            ))}
          </ul>

          <h2 className="mt-12 font-display text-2xl font-semibold">Two answers that look wrong</h2>
          <div className="mt-4 space-y-3">
            <div className="rounded-xl border border-border/60 bg-surface p-4 text-sm text-muted-foreground">
              <strong className="text-foreground">An empty list is a valid 200.</strong> The list
              endpoints apply visibility filters by default — a minimum position value, a minimum
              pool TVL, and an exclusion of positions whose token has no corroborated market. A
              wallet holding only small or spam-token positions legitimately returns nothing. Widen
              them with{' '}
              <code className="font-mono text-xs text-foreground">
                minValueUsd=0&amp;minPoolTvl=0&amp;includeRisky=true&amp;status=all
              </code>{' '}
              before concluding the data is missing.
            </div>
            <div className="rounded-xl border border-border/60 bg-surface p-4 text-sm text-muted-foreground">
              <strong className="text-foreground">A missing price is reported, not faked.</strong>{' '}
              When a token cannot be priced from any independent source the position carries{' '}
              <code className="font-mono text-xs text-foreground">
                metrics.priceUnavailable: true
              </code>{' '}
              rather than a misleading zero. Treat that as unknown, not as worthless — a genuine
              zero also exists, and the two mean different things.
            </div>
          </div>

          <h2 className="mt-12 font-display text-2xl font-semibold">Before you escalate</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Check{' '}
            <Link href="/status" className="text-primary hover:underline">
              indexing freshness
            </Link>{' '}
            first. It reports the last indexed block against the chain head per chain, which is what
            separates &ldquo;this data does not exist&rdquo; from &ldquo;this data has not been
            indexed yet&rdquo; — and the second one resolves itself.
          </p>

          <div className="mt-6 rounded-2xl border border-primary/40 bg-primary/5 p-6">
            <div className="font-display text-lg font-semibold">Still stuck?</div>
            <p className="mt-1 text-sm text-muted-foreground">
              We do not stamp a request id on responses, so a trace starts from what you can see.
              Have ready: the full request URL including query string, the UTC timestamp, the status
              code, the verbatim <code className="font-mono text-xs">error</code> string from the
              body, and the{' '}
              <code className="font-mono text-xs">X-RateLimit-*</code> /{' '}
              <code className="font-mono text-xs">X-Quota-*</code> headers if it was a 429. Never
              send the key itself.
            </p>
            <Link
              href="/contact"
              className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
            >
              How to reach us →
            </Link>
          </div>

          <p className="mt-6 text-sm text-muted-foreground">
            Longer form on all of this:{' '}
            <Link href="/docs/errors" className="text-primary hover:underline">
              errors
            </Link>
            ,{' '}
            <Link href="/docs/authentication" className="text-primary hover:underline">
              authentication
            </Link>{' '}
            and{' '}
            <Link href="/docs/units-and-limits" className="text-primary hover:underline">
              units and limits
            </Link>
            .
          </p>
        </div>
      </div>
    </MarketingShell>
  );
}
