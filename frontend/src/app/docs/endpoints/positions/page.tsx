import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';
import { getPublicUnitCosts } from '@/lib/site-data';
import { QUICKSTART_BASE, Units } from '../reference';

export const metadata: Metadata = {
  title: 'Positions',
  description:
    'The three Tickwise position endpoints: the ranked list with every filter and sort, one position in full, and its reconstructed time series.',
};

/**
 * Reference for `/v1/positions`.
 *
 * Written against `backend/src/v1/v1-positions.controller.ts` and the DTO it
 * binds (`leaderboard/dto/top-positions-query.dto.ts`), because the design
 * source's version was wrong in ways a reader could not detect: it documented
 * `?chain=ethereum` (the parameter is `chainId`, and it takes a number) and
 * sort keys of the form `apr.desc` (direction is fixed per key and there is no
 * suffix to pass). Both would have produced a 400 or a silently ignored
 * parameter for anyone who copied them.
 *
 * Unit costs are fetched rather than typed — see `Units` in `../reference`.
 */
export default async function PositionsEndpointsPage() {
  const costs = await getPublicUnitCosts();

  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-widest text-primary">Endpoints</div>
        <h1 className="font-display text-4xl font-semibold">Positions</h1>
        <p className="text-muted-foreground">
          Uniswap v4 liquidity positions on <strong>Ethereum (1)</strong>,{' '}
          <strong>Arbitrum One (42161)</strong> and <strong>Avalanche (43114)</strong>. Every filter and
          sort the dashboard uses is on the same endpoint — there is no reduced public subset.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">
          GET /v1/positions{' '}
          <span className="mono">
            — <Units costs={costs} routeKey="v1.positions.list" />
          </span>
        </h2>
        <p className="text-muted-foreground">A ranked, filtered, paginated page of positions.</p>
        <CodeBlock
          lang="bash"
          code={`curl -s "${QUICKSTART_BASE}/v1/positions?chainId=1&sort=apr&limit=25" \\
  -H "KC-APIKey: $TICKWISE_API_KEY"`}
        />

        <h3 className="font-display text-xl font-semibold">Query parameters</h3>
        <p className="text-muted-foreground">
          Everything is optional. The defaults are not neutral — they are the visibility filters
          that keep spam and dust out of a ranking — so read the last three rows before concluding a
          position is missing.
        </p>
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
                  <code>1</code> or <code>43114</code>. <strong>Omitting it means every enabled
                  chain</strong>, merged into one ranking — not Ethereum. An unregistered id is a 400.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">protocol</td>
                <td className="px-4 py-2 font-mono text-xs">uniswap-v4</td>
                <td className="px-4 py-2">
                  The only value served. <code>uniswap-v3</code> is a 400 — see{' '}
                  <Link href="/docs/coverage">coverage</Link>.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">sort</td>
                <td className="px-4 py-2 font-mono text-xs">apr</td>
                <td className="px-4 py-2">
                  One of <code>apr</code>, <code>fee_apr</code>, <code>roi</code>, <code>pnl</code>,{' '}
                  <code>underlying_value</code>, <code>age</code>, <code>nft_id_asc</code>,{' '}
                  <code>nft_id_desc</code>. <strong>Direction is part of the key, not a separate
                  parameter</strong>: everything is descending except <code>nft_id_asc</code>.{' '}
                  <code>age</code> orders by creation time, newest first, on every{' '}
                  <code>status</code> — closed rows are not ordered by how long they were held.
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
                <td className="px-4 py-2">1–100. A larger value is a 400 rather than a silent clamp.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">status</td>
                <td className="px-4 py-2 font-mono text-xs">open only</td>
                <td className="px-4 py-2">
                  <code>active</code>, <code>inactive</code> or <code>all</code> — open, closed, or
                  both. Unset behaves as <code>active</code>, because the older{' '}
                  <code>activeOnly</code> flag it supersedes defaults to true; pass{' '}
                  <code>status=all</code> to see closed positions.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">range</td>
                <td className="px-4 py-2 font-mono text-xs">all</td>
                <td className="px-4 py-2">
                  <code>in</code> or <code>out</code> restricts to positions whose range currently
                  contains the pool tick, or does not.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">owner</td>
                <td className="px-4 py-2 font-mono text-xs">—</td>
                <td className="px-4 py-2">
                  A 0x-prefixed 40-hex EVM address, matched case-insensitively. Anything else is a
                  400 with a message naming the format.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">poolId</td>
                <td className="px-4 py-2 font-mono text-xs">—</td>
                <td className="px-4 py-2">Every position in one pool.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">positionId</td>
                <td className="px-4 py-2 font-mono text-xs">—</td>
                <td className="px-4 py-2">
                  Exact match on a single id — the tokenId for an ERC-721 protocol. The other filters
                  still apply, so a known id can still return nothing if it fails them.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">minValueUsd</td>
                <td className="px-4 py-2 font-mono text-xs">0</td>
                <td className="px-4 py-2">Floor on current underlying value.</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">minPoolTvl</td>
                <td className="px-4 py-2 font-mono text-xs">1000</td>
                <td className="px-4 py-2">
                  Floor on the pool&rsquo;s TVL. <strong>Not zero</strong> — this is the one default
                  that silently hides real positions in small pools.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">includeRisky</td>
                <td className="px-4 py-2 font-mono text-xs">false</td>
                <td className="px-4 py-2">
                  Admits positions whose token has no corroborated on-chain market. Off by default
                  because a ranking full of issuer-seeded spam pools is worthless.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="font-display text-xl font-semibold">Response</h3>
        <p className="text-muted-foreground">
          A <code>positions</code> array and a <code>pagination</code> object. Each row carries{' '}
          <code>rank</code>, identity (<code>positionId</code>, <code>tokenId</code>,{' '}
          <code>chainId</code>, <code>protocol</code>, <code>owner</code>, <code>poolId</code>), both{' '}
          token snapshots, the range (<code>tickLower</code>, <code>tickUpper</code>,{' '}
          <code>currentTick</code>, <code>tickSpacing</code>, <code>fee</code>,{' '}
          <code>liquidity</code>, <code>isActive</code>), and four nested groups:{' '}
          <code>amounts</code> (token-denominated deposits, withdrawals, collected and uncollected
          fees, gas), <code>metrics</code> (<code>apr</code>, <code>feeApr</code>, <code>roi</code>,{' '}
          <code>pnlUsd</code>, <code>underlyingValueUsd</code>, <code>pendingFeesUsd</code>,{' '}
          <code>feesSource</code>, <code>feesMeasuredAt</code>, <code>ageSeconds</code>,{' '}
          <code>inRange</code>), <code>poolStats</code> and <code>pricing</code>.
        </p>
        <p className="text-muted-foreground">
          <strong>
            <code>risk</code> labels a position we would not rank, present only when it applies.
          </strong>{' '}
          <code>risk.flags</code> lists why: <code>symbol-spoof</code> (a token uses a major
          token&rsquo;s symbol, such as USDT, at another contract), <code>phishing-symbol</code> (a
          token&rsquo;s symbol carries a link or &ldquo;visit&rdquo;), <code>excluded-token</code> (a
          token is on our exclusion list: a security scan marked it unsafe or fake, or it has no real
          market) and <code>risky-pool</code> (its pool&rsquo;s value cannot be relied on). Lists
          leave positions in excluded tokens out, so <code>excluded-token</code> appears on a{' '}
          <code>positionId</code> lookup and on position detail. Ignore flag values you do not
          recognise.
        </p>
        <p className="text-muted-foreground">
          <strong>
            <code>hooks</code> and <code>customAccounting</code> describe the position&rsquo;s pool
            hook, and are present only when that pool has a v4 hook.
          </strong>{' '}
          <code>hooks</code> is the hook contract address, lower case. <code>customAccounting</code>{' '}
          is <code>true</code> when the hook&rsquo;s address sets one of the four returns-delta
          permissions, which let a hook take or redirect value that the pool&rsquo;s swap and
          liquidity events do not show; the fee and value figures on such a position are not provably
          complete. They come from the pool, so a position whose pool the pool sync has not revisited
          yet lacks them. Both are on list rows and on detail.
        </p>
        <p className="text-muted-foreground">
          <strong>
            <code>metrics.feesSource</code> says where the uncollected-fee figure came from.
          </strong>{' '}
          It applies to <code>pendingFeesUsd</code> and to the uncollected token amounts in{' '}
          <code>amounts</code>. Open positions are re-read on-chain by a recurring pass, and earlier
          when the indexer sees a position change, when it is newly indexed, or when its detail is
          requested. A position not written since the field was added can lack it; read a missing
          value as <code>unmeasured</code>.
        </p>
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2 font-medium">feesSource</th>
                <th className="px-4 py-2 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              <tr>
                <td className="px-4 py-2 font-mono text-xs">onchain</td>
                <td className="px-4 py-2">
                  Read from the chain&rsquo;s pool state at or after the position&rsquo;s last
                  liquidity change, which is the last event that settles fees.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">indexer</td>
                <td className="px-4 py-2">
                  <strong>No longer returned.</strong> It labelled the indexer&rsquo;s own fee
                  reading, which the indexer no longer produces: the figure now comes from the
                  on-chain reading alone, and a position without one is{' '}
                  <code>unmeasured</code>. The value stays in the list so a client that switches over
                  every <code>feesSource</code> keeps working; a position not written since the change
                  can still carry it until its next write.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">settled</td>
                <td className="px-4 py-2">
                  The position holds no liquidity. The change that emptied it paid out every fee owed
                  and nothing accrues afterwards, so <code>0</code> is exact. Closed positions are not
                  re-read.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-xs">unmeasured</td>
                <td className="px-4 py-2">
                  No on-chain reading at or after the last liquidity change. The figure is a
                  placeholder <code>0</code>, not a measurement: treat it as unknown. The dashboard
                  shows it as <em>Pending</em>.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground">
          <code>metrics.feesMeasuredAt</code> is the ISO time of the on-chain reading behind the
          figure. It is <code>null</code> or absent unless <code>feesSource</code> is{' '}
          <code>onchain</code>, and can be <code>null</code> on an <code>onchain</code> figure read
          before the field was added. A re-read that finds no material change is not always written
          back, so the timestamp can be older than the most recent check. It dates the fee figure
          only; the response-level{' '}
          <code>dataAsOf</code> below dates the read of the stored data.
        </p>
        <CodeBlock
          lang="json"
          code={`"pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 1, "hasMore": false }`}
        />
        <p className="text-muted-foreground">
          <strong>Page with <code>hasMore</code>, not <code>totalPages</code>.</strong>{' '}
          <code>hasMore</code> is always exact: each page reads one row past itself. The count behind{' '}
          <code>total</code> runs separately and is cached; when it is not ready within about two
          seconds, or when it reaches its cap of 25,000, the response carries{' '}
          <code>&quot;totalCapped&quot;: true</code> and <code>total</code> /{' '}
          <code>totalPages</code> are a <em>floor</em>: the number of rows that page proves exist,
          not the size of the result set. Without <code>totalCapped</code>, <code>total</code> is
          exact, in all-chains mode too (the merge sums each shard&rsquo;s own count). A loop that
          stops at <code>totalPages</code> from the first response can stop early. Loop until{' '}
          <code>hasMore</code> is <code>false</code>.
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
          Two fields on <code>metrics</code> exist to stop you reading a gap as a number.{' '}
          <code>priceUnavailable</code> marks a leg that could not be priced from any independent
          source, and <code>unrealizableLeg</code> marks one valued at zero because the claim exceeds
          the pool&rsquo;s real exit liquidity. Neither is the same as a genuine zero.
        </p>
        <p className="text-muted-foreground">
          The rate sorts — <code>apr</code>, <code>fee_apr</code>, <code>roi</code> — exclude closed
          and no-value positions rather than ranking them on a stale stored rate. <code>pnl</code>{' '}
          does not: realised PnL on a closed position is a real number and belongs in that ranking.
          With <code>status=inactive</code>, a rate sort is served as <code>pnl</code>, because a
          closed position has no current rate: <code>?status=inactive&amp;sort=apr</code> returns
          closed positions ranked by PnL, not an empty page. With <code>status=active</code> or{' '}
          <code>all</code>, the rate sorts still leave closed and no-value rows out.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">
          GET /v1/positions/{'{chainId}'}/{'{protocol}'}/{'{positionId}'}{' '}
          <span className="mono">— <Units costs={costs} routeKey="v1.positions.detail" /></span>
        </h2>
        <p className="text-muted-foreground">
          One position in full, plus a <code>transactions</code> array the list endpoint does not
          carry: every mint, burn, collect and transfer with its token amounts, gas and per-transaction
          USD valuation.
        </p>
        <CodeBlock
          lang="bash"
          code={`curl -s "${QUICKSTART_BASE}/v1/positions/1/uniswap-v4/12345" \\
  -H "KC-APIKey: $TICKWISE_API_KEY"`}
        />
        <p className="text-muted-foreground">
          An id that does not exist on that chain and protocol is a <strong>404</strong>, not an empty
          object — and an id from the other chain will 404 here, which is the usual cause.
        </p>
        <p className="text-muted-foreground">
          The transaction list can come back incomplete, and says so rather than looking empty.{' '}
          <code>transactionsDegraded</code> is on every detail response; <code>true</code> means
          the full list could not be loaded for this response. On its own, the array is empty
          because the transaction source failed or did not answer in time, which is not the same as
          a position with no transactions. With it,{' '}
          <code>&quot;transactionsPartial&quot;: true</code> means the array
          holds only the position&rsquo;s newest transactions (up to 1,000) while the full history
          loads: ask again a few seconds later. <code>&quot;transactionsTruncated&quot;: true</code>{' '}
          means the history is longer than 100,000 transactions and the newest are missing. A degraded
          answer is not charged. <code>&quot;stale&quot;: true</code> with <code>dataAsOf</code> means
          the position itself was read from a database replica running more than 45 seconds behind.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">
          GET /v1/positions/{'{chainId}'}/{'{protocol}'}/{'{positionId}'}/charts{' '}
          <span className="mono">— <Units costs={costs} routeKey="v1.positions.charts" /></span>
        </h2>
        <p className="text-muted-foreground">
          Time series for one position. <code>?range=30d|60d|90d|180d|all</code>, defaulting to{' '}
          <code>30d</code>; an unrecognised value falls back to <code>30d</code> rather than erroring,
          because the alternative is letting a typo fan out unbounded queries against a paid upstream.
        </p>
        <CodeBlock
          lang="bash"
          code={`curl -s "${QUICKSTART_BASE}/v1/positions/1/uniswap-v4/12345/charts?range=90d" \\
  -H "KC-APIKey: $TICKWISE_API_KEY"`}
        />
        <p className="text-muted-foreground">
          The response carries <code>poolPrice</code> (daily OHLC plus both token prices),{' '}
          <code>poolOverview</code> (TVL, volume, fees, fees/TVL, both prices),{' '}
          <code>liquidityDistribution</code> (the tick histogram, with this position&rsquo;s{' '}
          <code>tickLower</code> and <code>tickUpper</code> marked), <code>positionSeries</code> (PnL,
          asset value, APR, fee APR, divergence loss) and <code>poolOverviewCurrent</code>.
        </p>
        <p className="text-muted-foreground">
          A range is the last 30, 60, 90 or 180 days counted back from the newest data point the
          series holds, not from today.{' '}
          <code>all</code> starts at the position&rsquo;s creation.
        </p>
        <p className="text-muted-foreground">
          <strong>A chart can come back incomplete, and says so.</strong> When an input could not be
          loaded for this response, the response adds <code>&quot;partial&quot;: true</code> and{' '}
          <code>missing</code>, the inputs left out: any of <code>poolDayData</code>,{' '}
          <code>ticks</code>, <code>token0DayData</code>, <code>token1DayData</code> and{' '}
          <code>transactions</code>. Without <code>poolDayData</code> the price and overview sections
          are empty, and without <code>ticks</code> the histogram is; without a token&rsquo;s day
          data the position series values that token from the pool price instead. For a
          position with a long history whose full transaction list is still loading,{' '}
          <code>&quot;missing&quot;: [&quot;transactions&quot;]</code> comes with{' '}
          <code>positionSeries: null</code>, because the series is a running sum from the first
          transaction and cannot start from the middle; ask again a few seconds later.{' '}
          <code>transactions</code> is also listed when the history is longer than the 100,000
          transactions read, since the series then stops short of the newest flows. Neither flag is
          present on a complete response, and a <code>partial</code> response is not charged.
        </p>
        <p className="text-muted-foreground">
          Three honest caveats. <code>positionSeries</code> is <strong>null</strong> when the series
          cannot be reconstructed, and null is not zero. <code>poolOverview.divergence</code> is{' '}
          <strong>always empty</strong> — the upstream schema does not carry it, and the key is present
          only so it can be filled without a breaking change. And this is the most expensive route we
          serve: it is a multi-query fan-out to an upstream we pay per call for, which is what the unit
          cost reflects.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Next</h2>
        <p className="text-muted-foreground">
          <Link href="/docs/endpoints/pools">Pools</Link> — the same three shapes for pools.{' '}
          <Link href="/docs/units-and-limits">Units and limits</Link> — why a list costs more than a
          detail. <Link href="/docs/errors">Errors</Link> — every status code and whether retrying
          helps.
        </p>
      </div>
    </>
  );
}
