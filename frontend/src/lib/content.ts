/**
 * Authored site content — copy we own, with no endpoint behind it.
 *
 * Deliberately separate from `lib/site-data.ts`, which serves MEASUREMENTS. The
 * distinction is the one that keeps the marketing pages honest: a measurement
 * with no source renders as unavailable, whereas authored copy is simply
 * whatever we wrote.
 */

export interface ChangelogEntry {
  /** ISO date, `YYYY-MM-DD`. Rendered verbatim, so keep the format. */
  date: string;
  title: string;
  body: string;
}

/**
 * Release notes, newest first.
 *
 * Backfilled from git history on 2026-08-19. Every entry maps to a real commit on
 * its real commit date — the page shipped EMPTY before this precisely because the
 * design source's three sample entries were invented, and announcing a release
 * that did not happen on a day it did not happen is the failure mode this list
 * exists to avoid. If you cannot point at the commit, do not add the entry.
 *
 * Two things to know when reading the older entries:
 *
 * 1. **The product was called CopyPools until 2026-08-14.** Entries describe the
 *    capability, never the old brand. The `KC-APIKey` header and the `kc_live_`
 *    key prefix are CopyPools-era names that are deliberately still current —
 *    they are wire contracts.
 * 2. **Anything before 2026-06-01 predates the metered API.** Those changes were
 *    reachable only on the unauthenticated `/api/*` dashboard routes, so they are
 *    worded as data and behaviour changes rather than `/v1` endpoint launches.
 *
 * Breaking changes are prefixed `Breaking:` in the title.
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-10-14',
    title: 'Breaking: the keyless /api lists serve at most 25 rows a page',
    body:
      'The keyless /api list routes (/api/top-positions and /api/top-pools) began answering 400 for a limit above 25, and the position chart route (/api/top-positions/{chainId}/{protocol}/{positionId}/charts) began answering 400 for a position id that is not made of digits. These routes are the data API behind the dashboards, which ask for 25 rows a page and are unaffected. The metered /v1 API is unchanged and still serves up to 100 rows a page.',
  },
  {
    date: '2026-10-14',
    title: 'Pool charts include the indexed daily tick',
    body:
      'Pool chart responses (GET /v1/pools/{chainId}/{protocol}/{poolId}/charts) include tick on each poolPrice point. It is the canonical tick from that indexed daily observation, or null when unavailable or invalid. Consumers can compare daily observations with a position’s tick range without inferring token order from a displayed price. Daily samples do not describe every intraday price movement. Existing price fields and position chart responses are unchanged.',
  },
  {
    date: '2026-10-07',
    title: 'Impersonator and phishing tokens left out of ranked lists, and labelled where they still appear',
    body:
      'The ranked position and pool lists (GET /v1/positions, GET /v1/pools and /explore) now also leave out a token that uses the symbol of a major token, such as USDT or WETH, at a different contract; a token whose symbol carries a link or the word "visit"; and, as each token\'s security check is refreshed, a token GoPlus reports as a fake of another token. Pool and position rows and their detail gained a risk field, present only when it applies, whose flags say why: symbol-spoof, phishing-symbol, excluded-token or risky-pool. Pool search and position id lookups still return such rows, now labelled, and /explore marks them Spam, Flagged or Risky pool.',
  },
  {
    date: '2026-10-07',
    title: 'Unchanged positions are no longer rewritten on every refresh',
    body:
      'A position whose amounts, prices, fees and status did not change between two refreshes is no longer rewritten each time. Three served figures behave differently as a result. Gas cost in USD (totalGasCostUsd), and pnlHodl, roi and apr through it, is re-valued at the current ETH price when the position is next written in full: every 4.5 to 7.5 hours for a position that holds value, every 18 to 30 hours for one that holds none. It used to be re-valued on every refresh. apr, aprExGas, feeApr and poolApr are computed from the position age rounded down in steps of at most 1% of that age and at most 6 hours, so on an unchanged position they can sit up to 1% (relative) behind the exact figure. lastSyncedAt and pricing.pricedAt of an unchanged open position report the start of the latest completed refresh of its chain, not the time the row was last written. Amounts, token prices, position value and uncollected fees are written as soon as they change, as before, and metrics.ageSeconds is exact on every response.',
  },
  {
    date: '2026-10-06',
    title: 'Locked and burned positions are labelled on /explore',
    body:
      'A position owned by a burn address (0x…dEaD and similar) shows a "Locked LP" note beside its owner on /explore: no one controls that address, so its liquidity cannot be withdrawn and its fees cannot be collected. A position whose owner is the zero address shows "Burned position": its NFT was burned after its liquidity and fees were withdrawn, so it holds nothing. Both stay listed, sorted and filtered like any other position, and the API response is unchanged.',
  },
  {
    date: '2026-10-06',
    title: 'Pools and positions say when the pool has a Uniswap v4 hook',
    body:
      'Pool and position rows and details (GET /v1/pools, GET /v1/positions, their detail routes, and /explore) carry two new fields when the pool has a v4 hook: hooks, the hook contract address in lower case, and customAccounting, true when that address sets one of the four returns-delta permissions, which let a hook take or redirect value the pool\'s swap and liquidity events do not show. A pool without a hook carries neither field. /explore shows a Hook badge beside the fee, in amber for a custom-accounting hook. A pool gains the fields the next time pool sync revisits it.',
  },
  {
    date: '2026-10-04',
    title: 'Breaking: sort=age is newest first everywhere, and the Closed tab ranks rate sorts by PnL',
    body:
      'sort=age now orders positions by creation time, newest first, for status=active, inactive and all alike; the Closed and All views used to return a different order from the Active view. For status=inactive, sort=apr, fee_apr and roi are served as sort=pnl, because a closed position has no current rate to rank by. Calls on the Active view return the same order as before.',
  },
  {
    date: '2026-10-04',
    title: 'Breaking: internal fields removed from position detail',
    body:
      'GET /v1/positions/{chainId}/{protocol}/{positionId} no longer returns rawSubgraph, _id, __v, the tx* sync fields, rpcFees*, staleMisses, lastVerifiedAt, lastModifyBlock or the _id of nested objects. They were internal bookkeeping that had leaked into the response; every documented field is unchanged.',
  },
  {
    date: '2026-10-04',
    title: 'Uncollected fees are read on-chain and say where they came from',
    body:
      'Open positions\' uncollected fees are re-read from the chain by a recurring pass over every open position. A position is also queued for an earlier re-read when the live indexer sees it change, when it is newly indexed, and when its detail is opened. Each position now carries metrics.feesSource — onchain, indexer, settled (a closed position, nothing owed) or unmeasured (not read yet, shown as Pending on /explore) — and metrics.feesMeasuredAt, the time of that reading.',
  },
  {
    date: '2026-10-04',
    title: 'List totals no longer hold up or fail a page',
    body:
      'hasMore on GET /v1/positions and GET /v1/pools is always exact. pagination.total is exact when the count finishes in time; otherwise it is the smallest total the page itself proves, and pagination.totalCapped is true. Totals stop at 25,000, also flagged totalCapped. On GET /v1/pools and pool detail, positionsCount and holdersCount (open positions and their distinct owners) are null when they could not be counted in time, with countsPending: true on the list, where the whole request used to fail with 503.',
  },
  {
    date: '2026-10-04',
    title: 'All-chains lists answer when one chain is slow',
    body:
      'When chainId is omitted and one chain does not answer in time, GET /v1/positions and GET /v1/pools return the other chains\' rows with partial: true and missingChains naming the chains left out, instead of failing the whole request. A response flagged partial is refunded.',
  },
  {
    date: '2026-10-04',
    title: 'Responses served from an older read are flagged',
    body:
      'Lists are cached for 15 seconds. When a list, count, pool detail or position detail response has to be served from an older read — a timed-out read answered from its last good copy, a database replica running behind, or a very deep page computed from an older offset — it carries stale: true and dataAsOf, the time the data was read. The flag is about when the stored data was read, not how recently each figure in it was updated: uncollected fees carry their own metrics.feesMeasuredAt.',
  },
  {
    date: '2026-10-04',
    title: 'Deep pages have no depth limit',
    body:
      'Any page of GET /v1/positions and GET /v1/pools can be requested, however deep. A deep page that cannot be computed within one request answers 503 with a Retry-After header instead of being refused; progress towards the page is kept where possible, so retry after the interval the header gives. Every 5xx is refunded.',
  },
  {
    date: '2026-10-04',
    title: 'Position detail and charts no longer wait for a long transaction history',
    body:
      'For a position with a long transaction history, the detail route no longer waits for the full history to load. When the full list is not ready it returns the newest page of transactions, flagged transactionsPartial: true and transactionsDegraded: true, while the rest loads in the background; a later request returns the complete list. Position charts in the same situation return without the position series, with partial: true and missing: ["transactions"]. Chart ranges are measured back from the newest data point rather than from today. Responses flagged this way are refunded.',
  },
  {
    date: '2026-10-04',
    title: '/v1/stats counts pools from the last complete pool sync',
    body:
      'GET /v1/stats now takes pools and tvlUsd, overall and per chain, from the totals recorded at the end of each chain\'s last complete pool sync, so those figures can be up to one sync old. When that sync could not price some pools, the figures fall back to the stored pool rows, so those pools still count towards pools and tvlUsd.',
  },
  {
    date: '2026-09-07',
    title: 'Robinhood Chain',
    body:
      'Robinhood Chain (chain ID 4663) is served for Uniswap v4 on GET /v1/positions and GET /v1/pools, and appears in GET /v1/chains as robinhood. Its native token is ETH and USDG is the quote stablecoin. Two things are worth knowing before you rely on symbols there. Token symbols on this chain are heavily squatted, and the usual heuristics pick the impostor rather than the real token — an 18-decimal "USDG" is held by more addresses than the real 6-decimal one, and a counterfeit wstETH matches the genuine token on symbol, name and decimals alike — so we resolve the majors from a fixed address list and flag every other claimant to those symbols. Displayed liquidity is also forgeable on a chain this new: a pool can report billions in reserves while holding cents on the side that matters, so a token is priced from a market quote only where there are real two-sided reserves behind it, and is reported at 0 rather than at a fabricated figure otherwise.',
  },
  {
    date: '2026-09-07',
    title: 'Filter positions and pools to tokenized equities',
    body:
      'GET /v1/positions and GET /v1/pools accept assetClass=equity, which returns only the rows where at least one leg is a tokenized equity — currently 193 of them on Robinhood Chain, covering tickers such as NVDA, SPY and SPCX. The only accepted value is equity; omitting the parameter returns everything as before, so nothing changes for existing calls. Equity legs also report their ticker as the symbol where the on-chain symbol was unreadable.',
  },
  {
    date: '2026-09-07',
    title: 'Position detail no longer fails when transaction history is unavailable',
    body:
      'GET /v1/positions/{chainId}/{protocol}/{positionId} used to return 500 when the upstream indexer could not supply the position\'s transaction list, discarding a response whose every other figure had already been computed. It now returns 200 with transactions as an empty array and a new boolean transactionsDegraded set to true. Treat transactionsDegraded as "unknown", never as an empty history: it is the only thing distinguishing a position with no transactions from one whose transactions we could not load, and it is always present, so it can be read without an existence check. A response flagged this way is refunded and shown as refunded in your usage breakdown rather than charged as a successful call. If you relied on the 500 to detect this condition, switch to the flag.',
  },
  {
    date: '2026-08-31',
    title: 'The chain and protocol pickers open on a phone',
    body:
      'Tapping "All chains" or "Uniswap v4" on /explore did nothing on a touch screen. A tap fires a phone browser\'s emulated hover before the tap itself, which opened the menu and then immediately closed it again, so neither picker could be opened on a phone at all — the chain and protocol filters were unreachable there. Both now open on tap, close when you tap elsewhere, and their panel opens full-width under the row instead of stretching the pill you tapped and pushing the other one onto a second line. Mouse and keyboard behaviour is unchanged.',
  },
  {
    date: '2026-08-31',
    title: '/explore fits a phone screen',
    body:
      'The heading, filters and sort chips on /explore were sized for a desktop and took most of a phone screen before any data appeared. They are now scaled for the viewport: the first position is visible without scrolling on a 375px screen, the refresh button is a full-size tap target rather than an 18px sliver, and the "filters" caption — which only labelled filters already on screen — is dropped on phones. The position and pool cards on phones and tablets are tighter too, about a quarter shorter, because each field was being drawn at a desktop table row\'s height and inset; the "*" that marks an APR skewed by a short position age now sits beside the figure instead of on a line of its own. Pool rows on a phone carry their labels (TVL, 24h volume, 24h vol/TVL, 24h fees, fee APR, age); they had been showing six unlabelled numbers. In a position\'s detail, the chart tabs (PnL, Assets value, APR, Fees APR, Div. loss) sit on one line at a single height — the longer labels had been wrapping to two lines, leaving the row a mix of tall and short buttons. The desktop table is unchanged.',
  },
  {
    date: '2026-08-31',
    title: 'Search on /explore says what it searched, and wallet search covers every page',
    body:
      'Pasting a wallet address into the search box on /explore now filters every position that address holds, not just the ones on the page you were looking at — it goes to the API as the owner filter, the same one GET /v1/positions accepts. Searching a token or pool name still filters only the rows already loaded, because the positions endpoint has no name search, and the page now says so instead of leaving you to infer it: the line beside the pager reads either "3 of 25 on this page match" or the total number of positions matching, the pager is hidden when there is only one page, and it is labelled "page 2 of 305" rather than "2 / 305". Any search starts again at page 1, and a search that matches nothing explains which of the two happened and offers to clear itself.',
  },
  {
    date: '2026-08-31',
    title: 'A position on /explore has a link of its own, and can be refreshed in place',
    body:
      "Opening a position on /explore now puts it in the address bar as ?chain=&protocol=&position=, and that URL reopens the same position's detail panel on load. The share button in the panel hands out that link — through the operating system's share sheet where there is one, and to the clipboard everywhere else. The panel's overflow menu adds Refresh data, which re-reads that one position's metrics and charts without reloading the page, alongside copy actions for the link, the NFT ID and the owner address. The reference-basis picker in the same header (HOLD / USD) was a control that only responded to a click on its own text; the whole button opens it now, and \"expand charts\" below it works: it widens the charts to the full panel, with the metrics moving beneath them, and switches back to \"collapse charts\".",
  },
  {
    date: '2026-08-26',
    title: 'Usage broken down by day, endpoint, key and response class',
    body:
      "GET /account/usage/detail returns your consumption over a date window split four ways: units and requests per day, per endpoint alongside that endpoint's current unit cost, per API key, and per response class. from and to are YYYY-MM-DD and default to the 1st of to's month through today, with 92 days the widest single window; an optional groupBy of day, routeKey, apiKey or status returns only that breakdown. 2xx, 4xx, 5xx and 429 are counted separately, so a rate-limited spike is distinguishable from a bad-request spike, and calls we refunded are shown as refunded rather than folded into a failure rate. A key that has since been deleted keeps its prefix and label in the history it generated. /portal/usage renders the same figures, and GET /account/usage now includes requests alongside units on each month of history. The per-request detail begins with this release: months before it were recorded only as a monthly total and stay that way.",
  },
  {
    date: '2026-08-26',
    title: 'Rate-limit and quota headers are readable from the browser',
    body:
      'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Quota-Limit, X-Quota-Remaining and X-Quota-Reset are now exposed to browser JavaScript on /v1 responses. They were always sent, but a browser key could not read them because they were absent from the CORS exposed-headers list, so a browser client could not see its own remaining quota that the documentation said was there. A 429 now also carries X-RateLimit-Reason, either rate or quota, naming which of the two limits was hit.',
  },
  {
    date: '2026-08-19',
    title: 'Breaking: liquidity distribution is active liquidity, and tick prices are readable',
    body:
      'The liquidityDistribution.ticks[] array on GET /v1/positions/{chainId}/{protocol}/{positionId}/charts and GET /v1/pools/{chainId}/{protocol}/{poolId}/charts gained liquidityNet and activeLiquidity, so the array describes depth at each tick instead of only where positions begin and end. Breaking, in the same array: price0 and price1 are now decimal-adjusted, where they were the raw 1.0001^tick in base units — a 6/18-decimal pair that reported 9.99e+11 now reports 0.9999 — and amount0/amount1 are derived from active rather than gross liquidity. Anything that re-scaled price0/price1 by token decimals itself must stop doing so.',
  },
  {
    date: '2026-08-19',
    title: 'A verification code now says whether it was actually sent',
    body:
      'POST /account/auth/resend-verification returns a delivered flag alongside ok. Previously the response was the same whether the code reached your inbox or the mail provider refused it, and the portal told you to go and check an inbox that was never going to receive anything. An explicit delivered: false means the code is valid and stored but was not sent — a fault on our side, not something a retry fixes. The field is absent on the paths where nothing needed sending.',
  },
  {
    date: '2026-08-19',
    title: 'The pricing page reads plan prices live',
    body:
      'Plan prices, quotas and rate limits on /pricing were served from a one-hour cache, so a price change could leave the page advertising the old figure for up to an hour while the portal quoted the new one. The plan catalogue is now read per request. The unit allowances shown on the home page come from the same live catalogue.',
  },
  {
    date: '2026-08-19',
    title: 'Arbitrum One positions and pools indexed',
    body:
      'Uniswap v4 positions and pools on Arbitrum One (chainId 42161) join Ethereum (1) and Avalanche C-Chain (43114), on every positions and pools route.',
  },
  {
    date: '2026-08-19',
    title: 'GET /v1/chains lists only chains with a live source',
    body:
      'The free chains endpoint previously returned every chain in our registry, including ones with an empty protocols array that could not answer a query. It now lists only chains that actually have data behind them, so the response is safe to drive a chain picker from.',
  },
  {
    date: '2026-08-15',
    title: 'A settled payment is never lost or counted twice',
    body:
      'A USDC transfer that lands against an invoice already voided by a plan change, or after a checkout was abandoned, is credited to your account balance and spent on the next invoice instead of leaving you on Free and asked to pay again. Money diverted to balance is no longer also summed as having paid its invoice.',
  },
  {
    date: '2026-08-15',
    title: 'Cancel a pending plan change, and see confirmations',
    body:
      'A started-but-unpaid plan change can be called off with POST /account/billing/cancel-change, returning the proration credit it consumed — previously the only control ended the plan you were paying for. While a payment confirms, the portal shows confirmations against the required minimum with the transaction hash and an explorer link.',
  },
  {
    date: '2026-08-14',
    title: 'CopyPools is now Tickwise',
    body:
      'The product has a new name and new branding, and documentation examples now show the Tickwise host. No client change is required: the KC-APIKey header and the kc_live_ key prefix are unchanged, your keys keep working, and existing portal sessions survive the rename.',
  },
  {
    date: '2026-08-14',
    title: 'API playground in the portal',
    body:
      'Pick an endpoint at /portal/playground, fill in the parameters, send the call with your own key and see the status, timing, response body and units spent. The key is never stored, logged or echoed back.',
  },
  {
    date: '2026-08-14',
    title: 'GET /v1/stats gained per-chain totals',
    body:
      'The free stats endpoint added activePositions (open positions only), tvlUsd and a byChain array carrying chainId, protocol, pools, positions, activePositions, tvlUsd and indexedUpToTimestamp. Purely additive. tvlUsd counts only TVL that passed our valuation checks, so treat it as a lower bound.',
  },
  {
    date: '2026-08-14',
    title: 'Public documentation, pricing and status pages',
    body:
      'Quickstart, authentication, per-endpoint references for positions, pools and metadata, a units-and-limits page, an error reference and a coverage matrix generated from the same registry the API answers from. Plus public pricing and a status page showing how far each chain is indexed.',
  },
  {
    date: '2026-08-13',
    title: 'Self-serve plans, paid in USDC',
    body:
      'Choose a plan in the portal and pay in USDC by signing an EIP-3009 transfer authorization; your entitlement follows the invoice. Renewals are raised ahead of the period end with a grace window and a downgrade to Free — nothing is ever charged automatically.',
  },
  {
    date: '2026-08-06',
    title: 'Self-serve signup and customer portal',
    body:
      'Sign up, get a Free plan and issue your own keys with no operator involvement. The portal covers overview, keys, usage and settings, with key creation by type and allowed origins, revoke and delete. Sign in with a password, Google, GitHub or a wallet; email addresses are proved by a six-digit code, and password reset runs on a single-use 30-minute token.',
  },
  {
    date: '2026-08-06',
    title: 'Unit costs re-tiered by what a call really costs',
    body:
      'Metered routes no longer cost a flat 1 unit each: metadata routes cost 0, detail routes 1, list routes 2 and chart routes 10. The meter and the published price now resolve through a single lookup, so /pricing and your bill cannot disagree. Read GET /v1/pricing/units for the live table.',
  },
  {
    date: '2026-08-06',
    title: 'Refused requests no longer consume quota',
    body:
      'Units are credited back on every 4xx as well as every 5xx, so a request the API rejected — a malformed protocol value returning 400, for example — no longer decrements X-Quota-Remaining. 429s were never charged.',
  },
  {
    date: '2026-08-06',
    title: 'Public /v1/plans, /v1/pricing/units and /v1/stats',
    body:
      'Three unauthenticated, unmetered endpoints: plans with monthlyUnits, rateLimitPerMin, maxApiKeys, allowBrowserKeys and prices in integer minor units; the per-route unit cost table; and index counts with pools, positions and indexedTo.',
  },
  {
    date: '2026-07-18',
    title: 'owner filter on the positions endpoints',
    body:
      'GET /v1/positions accepts owner=0x… (case-insensitive) to fetch every indexed position held by one wallet. It composes with the other filters, so pass status=all&minValueUsd=0&minPoolTvl=0&includeRisky=true for a wallet\'s complete set.',
  },
  {
    date: '2026-07-03',
    title: 'Avalanche C-Chain positions and pools indexed',
    body:
      'Uniswap v4 on Avalanche C-Chain (chainId 43114, native AVAX) is served on every positions and pools route alongside Ethereum.',
  },
  {
    date: '2026-07-03',
    title: 'Breaking: omitting chainId now returns every chain',
    body:
      'chainId became optional on /v1/positions and /v1/pools. A request that omits it previously defaulted to Ethereum; it now returns a merged, re-sorted result across every enabled chain with summed pagination totals. If you relied on the old implicit default, pass chainId=1 explicitly.',
  },
  {
    date: '2026-06-24',
    title: 'GET /health reports indexed block vs chain head',
    body:
      'The free health route returns indexedBlock, chainHeadBlock, lagBlocks, synced and status per integration, so you can show data freshness rather than guessing at it. The older indexedUpToTimestamp field is retained.',
  },
  {
    date: '2026-06-17',
    title: 'Breaking: keyless /api/* routes closed to third parties',
    body:
      'In production the open /api/top-* dashboard routes now require a request Origin in our allowlist; any other or missing Origin is refused with 403. Server-side and scripted callers must use /v1 with a KC-APIKey header, which is a documented, versioned surface with quota headers.',
  },
  {
    date: '2026-06-16',
    title: 'Server and browser API keys, with origin binding',
    body:
      'Every key now has a type. A server key is refused with 403 on any request carrying an Origin header, so a key pasted into frontend JavaScript stops working. A browser key must be issued with at least one allowed origin and works only from those origins, making a leaked key useless on another site.',
  },
  {
    date: '2026-06-16',
    title: 'Metered pool and chart endpoints',
    body:
      'GET /v1/pools, GET /v1/pools/{chainId}/{protocol}/{poolId} and the charts routes for both pools and positions, each metered under its own route key. range accepts 30d, 60d, 90d, 180d or all and defaults to 30d. Pool responses also carry positionsCount and holdersCount, both counting open positions only.',
  },
  {
    date: '2026-06-12',
    title: 'Valuations gated on real market activity',
    body:
      'A token leg that is neither an anchor nor allowlisted is only valued when an independent DEX source corroborates it with real 24h volume and counter-side liquidity. Fabricated and dead-pool positions that previously reported large figures now return $0 or drop out of the default lists. Responses gained priceConfidence, nominalValueUsd, unrealizableLeg and priceUnavailable so you can see why.',
  },
  {
    date: '2026-06-01',
    title: 'Metered /v1 API with keys, plans and quota headers',
    body:
      'The versioned API launched: /v1/positions list and detail behind a KC-APIKey header, with /v1/chains and /v1/protocols free. Four plans from Free to Enterprise with monthly unit quotas and per-minute rate limits. Every metered response carries X-RateLimit-Limit, -Remaining, -Reset and X-Quota-Limit, -Remaining, -Reset; exceeding either returns 429 with Retry-After.',
  },
  {
    date: '2026-05-13',
    title: 'Uniswap v4 positions on Ethereum',
    body:
      'The first release: ranked Uniswap v4 liquidity positions on Ethereum, sortable by APR, fee APR, ROI, age, PnL or underlying value, with filters for status, range, minimum value and pool TVL, and a detail view carrying per-position amounts, fees, PnL and transaction history.',
  },
];
