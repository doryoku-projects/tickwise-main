import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiaProvider } from '../src/pricing/providers/dia.provider.js';

const RPC = '0xed025a9fe4b30bcd68460bca42583090c2266468';

function mockHttp(p: unknown, data: unknown, statusCode = 200) {
  vi.spyOn(p as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({ statusCode, data } as never);
}

afterEach(() => vi.restoreAllMocks());

describe('DiaProvider (free, no key)', () => {
  const provider = () => new DiaProvider({} as never);

  it('maps Price + VolumeYesterdayUSD', async () => {
    const p = provider();
    mockHttp(p, { Symbol: 'RPC', Price: 0.0109, VolumeYesterdayUSD: 12345 });
    const q = await p.getCurrentSingle(1, RPC);
    expect(q?.priceUsd).toBeCloseTo(0.0109, 6);
    expect(q?.source).toBe('dia');
    expect(q?.volume24hUsd).toBe(12345);
  });

  it('omits volume when zero/absent (still prices)', async () => {
    const p = provider();
    mockHttp(p, { Price: 1.5, VolumeYesterdayUSD: 0 });
    const q = await p.getCurrentSingle(1, RPC);
    expect(q?.priceUsd).toBe(1.5);
    expect(q?.volume24hUsd).toBeUndefined();
  });

  it('returns null on Price <= 0', async () => {
    const p = provider();
    mockHttp(p, { Price: 0 });
    expect(await p.getCurrentSingle(1, RPC)).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    const p = provider();
    mockHttp(p, undefined, 404);
    expect(await p.getCurrentSingle(1, RPC)).toBeNull();
  });

  it('does no network for an unsupported chain', async () => {
    const p = provider();
    const spy = vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson');
    expect(await p.getCurrentSingle(999, RPC)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('is single-only (no batch support)', () => {
    expect(provider().supportsCurrentBatch).toBe(false);
  });
});
