import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/billing/api-key.util.js';
import { ClientsService } from '../src/billing/clients.service.js';

const KEY_ID = '6650bbbbbbbbbbbbbbbbbbbb';
const CUSTOMER_ID = '6650aaaaaaaaaaaaaaaaaaaa';

/**
 * A ClientsService over in-memory key/customer stores that count their reads
 * and `lastUsedAt` writes. Every mutation stub returns the updated key
 * document, keyHash included, as the lean Mongoose call would.
 */
function makeService() {
  const raw = generateApiKey().raw;
  const keyDoc = {
    _id: KEY_ID,
    customerId: CUSTOMER_ID,
    keyHash: hashApiKey(raw),
    keyPrefix: 'kc_live_abcd',
    label: 'ci',
    status: 'active',
    allowedOrigins: [] as string[],
  };
  const customer = { _id: CUSTOMER_ID, status: 'active', planKey: 'pro' };
  const reads = { keys: 0, customers: 0 };
  const lastUsedWrites: unknown[] = [];
  const updated = () => ({ lean: () => ({ exec: async () => ({ ...keyDoc }) }) });
  const apiKeys = {
    findOne: () => ({
      exec: async () => {
        reads.keys++;
        return keyDoc.status === 'active' ? { ...keyDoc } : null;
      },
    }),
    updateOne: (filter: unknown) => {
      lastUsedWrites.push(filter);
      return { exec: async () => undefined };
    },
    findByIdAndUpdate: updated,
    findByIdAndDelete: updated,
    findOneAndUpdate: updated,
    findOneAndDelete: updated,
  };
  const customers = {
    findById: () => ({
      lean: () => ({
        exec: async () => {
          reads.customers++;
          return { ...customer };
        },
      }),
    }),
    findByIdAndUpdate: () => ({ lean: () => ({ exec: async () => ({ ...customer }) }) }),
  };
  const service = new ClientsService(customers as never, apiKeys as never, {} as never);
  return { service, raw, keyDoc, customer, reads, lastUsedWrites };
}

afterEach(() => vi.useRealTimers());

describe('resolveByRawKey cache', () => {
  it('serves repeat requests from memory for 30 s (no Mongo reads)', async () => {
    vi.useFakeTimers();
    const { service, raw, reads } = makeService();
    const first = await service.resolveByRawKey(raw);
    expect(first).toMatchObject({ apiKeyId: KEY_ID, customerId: CUSTOMER_ID, planKey: 'pro' });
    await service.resolveByRawKey(raw);
    await service.resolveByRawKey(raw);
    expect(reads).toEqual({ keys: 1, customers: 1 });

    vi.advanceTimersByTime(30_001);
    await service.resolveByRawKey(raw);
    expect(reads).toEqual({ keys: 2, customers: 2 });
  });

  it('does not cache an unknown key, so a key issued a moment later works at once', async () => {
    const { service, raw, keyDoc, reads } = makeService();
    keyDoc.status = 'revoked';
    expect(await service.resolveByRawKey(raw)).toBeNull();
    keyDoc.status = 'active';
    expect(await service.resolveByRawKey(raw)).not.toBeNull();
    expect(reads.keys).toBe(2);
  });

  it.each([
    ['revokeKey', (s: ClientsService) => s.revokeKey(KEY_ID)],
    ['deleteKey', (s: ClientsService) => s.deleteKey(KEY_ID)],
    ['setKeyOrigins', (s: ClientsService) => s.setKeyOrigins(KEY_ID, ['https://app.example.com'])],
    ['revokeKeyOwned', (s: ClientsService) => s.revokeKeyOwned(KEY_ID, CUSTOMER_ID)],
    ['deleteKeyOwned', (s: ClientsService) => s.deleteKeyOwned(KEY_ID, CUSTOMER_ID)],
    ['setKeyOriginsOwned', (s: ClientsService) => s.setKeyOriginsOwned(KEY_ID, CUSTOMER_ID, [])],
    ['assignPlan', (s: ClientsService) => s.assignPlan(CUSTOMER_ID, 'free')],
  ])('%s drops the cached resolution immediately', async (_name, mutate) => {
    const { service, raw, keyDoc, reads } = makeService();
    await service.resolveByRawKey(raw);
    await mutate(service);
    keyDoc.status = 'revoked'; // what the database now says
    expect(await service.resolveByRawKey(raw)).toBeNull();
    expect(reads.keys).toBe(2);
  });

  it('writes lastUsedAt at most once per key per 5 minutes', async () => {
    vi.useFakeTimers();
    const { service, raw, lastUsedWrites } = makeService();
    await service.resolveByRawKey(raw);
    vi.advanceTimersByTime(31_000); // past the resolution TTL: a fresh DB resolve
    await service.resolveByRawKey(raw);
    await service.resolveByRawKey(raw);
    expect(lastUsedWrites).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60_000);
    await service.resolveByRawKey(raw);
    expect(lastUsedWrites).toHaveLength(2);
    expect(lastUsedWrites[1]).toEqual({ _id: KEY_ID });
  });
});
