import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';
import { getPublicUnitCosts } from '@/lib/site-data';
import { QUICKSTART_BASE, Units } from '../reference';

export const metadata: Metadata = {
  title: 'Metadata',
  description:
    'GET /v1/chains and GET /v1/protocols — the free, unmetered endpoints that tell you which chains and protocols the Tickwise API will accept.',
};

/**
 * Reference for the two registry endpoints.
 *
 * Two corrections to the design source, both of which would have broken a
 * client that trusted them. It showed `{"data": [...]}` envelopes and
 * `{"id": "ethereum"}` identifiers; the controller returns a **bare array**,
 * and the field a request actually takes is the numeric `chainId`. A slug
 * exists but is not what `/v1/positions` binds.
 *
 * The authentication note is deliberately explicit. `V1MetadataController`
 * carries no `@UseGuards`, so these two routes answer without a key at all —
 * distinct from being metered at zero, which is what the pricing table's 0
 * describes. Both statements are true and they are not the same statement.
 */
export default async function MetadataEndpointsPage() {
  const costs = await getPublicUnitCosts();

  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-widest text-primary">Endpoints</div>
        <h1 className="font-display text-4xl font-semibold">Metadata</h1>
        <p className="text-muted-foreground">
          The registry the rest of the API validates against. Read it once at startup to populate a
          chain or protocol picker, rather than hard-coding a list that will disagree with us the day
          we enable something.
        </p>
      </div>

      <p className="text-muted-foreground">
        Both routes are <strong>unauthenticated and unmetered</strong>. They take no{' '}
        <code>KC-APIKey</code> header, and the pricing table lists them at{' '}
        <Units costs={costs} routeKey="v1.chains" /> — they are an in-process registry read, with no
        database and no fan-out behind them.
      </p>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">
          GET /v1/chains{' '}
          <span className="mono">
            — <Units costs={costs} routeKey="v1.chains" />
          </span>
        </h2>
        <CodeBlock lang="bash" code={`curl -s "${QUICKSTART_BASE}/v1/chains"`} />
        <p className="text-muted-foreground">
          Returns a <strong>bare array</strong> — no <code>data</code> wrapper — of every registered
          chain, each with:
        </p>
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2 font-medium">Field</th>
                <th className="px-4 py-2 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              <tr>
                <td className="px-4 py-2 font-mono text-xs">chainId</td>
                <td className="px-4 py-2">
                  The number. <strong>This is the value every other endpoint takes</strong> — as{' '}
                  <code>?chainId=</code> on a list, and as the first path segment on a detail or chart
                  route.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">slug, name, shortName</td>
                <td className="px-4 py-2">
                  Display identifiers. None of them is accepted as a query parameter.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">explorerUrl</td>
                <td className="px-4 py-2">Block-explorer base, for linking an address or transaction.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">nativeToken, wrappedNativeToken</td>
                <td className="px-4 py-2">
                  Symbols and addresses, for denominating gas and native-token amounts.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">protocols</td>
                <td className="px-4 py-2">
                  <strong>The field that matters.</strong> Which protocols are enabled on that chain{' '}
                  <em>in this deployment</em>. A chain listed here with an <strong>empty</strong>{' '}
                  array is registered but serves nothing — a request against it is a 400.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground">
          That last row is the whole reason to call this endpoint rather than hard-code{' '}
          <code>[1, 43114]</code>. Registered and servable are different states, and only{' '}
          <code>protocols</code> distinguishes them.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">
          GET /v1/protocols{' '}
          <span className="mono">— <Units costs={costs} routeKey="v1.protocols" /></span>
        </h2>
        <CodeBlock lang="bash" code={`curl -s "${QUICKSTART_BASE}/v1/protocols"`} />
        <p className="text-muted-foreground">
          A bare array of the protocols that are enabled <em>somewhere</em>, each with{' '}
          <code>key</code> (the value to send as <code>?protocol=</code>), <code>displayName</code>,{' '}
          <code>version</code>, <code>family</code>, <code>chains</code> — the chain ids it is enabled
          on — and <code>enabled</code>.
        </p>
        <p className="text-muted-foreground">
          A protocol that is configured but switched off does not appear at all, so the list is
          &ldquo;what you may ask for&rdquo; rather than &ldquo;what exists in our config&rdquo;. Today
          that is <strong>Uniswap v4 only</strong>.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Rendered coverage</h2>
        <p className="text-muted-foreground">
          <Link href="/docs/coverage">The coverage page</Link> is this data, formatted — it is
          generated from <code>GET /v1/chains</code> at request time rather than written by hand, so a
          page and a request cannot disagree.{' '}
          <Link href="/status">Status</Link> adds live indexing lag per chain, which the registry does
          not carry.
        </p>
      </div>
    </>
  );
}
