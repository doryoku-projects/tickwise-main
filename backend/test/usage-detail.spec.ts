import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ClientsService } from '../src/billing/clients.service.js';

/**
 * `ClientsService.getUsageDetail` — the ONE implementation behind both
 * `GET /account/usage/detail` and `GET /admin/clients/:id/usage/detail`.
 *
 * The cases worth pinning are the ones the global ValidationPipe cannot be
 * trusted for: it is inert under `tsx` dev, so every bound the DTOs declare has
 * to hold here too, and a query value can arrive as an OBJECT rather than a
 * string. The id parsing is pinned for the same reason it is written
 * fail-closed — a malformed id must be a 404, never a 500 and never a list.
 */

const CUSTOMER_ID = '507f1f77bcf86cd799439011';
const KEY_ID = '507f1f77bcf86cd799439022';

interface Facets {
  totals?: Array<{ units: number; requests: number }>;
  series?: Array<{ _id: string; units: number; requests: number }>;
  byRoute?: Array<{ _id: string; units: number; requests: number }>;
  byKey?: Array<{ _id: string; keyPrefix: string; keyLabel: string; units: number; requests: number }>;
  byStatus?: Array<{ _id: string; units: number; requests: number }>;
}

function build(opts: { client?: unknown; monthlyUnits?: number; facets?: Facets } = {}) {
  // `pipelines` keeps EVERY aggregate, not just the last: the disclosure guard
  // below asserts a property of all of them, and a helper that only remembers
  // the most recent one would let an earlier unfiltered read pass unseen.
  const seen: { pipeline?: any[]; pipelines: any[][]; aggregateCalls: number } = {
    pipelines: [],
    aggregateCalls: 0,
  };
  const customers = {
    findById: () => ({
      lean: () => ({ exec: async () => (opts.client === undefined ? { planKey: 'pro' } : opts.client) }),
    }),
  };
  const usageBuckets = {
    aggregate: (pipeline: any[]) => {
      seen.pipeline = pipeline;
      seen.pipelines.push(pipeline);
      seen.aggregateCalls += 1;
      return { exec: async () => [opts.facets ?? {}] };
    },
  };
  const settings = {
    getPlan: () => ({ monthlyUnits: opts.monthlyUnits ?? 5_000_000 }),
    // Mirrors the real cache: a known route resolves to the ladder's name, an
    // unknown one degrades to the key rather than being left anonymous.
    getEndpointLabel: (key: string) => (key === 'v1.positions.charts' ? 'Position charts' : key),
    getEndpointCost: (key: string) => (key === 'v1.positions.charts' ? 10 : 2),
  };
  const svc = new ClientsService(
    customers as never,
    {} as never,
    {} as never,
    usageBuckets as never,
    settings as never,
  );
  return { svc, seen };
}

/** The `$match` the facet pipeline runs under. */
function matchStage(pipeline: any[]) {
  return pipeline[0].$match;
}

describe('getUsageDetail — id handling', () => {
  it('404s a malformed customer id WITHOUT touching the collection', async () => {
    const { svc, seen } = build();
    await expect(svc.getUsageDetail('not-an-object-id')).rejects.toMatchObject({ status: 404 });
    expect(seen.aggregateCalls).toBe(0);
  });

  it('404s a well-formed id that belongs to nobody, rather than reporting zeros', async () => {
    const { svc } = build({ client: null });
    await expect(svc.getUsageDetail(CUSTOMER_ID)).rejects.toMatchObject({ status: 404 });
  });

  it('scopes the match to that customer and nothing else', async () => {
    const { svc, seen } = build();
    await svc.getUsageDetail(CUSTOMER_ID);
    expect(String(matchStage(seen.pipeline!).customerId)).toBe(CUSTOMER_ID);
  });
});

describe('getUsageDetail — cross-customer disclosure', () => {
  /**
   * THE guard on this endpoint, stated as its own suite because it is the one
   * failure that would not look like a failure: the route is
   * `GET /admin/clients/:id/usage/detail`, and the anti-pattern it was written
   * against is live three times over in `AdminPaymentsController` (`:87`,
   * `:117`, `:133`), where the customer filter is applied only
   * `if (customerId && Types.ObjectId.isValid(customerId))` with NO else — so a
   * malformed id there drops the filter and answers with EVERY customer's rows.
   * A 500 would at least be visible; an unfiltered 200 is a silent breach.
   */
  const HOSTILE_IDS: Array<[label: string, id: unknown]> = [
    ['a malformed id', 'not-an-object-id'],
    ['an empty id', ''],
    ['a 23-character near-miss', CUSTOMER_ID.slice(0, 23)],
    ['a same-length non-hex id', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['an id with surrounding whitespace', ` ${CUSTOMER_ID} `],
    // With the pipe inert, `?id[$ne]=` arrives as an object. Reaching the
    // `$match` it would select every row in the collection.
    ['a Mongo operator object', { $ne: null }],
    ['an array of ids', [CUSTOMER_ID]],
    ['a numeric id', 123],
  ];

  it.each(HOSTILE_IDS)('refuses %s without ever running an aggregate', async (_label, id) => {
    // A customer DOES exist in this rig, and the stub's `findById` ignores what
    // it is handed — so the only thing standing between these ids and a read is
    // the try/catch around `new Types.ObjectId`. Every one of them throws there.
    const { svc, seen } = build();
    await expect(svc.getUsageDetail(id as string)).rejects.toMatchObject({ status: 404 });
    expect(seen.aggregateCalls).toBe(0);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('falls through to the customer lookup for %s, which does not cast', async (_label, id) => {
    // The two values `new Types.ObjectId()` accepts by GENERATING a fresh id
    // instead of throwing — an absent path segment, or a `customerId` a caller
    // omitted. They parse, so the second layer catches them: the read needs the
    // customer record for the plan allowance, and a random id matches nobody.
    const { svc, seen } = build({ client: null });
    await expect(svc.getUsageDetail(id as never)).rejects.toMatchObject({ status: 404 });
    expect(seen.aggregateCalls).toBe(0);
  });

  it('never issues an aggregate whose $match is missing the owner', async () => {
    const { svc, seen } = build();
    // Every accepted query shape, including the ones that change the pipeline.
    await svc.getUsageDetail(CUSTOMER_ID);
    await svc.getUsageDetail(CUSTOMER_ID, { groupBy: 'apiKey' });
    await svc.getUsageDetail(CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-25' });
    await svc.getUsageDetail(CUSTOMER_ID, { groupBy: 'status', to: '2026-06-30' });

    expect(seen.pipelines).toHaveLength(4);
    for (const pipeline of seen.pipelines) {
      const match = matchStage(pipeline);
      expect(String(match.customerId)).toBe(CUSTOMER_ID);
      // An ObjectId, not the string — a string never matches a stored ObjectId,
      // which would silently report zeros rather than leak, but is still not
      // the filter this claims to be.
      expect(match.customerId).toBeInstanceOf(Types.ObjectId);
    }
  });
});

describe('getUsageDetail — window', () => {
  it('defaults to the current calendar month to date, UTC', async () => {
    const { svc, seen } = build();
    const now = new Date();
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

    const out = await svc.getUsageDetail(CUSTOMER_ID);

    expect(out.range).toEqual({ from: `${today.slice(0, 7)}-01`, to: today });
    expect(matchStage(seen.pipeline!).day).toEqual({ $gte: out.range.from, $lte: out.range.to });
  });

  it("anchors a defaulted `from` on `to`'s month, not today's", async () => {
    const { svc } = build();
    const out = await svc.getUsageDetail(CUSTOMER_ID, { to: '2026-06-30' });
    expect(out.range).toEqual({ from: '2026-06-01', to: '2026-06-30' });
  });

  it('refuses a window wider than the 92-day cap', async () => {
    const { svc } = build();
    await expect(svc.getUsageDetail(CUSTOMER_ID, { from: '2026-01-01', to: '2026-06-01' })).rejects.toMatchObject({
      status: 400,
    });
    // …and accepts exactly the cap (inclusive of both ends).
    const out = await svc.getUsageDetail(CUSTOMER_ID, { from: '2026-01-01', to: '2026-04-02' });
    expect(out.range.from).toBe('2026-01-01');
  });

  it('refuses an inverted range', async () => {
    const { svc } = build();
    await expect(svc.getUsageDetail(CUSTOMER_ID, { from: '2026-06-10', to: '2026-06-01' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses a malformed date, a well-shaped impossibility, and a non-string', async () => {
    const { svc } = build();
    await expect(svc.getUsageDetail(CUSTOMER_ID, { from: '10-06-2026' })).rejects.toMatchObject({ status: 400 });
    // The pattern alone accepts this; only the UTC round trip rejects it.
    await expect(svc.getUsageDetail(CUSTOMER_ID, { from: '2026-02-31' })).rejects.toMatchObject({ status: 400 });
    // `?from[$gt]=` with the pipe inert — an operator object must never reach
    // the Mongo filter.
    await expect(
      svc.getUsageDetail(CUSTOMER_ID, { from: { $gt: '' } as unknown as string }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('getUsageDetail — bounds hold with the ValidationPipe bypassed', () => {
  /**
   * The DTOs are a courtesy, not a control: the global `ValidationPipe` is inert
   * under `tsx` dev because esbuild drops the decorator metadata
   * (`portal.dto.ts:3-7`), so every value below reaches the service in whatever
   * shape the querystring parser produced it. These call the service DIRECTLY,
   * which is exactly the path a dev-mode request takes.
   */
  const UNVALIDATED: Array<[label: string, query: Record<string, unknown>]> = [
    ['a window one day over the 92-day cap', { from: '2026-01-01', to: '2026-04-03' }],
    ['a year-long window', { from: '2026-01-01', to: '2026-12-31' }],
    ['an inverted window', { from: '2026-06-10', to: '2026-06-01' }],
    ['a numeric date (implicit conversion never ran)', { from: 20260101 }],
    ['a repeated `?from=` parsed as an array', { from: ['2026-01-01', '2026-02-01'] }],
    // `?from[0]=2026-01-01` — the one hostile shape the DATE PATTERN alone
    // accepts, because stringifying a single-element array yields a valid day.
    // Only the `typeof value === 'string'` test refuses it.
    // (`to` is pinned so the window stays inside the cap — otherwise the day
    // range refuses this for the wrong reason and the case proves nothing.)
    ['a single-element array', { from: ['2026-01-01'], to: '2026-01-31' }],
    ['an operator object', { from: { $gt: '' } }],
    ['a date-shaped impossibility', { to: '2026-02-31' }],
    ['a groupBy array', { groupBy: ['day'] }],
    ['an unknown groupBy', { groupBy: 'customerId' }],
  ];

  it.each(UNVALIDATED)('refuses %s and runs no aggregate', async (_label, query) => {
    const { svc, seen } = build();
    await expect(svc.getUsageDetail(CUSTOMER_ID, query as never)).rejects.toMatchObject({
      status: 400,
    });
    // Refused BEFORE the read: a bound that clamped instead of throwing would
    // answer a question the caller did not ask, and one that threw after the
    // aggregate would have already done the work it exists to prevent.
    expect(seen.aggregateCalls).toBe(0);
  });

  it('accepts exactly the cap and nothing beyond it', async () => {
    const { svc } = build();
    // 92 days inclusive of both ends.
    await expect(svc.getUsageDetail(CUSTOMER_ID, { from: '2026-01-01', to: '2026-04-02' })).resolves.toMatchObject({
      range: { from: '2026-01-01', to: '2026-04-02' },
    });
    await expect(
      svc.getUsageDetail(CUSTOMER_ID, { from: '2026-01-01', to: '2026-04-03' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('bounds the rows each breakdown can return, not just the window', async () => {
    // `series` is bounded by the window, but `byRoute` grows with the route
    // table and `byKey` with every key the customer has EVER used — including
    // deleted ones, whose buckets deliberately outlive them.
    const { svc, seen } = build();
    await svc.getUsageDetail(CUSTOMER_ID);
    const facet = seen.pipeline![1].$facet;
    for (const name of ['series', 'byRoute', 'byKey']) {
      const limit = facet[name].find((stage: any) => stage.$limit);
      expect(limit?.$limit).toBeGreaterThan(0);
    }
  });
});

describe('getUsageDetail — groupings', () => {
  it('runs all four breakdowns when groupBy is omitted', async () => {
    const { svc, seen } = build();
    await svc.getUsageDetail(CUSTOMER_ID);
    expect(Object.keys(seen.pipeline![1].$facet).sort()).toEqual(
      ['byKey', 'byRoute', 'byStatus', 'series', 'totals'].sort(),
    );
  });

  it('runs only the named breakdown — and totals, which are always in the response', async () => {
    const { svc, seen } = build();
    const out = await svc.getUsageDetail(CUSTOMER_ID, { groupBy: 'apiKey' });
    expect(Object.keys(seen.pipeline![1].$facet).sort()).toEqual(['byKey', 'totals']);
    expect(out.series).toEqual([]);
    expect(out.byRoute).toEqual([]);
    expect(out.byStatus).toEqual([]);
  });

  it('refuses an unrecognised groupBy', async () => {
    const { svc } = build();
    await expect(
      svc.getUsageDetail(CUSTOMER_ID, { groupBy: 'customer' as never }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('getUsageDetail — projection', () => {
  it('maps every grouping, prices routes through the ladder, and reports the plan limit', async () => {
    const { svc } = build({
      monthlyUnits: 5_000_000,
      facets: {
        totals: [{ units: 1_128_400, requests: 326_000 }],
        series: [{ _id: '2026-08-01', units: 32_400, requests: 9_100 }],
        byRoute: [{ _id: 'v1.positions.charts', units: 448_000, requests: 44_800 }],
        byKey: [{ _id: KEY_ID, keyPrefix: 'tk_live_a3f9', keyLabel: 'prod-backend', units: 843_600, requests: 224_800 }],
        byStatus: [{ _id: '2xx', units: 1_128_400, requests: 306_200 }],
      },
    });

    const out = await svc.getUsageDetail(CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-25' });

    expect(out.totals).toEqual({ units: 1_128_400, requests: 326_000, limit: 5_000_000 });
    expect(out.series).toEqual([{ day: '2026-08-01', units: 32_400, requests: 9_100 }]);
    expect(out.byRoute).toEqual([
      { routeKey: 'v1.positions.charts', label: 'Position charts', unitCost: 10, units: 448_000, requests: 44_800 },
    ]);
    expect(out.byKey).toEqual([
      { apiKeyId: KEY_ID, keyPrefix: 'tk_live_a3f9', keyLabel: 'prod-backend', units: 843_600, requests: 224_800 },
    ]);
    expect(out.byStatus).toEqual([{ statusClass: '2xx', requests: 306_200, units: 1_128_400 }]);
  });

  it('orders the status breakdown success → 4xx → 5xx → 429, not alphabetically', async () => {
    const { svc } = build({
      facets: {
        byStatus: [
          { _id: '5xx', units: 0, requests: 3 },
          { _id: '429', units: 0, requests: 7 },
          { _id: '2xx', units: 40, requests: 20 },
          { _id: '4xx', units: 0, requests: 5 },
        ],
      },
    });
    const out = await svc.getUsageDetail(CUSTOMER_ID);
    // A plain sort on the stored string yields 2xx, 429, 4xx, 5xx — which reads
    // as 429 being an error family between the two it sits under.
    expect(out.byStatus.map((row) => row.statusClass)).toEqual(['2xx', '4xx', '5xx', '429']);
  });

  it('reports zeros for a window with no traffic instead of throwing on an empty facet', async () => {
    const { svc } = build({ facets: {} });
    const out = await svc.getUsageDetail(CUSTOMER_ID);
    expect(out.totals).toMatchObject({ units: 0, requests: 0 });
    expect(out.series).toEqual([]);
  });
});
