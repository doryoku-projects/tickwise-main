import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoplusService } from '../src/security/goplus.service.js';

// USDC is in the committed ETH allowlist + is a config stablecoin anchor →
// security-certain, must never hit GoPlus.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
// A non-allowlisted, non-anchor spam address → uncertain → GoPlus-checked.
const SPAM = '0xed025a9fe4b30bcd68460bca42583090c2266468';

function makeService(rows: Array<Record<string, unknown> & { address: string; lastCheckedAt?: Date }> = []) {
  const upserts: Array<Record<string, unknown>> = [];
  const tokens = {
    findMany: async (_chainId: number, addresses: string[]) =>
      rows.filter((r) => addresses.map((a) => a.toLowerCase()).includes(r.address.toLowerCase())),
    upsertSecurity: async (recs: Array<Record<string, unknown>>) => {
      upserts.push(...recs);
    },
    findSpamAddresses: async () => [],
  };
  return { service: new GoplusService(tokens as never), upserts };
}

function goplusResponse(byAddr: Record<string, Record<string, string>>) {
  return { ok: true, json: async () => ({ code: 1, result: byAddr }) } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('GoplusService', () => {
  it('treats security-certain (anchor/allowlisted) tokens as not-spam with NO network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service, upserts } = makeService();
    const out = await service.assessTokens(1, [USDC]);
    expect(out[USDC]).toBe(false); // not spam
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0); // certain tokens aren't persisted
  });

  it('returns isSpam=true for a honeypot and stores raw signals (no verified)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      goplusResponse({ [SPAM]: { is_honeypot: '1', is_blacklisted: '0', cannot_sell_all: '0', personal_slippage_modifiable: '0' } }),
    );
    const { service, upserts } = makeService();
    const out = await service.assessTokens(1, [SPAM]);
    expect(out[SPAM]).toBe(true);
    expect(upserts[0]).toMatchObject({ address: SPAM, isHoneypot: true });
    expect('verified' in upserts[0]).toBe(false);
  });

  it('clean token → isSpam=false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      goplusResponse({ [SPAM]: { is_honeypot: '0', is_blacklisted: '0', cannot_sell_all: '0', personal_slippage_modifiable: '0' } }),
    );
    const { service } = makeService();
    const out = await service.assessTokens(1, [SPAM]);
    expect(out[SPAM]).toBe(false);
  });

  it('stores the full structured signal set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      goplusResponse({
        [SPAM]: {
          is_honeypot: '0', is_blacklisted: '0', cannot_sell_all: '0', personal_slippage_modifiable: '0',
          cannot_buy: '1', honeypot_with_same_creator: '0', trust_list: '0', is_open_source: '1', is_proxy: '1',
          buy_tax: '0.05', sell_tax: '0.1', holder_count: '1234', creator_percent: '0.42',
          token_name: 'Ripio Coin', token_symbol: 'RPC',
        },
      }),
    );
    const { service, upserts } = makeService();
    await service.assessTokens(1, [SPAM]);
    expect(upserts[0]).toMatchObject({
      address: SPAM, cannotBuy: true, isOpenSource: true, isProxy: true, trustList: false,
      buyTax: 0.05, sellTax: 0.1, holderCount: 1234, creatorPercent: 0.42, tokenSymbol: 'RPC',
    });
  });

  it('fails OPEN (isSpam=false) when the fetch aborts/times out', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const { service } = makeService();
    const out = await service.assessTokens(1, [SPAM]);
    expect(out[SPAM]).toBe(false); // outage must not flag a token spam
  });

  it('backs off and retries on a 4029 rate-limit, then succeeds (no token dropped)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 4029, message: 'too many requests' }) } as unknown as Response)
      .mockResolvedValueOnce(goplusResponse({ [SPAM]: { is_honeypot: '1' } }));
    const { service } = makeService();
    const p = service.assessTokens(1, [SPAM]);
    await vi.advanceTimersByTimeAsync(5000);
    const out = await p;
    expect(out[SPAM]).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('serves a fresh cached verdict without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service } = makeService([{ address: SPAM, isHoneypot: true, lastCheckedAt: new Date() }]);
    const out = await service.assessTokens(1, [SPAM]);
    expect(out[SPAM]).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
