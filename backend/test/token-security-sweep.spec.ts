/*
 * The GoPlus token-security sweep's WALK.
 *
 * There was no coverage of this service at all (test/goplus.spec.ts covers
 * GoplusService, which has no indexer coupling). That matters more here than
 * usual: the sweep was dead for weeks — it paged an indexer that was no longer
 * configured and returned `{checked: 0}` from every chain while reporting
 * success — and the leaderboard's spam `$nin` quietly froze at whatever verdicts
 * were already stored. This subsystem's entire defect history is silent success,
 * so the walk gets pinned.
 *
 * What is pinned, and why each one is a silent-wrong-answer risk:
 *   - the cursor is the last usable id on the page, read out of the SERVER's rows
 *     and taken VERBATIM — not out of the `pending` buffer (which `flush()`
 *     empties, so a page ending on a chunk boundary would break the walk) and not
 *     lowercased like the addresses fed to GoPlus (the bound must be byte-identical
 *     to what the server sorts on, or `id_gt` skips or repeats);
 *   - a short page ends the walk and a full page continues it;
 *   - a page fetch that fails after retries BREAKS rather than throws, and the
 *     trailing flush still reaches GoPlus with what was already collected;
 *   - a second concurrent tick returns immediately rather than awaiting the
 *     shared promise (it runs on a shared BullMQ queue and would hold a slot).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();

vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({ request: requestMock })),
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

const { TokenSecuritySyncService } = await import('../src/sync/token-security-sync.service.js');

const integration = {
  chainId: 1,
  protocol: 'uniswap-v4',
  subgraphUrl: 'https://indexer.hyperindex.xyz/abc123/v1/graphql',
  dialect: 'hyperindex',
  enabled: true,
} as never;

function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function makeService(over: { tokenSecurityMaxPerRun?: number } = {}) {
  const assessTokens = vi.fn(async () => new Map());
  const config = { tokenSecurityMaxPerRun: over.tokenSecurityMaxPerRun ?? 0, tokenSecurityScope: 'universe' };
  const service = new TokenSecuritySyncService(config as never, { assessTokens } as never);
  const warn = vi
    .spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn')
    .mockImplementation(() => {});
  vi.spyOn((service as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => {});
  vi.spyOn((service as unknown as { logger: { debug: () => void } }).logger, 'debug').mockImplementation(() => {});
  return { service, assessTokens, warn };
}

/** Every address handed to GoPlus, flattened across chunks. */
function fedAddresses(assessTokens: ReturnType<typeof vi.fn>): string[] {
  return assessTokens.mock.calls.flatMap((c) => c[1] as string[]);
}

/** The `id_gt` bound each page asked for; `undefined` on the first page. */
function bounds(): Array<string | undefined> {
  return requestMock.mock.calls.map(
    (c) => (c[1] as { where: { id_gt?: string } }).where.id_gt,
  );
}

const PAGE_SIZE = 1000;

describe('TokenSecuritySyncService — the token-universe walk', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('keyset-pages on id_gt and feeds every address exactly once', async () => {
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: addr(i + 1) }));
    const page2 = [{ id: addr(PAGE_SIZE + 1) }, { id: addr(PAGE_SIZE + 2) }];
    requestMock.mockResolvedValueOnce({ tokens: page1 }).mockResolvedValueOnce({ tokens: page2 });

    const { service, assessTokens } = makeService();
    const result = await service.syncChain(1, integration);

    expect(result.checked).toBe(PAGE_SIZE + 2);
    // First page unbounded, second bounded by the LAST id of the first.
    expect(bounds()).toEqual([undefined, addr(PAGE_SIZE)]);
    const fed = fedAddresses(assessTokens);
    expect(fed).toHaveLength(PAGE_SIZE + 2);
    expect(new Set(fed).size).toBe(PAGE_SIZE + 2);
  });

  /*
   * A row the loop SKIPS must not stall the walk or make it repeat a page. The
   * page is id-ascending so a falsy id sorts first and cannot legitimately be
   * last; this pins what happens if one ever is.
   */
  it('keeps advancing when the page boundary row is malformed', async () => {
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: addr(i + 1) }));
    page1[PAGE_SIZE - 1] = { id: '' }; // counted by the server, skipped by us
    requestMock.mockResolvedValueOnce({ tokens: page1 }).mockResolvedValueOnce({ tokens: [] });

    const { service, assessTokens } = makeService();
    const result = await service.syncChain(1, integration);

    // 999 fed, not 1000 — the empty id is skipped.
    expect(result.checked).toBe(PAGE_SIZE - 1);
    expect(fedAddresses(assessTokens)).toHaveLength(PAGE_SIZE - 1);
    // The walk CONTINUES, bounded by the last usable server id. Taking the empty
    // string verbatim would stall the walk on a full page; taking it as "no
    // cursor" would re-request the same page forever.
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(bounds()[1]).toBe(addr(PAGE_SIZE - 1));
  });

  /*
   * The cursor must be the RAW server id, not the lowercased address that goes to
   * GoPlus. They coincide today because ids arrive lowercase, which is exactly
   * what makes the divergence invisible until it is not: an `id_gt` bound that
   * does not byte-match the server's sort key either skips rows or re-requests
   * them forever.
   */
  it('bounds the next page with the raw server id, not the lowercased one', async () => {
    const mixed = '0xAAAAaaaaBBBBbbbbCCCCccccDDDDddddEEEEeeee';
    const page1 = [
      ...Array.from({ length: PAGE_SIZE - 1 }, (_, i) => ({ id: addr(i + 1) })),
      { id: mixed },
    ];
    requestMock.mockResolvedValueOnce({ tokens: page1 }).mockResolvedValueOnce({ tokens: [] });

    const { service, assessTokens } = makeService();
    await service.syncChain(1, integration);

    expect(bounds()[1]).toBe(mixed);
    // …while GoPlus still gets the lowercased form, which is what the token store
    // is keyed by.
    expect(fedAddresses(assessTokens)).toContain(mixed.toLowerCase());
  });

  it('ends the walk on a short page', async () => {
    requestMock.mockResolvedValue({ tokens: [{ id: addr(1) }, { id: addr(2) }] });

    const { service } = makeService();
    const result = await service.syncChain(1, integration);

    expect(result.checked).toBe(2);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('breaks GRACEFULLY when a page fetch fails, keeping what it already collected', async () => {
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: addr(i + 1) }));
    requestMock
      .mockResolvedValueOnce({ tokens: page1 })
      .mockRejectedValue(new Error('Cannot query field "id" on type "Token"')); // non-retriable

    const { service, assessTokens, warn } = makeService();
    const result = await service.syncChain(1, integration);

    // Not a throw: the job stays successful so BullMQ does not re-run the whole
    // walk from zero, and the next cron tick resumes cache-short-circuited.
    expect(result.checked).toBe(PAGE_SIZE);
    expect(fedAddresses(assessTokens)).toHaveLength(PAGE_SIZE);
    expect(String(warn.mock.calls[0][0])).toMatch(/stopped early/);
  });

  it('flushes the trailing partial chunk', async () => {
    // 10 addresses, well under the 300-address chunk — without the trailing
    // flush they would never reach GoPlus at all.
    requestMock.mockResolvedValue({ tokens: Array.from({ length: 10 }, (_, i) => ({ id: addr(i + 1) })) });

    const { service, assessTokens } = makeService();
    await service.syncChain(1, integration);

    expect(assessTokens).toHaveBeenCalledTimes(1);
    expect(fedAddresses(assessTokens)).toHaveLength(10);
  });

  it('honours the per-run cap', async () => {
    requestMock.mockResolvedValue({
      tokens: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: addr(i + 1) })),
    });

    const { service } = makeService({ tokenSecurityMaxPerRun: 5 });
    const result = await service.syncChain(1, integration);

    expect(result.checked).toBe(5);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('alerts and does nothing when the integration has no indexer URL', async () => {
    const { service, warn } = makeService();

    const result = await service.syncChain(1, undefined);

    expect(result).toEqual({ checked: 0 });
    expect(requestMock).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/token_security\.no_source/);
  });

  /*
   * A mainnet sweep is ~46k addresses at 30 per GoPlus batch with a 2.2s
   * inter-batch delay — the better part of an hour. It runs on the shared
   * `positions-sync` BullMQ queue (concurrency 10), so a coalesced waiter that
   * AWAITS the in-flight promise holds a slot for that whole time. Boot kick +
   * cron tick + admin trigger can coincide and starve admin backfills into
   * `waiting`. Its sibling TokenPriceSyncService was changed away from the
   * await-the-promise shape for exactly this reason.
   */
  it('returns immediately instead of awaiting a sweep already in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    requestMock.mockImplementation(async () => {
      await gate;
      return { tokens: [{ id: addr(1) }] };
    });

    const { service } = makeService();
    const first = service.syncChain(1, integration);
    // Let the first call reach its in-flight request.
    await Promise.resolve();
    const second = await service.syncChain(1, integration);

    expect(second).toEqual({ checked: 0 });
    release(undefined);
    expect((await first).checked).toBe(1);
  });
});

describe('TokenSecuritySyncService — scope=active (the default)', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  function makeActive(addresses: string[], over: { cap?: number; positions?: boolean } = {}) {
    const assessTokens = vi.fn(async () => new Map());
    const distinct = vi.fn(async () => addresses);
    const config = { tokenSecurityMaxPerRun: over.cap ?? 0, tokenSecurityScope: 'active' };
    const service = new TokenSecuritySyncService(
      config as never,
      { assessTokens } as never,
      over.positions === false ? undefined : ({ distinctActiveTokenAddresses: distinct } as never),
    );
    const warn = vi
      .spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => {});
    vi.spyOn((service as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => {});
    return { service, assessTokens, distinct, warn };
  }

  it('feeds the active-position tokens in chunks and never touches the indexer', async () => {
    const addresses = Array.from({ length: 650 }, (_, i) => addr(i + 1));
    const { service, assessTokens, distinct } = makeActive(addresses);
    await expect(service.syncChain(1, integration)).resolves.toEqual({ checked: 650 });
    expect(distinct).toHaveBeenCalledWith(1, 'uniswap-v4');
    expect(requestMock).not.toHaveBeenCalled();
    expect(assessTokens.mock.calls.map((c) => (c[1] as string[]).length)).toEqual([300, 300, 50]);
    expect(fedAddresses(assessTokens)).toEqual(addresses);
  });

  it('honours the per-run cap', async () => {
    const { service, assessTokens } = makeActive(Array.from({ length: 10 }, (_, i) => addr(i + 1)), { cap: 4 });
    await expect(service.syncChain(1, integration)).resolves.toEqual({ checked: 4 });
    expect(fedAddresses(assessTokens)).toHaveLength(4);
  });

  it('alerts and does nothing without the positions store', async () => {
    const { service, assessTokens, warn } = makeActive([addr(1)], { positions: false });
    await expect(service.syncChain(1, integration)).resolves.toEqual({ checked: 0 });
    expect(assessTokens).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('[alert] token_security.no_source');
  });
});
