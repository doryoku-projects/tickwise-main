import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';
import { getPublicUnitCosts } from '@/lib/site-data';
import { QUICKSTART_BASE, Units } from '../reference';

export const metadata: Metadata = {
  title: 'Pools',
  description:
    'The three Tickwise pool endpoints: the ranked list by TVL, volume, fees or fee APR, one pool in full, and its time series.',
};

/**
 * Reference for `/v1/pools`.
 *
 * Written against `backend/src/v1/v1-pools.controller.ts` and
 * `pools/dto/top-pools-query.dto.ts`. The design source documented this route
 * in four lines and got both the parameter (`chain=ethereum`, not `chainId=1`)
 * and the sort grammar (`tvl.desc`) wrong; it also omitted the poolId format
 * check, which is the single most likely 400 a first integration will hit.
 */
export default async function PoolsEndpointsPage() {
  const costs = await getPublicUnitCosts();

  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-widest text-primary">Endpoints</div>
        <h1 className="font-display text-4xl font-semibold">Pools</h1>
        <p className="text-muted-foreground">
          Uniswap v4 pools on <strong>Ethereum (1)</strong>, <strong>Arbitrum One (42161)</strong> and{' '}
          <strong>Avalanche (43114)</strong>, ranked by TVL, 24h volume, 24h fees, fee APR or age.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">
          GET /v1/pools{' '}
          <span className="mono">
            — <Units costs={costs} routeKey="v1.pools.list" />
          </span>
        </h2>
        <CodeBlock
          lang="bash"
          code={`curl -s "${QUICKSTART_BASE}/v1/pools?chainId=1&sort=tvl&limit=25" \\
  -H "KC-APIKey: $TICKWISE_API_KEY"`}
        />

        <h3 className="font-display text-xl font-semibold">Query parameters</h3>
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2 font-medium">Parameter</th>
                <th className="px-4 py-2 font-medium">Default</th>
                <th className="px-4 py-2 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              <tr>
                <td className="px-4 py-2 font-mono text-xs">chainId</td>
                <td className="px-4 py-2 font-mono text-xs">all chains</td>
                <td className="px-4 py-2">
                  <code>1</code> or <code>43114</code>. Omitting it merges every enabled chain into
                  one ranking.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">protocol</td>
                <td className="px-4 py-2 font-mono text-xs">uniswap-v4</td>
                <td className="px-4 py-2">The only value served; anything else is a 400.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">sort</td>
                <td className="px-4 py-2 font-mono text-xs">tvl</td>
                <td className="px-4 py-2">
                  <code>tvl</code>, <code>volume</code>, <code>fees</code>, <code>fee_apr</code> or{' '}
                  <code>age</code>. Descending except <code>age</code>, which is oldest first. There
                  is no direction parameter.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">page</td>
                <td className="px-4 py-2 font-mono text-xs">1</td>
                <td className="px-4 py-2">1-based.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">limit</td>
                <td className="px-4 py-2 font-mono text-xs">20</td>
                <td className="px-4 py-2">1–100.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">minTvlUsd</td>
                <td className="px-4 py-2 font-mono text-xs">0</td>
                <td className="px-4 py-2">Floor on pool TVL.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">includeRisky</td>
                <td className="px-4 py-2 font-mono text-xs">false</td>
                <td className="px-4 py-2">
                  Admits pools whose tokens have no corroborated on-chain market.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">search</td>
                <td className="px-4 py-2 font-mono text-xs">—</td>
                <td className="px-4 py-2">
                  Case-insensitive substring over either token symbol, either token address, or the
                  pool id. Up to 64 characters. <strong>It is a lookup, not a filter</strong>: the
                  spam-token exclusion is skipped while searching, so a pool you name stays findable.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="font-display text-xl font-semibold">Response</h3>
        <p className="text-muted-foreground">
          A <code>pools</code> array and the same <code>pagination</code> envelope the positions list
          uses. Each row carries <code>rank</code>, <code>poolId</code>, <code>chainId</code>,{' '}
          <code>protocol</code>, both token snapshots, <code>fee</code>, <code>isDynamicFee</code>,{' '}
          <code>tickSpacing</code>, <code>currentTick</code>, <code>sqrtPriceX96</code>,{' '}
          <code>liquidity</code>, <code>createdAtTimestamp</code>, a <code>metrics</code> group (
          <code>tvlUsd</code>, <code>volumeUsd24h</code>, <code>volumeUsd7d</code>,{' '}
          <code>feesUsd24h</code>, <code>feesUsd7d</code>, <code>feeApr</code>, <code>txCount</code>,{' '}
          <code>currentPrice</code>), <code>pricing</code>, and two counts the underlying subgraph does
          not provide: <code>positionsCount</code> (open positions) and <code>holdersCount</code>{' '}
          (distinct owners). The same rules apply to <code>total</code> here: it is a floor when{' '}
          <code>totalCapped</code> is <code>true</code>, so page with <code>hasMore</code>.
        </p>
        <p className="text-muted-foreground">
          The two counts are computed separately from the pool rows. For a very large pool they can
          still be in progress when the response is built. Those pools then carry{' '}
          <code>null</code> for both counts, and the list response adds{' '}
          <code>&quot;countsPending&quot;: true</code>. Read <code>null</code> as &ldquo;not known yet&rdquo;,
          not as zero. A later request returns the numbers.
        </p>
        <p className="text-muted-foreground">
          <strong>
            <code>risk</code> labels a row we would not rank, present only when it applies.
          </strong>{' '}
          <code>risk.flags</code> lists why: <code>symbol-spoof</code> (a token uses a major
          token&rsquo;s symbol, such as USDT, at another contract), <code>phishing-symbol</code> (a
          token&rsquo;s symbol carries a link or &ldquo;visit&rdquo;), <code>excluded-token</code> (a
          token is on our exclusion list: a security scan marked it unsafe or fake, or it has no real
          market) and <code>risky-pool</code> (the pool&rsquo;s value cannot be relied on; these are the
          pools <code>includeRisky=false</code> hides). The ranked list already leaves such pools out,
          so the field mostly appears on <code>search</code> results and pool detail, which keep a pool
          you name. Ignore flag values you do not recognise.
        </p>
        <p className="text-muted-foreground">
          <strong>
            <code>hooks</code> and <code>customAccounting</code> describe a pool&rsquo;s v4 hook, and
            are present only on a pool that has one.
          </strong>{' '}
          <code>hooks</code> is the hook contract address, lower case; a pool without a hook carries
          neither field. <code>customAccounting</code> is <code>true</code> when the hook&rsquo;s
          address sets one of the four returns-delta permissions, which let a hook take or redirect
          value that the pool&rsquo;s swap and liquidity events do not show. It is read from the
          address alone and says nothing about intent. On such a pool the volume, LP fees and TVL
          are what moved through the pool&rsquo;s own liquidity and are not affected, but what the
          hook itself takes is in none of them, and a position&rsquo;s deposited, withdrawn and
          collected amounts can exceed what its owner actually paid or received. A dynamic-fee pool keeps{' '}
          <code>isDynamicFee: true</code> and carries these fields as well. A pool gains the fields
          the next time pool sync revisits it after this was released.
        </p>
        <p className="text-muted-foreground">
          <strong>Two more flags, each present only when it applies.</strong> In all-chains mode
          (no <code>chainId</code>), a chain whose data is temporarily unavailable is left out
          rather than failing the whole request: the response adds{' '}
          <code>&quot;partial&quot;: true</code> and <code>&quot;missingChains&quot;: [&hellip;]</code>,
          the rows are the other chains&rsquo; merged order, <code>total</code> counts only those
          chains, and the request is not charged. Data older than the usual 45-second freshness is
          only ever served flagged: it carries <code>&quot;stale&quot;: true</code> and{' '}
          <code>dataAsOf</code>, the time it was current. That happens when the database is too slow
          to answer (the last page we served comes back instead), when the database replica it was
          read from is running behind, and on a very deep page whose position in the list was
          counted more than 45 seconds ago. There is no page cap. Paging forward from one page to
          the next is cheap; the first visit to a very deep page can answer <code>503</code> with{' '}
          <code>Retry-After</code> while it is still being reached, and the retry continues from
          where that request got to.
        </p>
        <p className="text-muted-foreground">
          <strong>
            <code>feeApr</code> is clamped at ±100,000%
          </strong>{' '}
          on the way out. The upstream v4 subgraph&rsquo;s <code>feesUSD</code> is known to produce
          values in the hundreds of thousands of percent on thin pools; clamping at read time keeps a
          stale document from dominating a <code>fee_apr</code> ranking. A value sitting exactly on the
          cap should be read as &ldquo;not trustworthy&rdquo;, not as a measurement.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">
          GET /v1/pools/{'{chainId}'}/{'{protocol}'}/{'{poolId}'}{' '}
          <span className="mono">— <Units costs={costs} routeKey="v1.pools.detail" /></span>
        </h2>
        <p className="text-muted-foreground">
          One pool, in the same shape as a list row plus its counts.{' '}
          <strong>
            <code>poolId</code> is validated before anything else happens
          </strong>
          : a v4 pool id is <code>0x</code> plus 64 hex characters, a v3 pool address{' '}
          <code>0x</code> plus 40. Anything else is a 400 with{' '}
          <code>{'{"error":"Invalid poolId"}'}</code>, rejected here rather than fanned out to a
          metered upstream.
        </p>
        <CodeBlock
          lang="bash"
          code={`curl -s "${QUICKSTART_BASE}/v1/pools/1/uniswap-v4/0x…64hex" \\
  -H "KC-APIKey: $TICKWISE_API_KEY"`}
        />
        <p className="text-muted-foreground">
          Ids are matched lowercased, so case in the path does not matter. A pool that exists on the
          other chain is a 404 here.
        </p>
        <p className="text-muted-foreground">
          Like the list, a pool older than the 45-second freshness — its holder counts kept past
          their freshness, a database replica running behind, or the last copy served because the
          database was too slow — carries <code>&quot;stale&quot;: true</code> and{' '}
          <code>dataAsOf</code>, the time it was current.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">
          GET /v1/pools/{'{chainId}'}/{'{protocol}'}/{'{poolId}'}/charts{' '}
          <span className="mono">— <Units costs={costs} routeKey="v1.pools.charts" /></span>
        </h2>
        <p className="text-muted-foreground">
          <code>?range=30d|60d|90d|180d|all</code>, defaulting to <code>30d</code>; an unrecognised
          value falls back to <code>30d</code> rather than erroring.
        </p>
        <CodeBlock
          lang="bash"
          code={`curl -s "${QUICKSTART_BASE}/v1/pools/1/uniswap-v4/0x…64hex/charts?range=90d" \\
  -H "KC-APIKey: $TICKWISE_API_KEY"`}
        />
        <p className="text-muted-foreground">
          Carries <code>poolPrice</code> (daily OHLC), <code>poolOverview</code>,{' '}
          <code>liquidityDistribution</code> (the tick histogram, with no position range marked —
          that is the difference from the position variant), <code>poolSeries</code> (volume, TVL,
          fees, fee APR) and <code>poolOverviewCurrent</code>, which is null when the pool has no day
          data. A range is counted back from the pool&rsquo;s newest day of data, not from today;{' '}
          <code>all</code> is the last 365 days.
        </p>
        <p className="text-muted-foreground">
          Each <code>poolPrice</code> point also carries <code>tick</code>: the pool&rsquo;s tick
          after its last indexed event of that UTC day, an integer in the same units as a
          position&rsquo;s <code>tickLower</code> and <code>tickUpper</code>, so a position was in
          range at a day&rsquo;s close when <code>{'tickLower <= tick < tickUpper'}</code>. It is{' '}
          <code>null</code>, not <code>0</code>, when the indexer has no valid tick for that day. A
          day with no pool activity has no point, so a gap is not a day out of range: the previous
          point&rsquo;s tick still holds. One tick per day says nothing about moves within the day.
        </p>
        <p className="text-muted-foreground">
          When an input could not be loaded for this response, the response adds{' '}
          <code>&quot;partial&quot;: true</code> and <code>missing</code>, the inputs left out: any
          of <code>poolState</code>, <code>poolDayData</code> and <code>ticks</code>. Without{' '}
          <code>poolDayData</code> the price, overview and series sections are empty, and without{' '}
          <code>ticks</code> the histogram is, so read an empty series alongside{' '}
          <code>partial</code> as &ldquo;not loaded&rdquo;, not as &ldquo;no activity&rdquo;.{' '}
          <code>poolState</code> is the exception: without it the histogram is still returned, but{' '}
          <code>liquidityDistribution.currentTick</code> is <code>0</code> and its{' '}
          <code>price0</code>, <code>price1</code>, <code>amount0</code> and <code>amount1</code>{' '}
          assume 18 decimals for both tokens and a tick spacing of 60, so ignore <code>liquidityDistribution</code> whenever{' '}
          <code>missing</code> includes <code>poolState</code>. Neither
          flag is present on a complete response, and a <code>partial</code> response is not
          charged.
        </p>
        <p className="text-muted-foreground">
          As on positions, <code>poolOverview.divergence</code> is always empty: the upstream schema
          does not carry it, and the key exists so it can be filled later without breaking clients.
          This route is the expensive one — see{' '}
          <Link href="/docs/units-and-limits">units and limits</Link>.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Next</h2>
        <p className="text-muted-foreground">
          <Link href="/docs/endpoints/metadata">Metadata</Link> — the free endpoints that tell you
          which chains and protocols to pass.{' '}
          <Link href="/docs/endpoints/positions">Positions</Link> — the same three shapes for
          positions.
        </p>
      </div>
    </>
  );
}
