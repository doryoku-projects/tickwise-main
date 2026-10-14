import { describe, expect, it, vi } from 'vitest';
import { normalizeOrigin } from '../src/billing/api-key.util.js';
import { ClientsService } from '../src/billing/clients.service.js';
import { ApiKeyGuard } from '../src/v1/api-key.guard.js';

// ─── normalizeOrigin ──────────────────────────────────────────────────────────
describe('normalizeOrigin', () => {
  it('canonicalizes scheme://host[:port] (lowercase, default ports stripped)', () => {
    expect(normalizeOrigin('https://App.Example.com')).toBe('https://app.example.com');
    expect(normalizeOrigin('https://app.example.com:443')).toBe('https://app.example.com');
    expect(normalizeOrigin('http://localhost:3011')).toBe('http://localhost:3011');
    expect(normalizeOrigin('https://app.example.com/')).toBe('https://app.example.com');
    expect(normalizeOrigin('  https://app.example.com  ')).toBe('https://app.example.com');
  });

  it('accepts a scheme-less host and standardizes to https', () => {
    expect(normalizeOrigin('app.example.org')).toBe('https://app.example.org');
    expect(normalizeOrigin('Example.Org:8080')).toBe('https://example.org:8080'); // bare host + port
    expect(normalizeOrigin('example.com')).toBe('https://example.com');
    // both forms a customer might type collapse to ONE stored value
    expect(normalizeOrigin('app.example.org')).toBe(normalizeOrigin('https://app.example.org'));
  });

  it('rejects non-origins (paths, queries, creds, wildcards, garbage, non-http)', () => {
    expect(normalizeOrigin('https://app.example.com/dashboard')).toBeNull();
    expect(normalizeOrigin('app.example.org/dashboard')).toBeNull(); // bare host + path
    expect(normalizeOrigin('https://app.example.com?x=1')).toBeNull();
    expect(normalizeOrigin('https://user:pass@app.example.com')).toBeNull();
    expect(normalizeOrigin('user:pass@app.example.com')).toBeNull(); // scheme-less creds
    expect(normalizeOrigin('*.example.com')).toBeNull();
    expect(normalizeOrigin('ftp://example.com')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });
});

// ─── ClientsService.setKeyOrigins + isRegisteredOrigin ───────────────────────
function buildClients(overrides: { customers?: any; apiKeys?: any; usage?: any } = {}) {
  return new ClientsService(
    (overrides.customers ?? {}) as never,
    (overrides.apiKeys ?? {}) as never,
    (overrides.usage ?? {}) as never,
  );
}

describe('ClientsService origin binding', () => {
  it('normalizes + dedupes origins on write and rejects invalid entries 400', async () => {
    let saved: { allowedOrigins: string[]; keyType: string } | undefined;
    const svc = buildClients({
      apiKeys: {
        findByIdAndUpdate: (_id: string, update: { allowedOrigins: string[]; keyType: string }) => {
          saved = update;
          return { lean: () => ({ exec: async () => ({ _id: 'k1', keyHash: 'h', ...update }) }) };
        },
      },
    });
    const result = await svc.setKeyOrigins('k1', ['https://App.Example.com/', 'https://app.example.com']);
    expect(saved?.allowedOrigins).toEqual(['https://app.example.com']); // normalized + deduped
    expect(saved?.keyType).toBe('browser'); // non-empty origins ⇒ browser key
    expect((result as { keyHash?: string }).keyHash).toBeUndefined(); // hash never exposed

    // empty list converts the key back to a server key
    await svc.setKeyOrigins('k1', []);
    expect(saved?.allowedOrigins).toEqual([]);
    expect(saved?.keyType).toBe('server');

    await expect(svc.setKeyOrigins('k1', ['https://ok.com', 'not a url'])).rejects.toMatchObject({
      status: 400,
    });
  });

  it('isRegisteredOrigin caches the active-key origin set (60s) and fails soft', async () => {
    const distinct = vi.fn(() => ({ exec: async () => ['https://a.com', 'https://b.com'] }));
    const svc = buildClients({ apiKeys: { distinct } });

    expect(await svc.isRegisteredOrigin('https://A.com')).toBe(true); // case-insensitive
    expect(await svc.isRegisteredOrigin('https://evil.com')).toBe(false);
    expect(distinct).toHaveBeenCalledTimes(1); // second call served from cache

    // After a failure with a warm cache, the last set keeps serving.
    distinct.mockImplementation(() => ({ exec: async () => { throw new Error('mongo down'); } }));
    expect(await svc.isRegisteredOrigin('https://a.com')).toBe(true);
  });
});

// ─── ApiKeyGuard origin enforcement ───────────────────────────────────────────
function buildGuard(resolved: unknown) {
  const clients = { resolveByRawKey: vi.fn(async () => resolved) };
  const config = { apiKeyHeader: 'KC-APIKey' };
  const guard = new ApiKeyGuard(clients as never, config as never);
  const ctx = (headers: Record<string, string>) => ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  });
  return { guard, ctx };
}

describe('ApiKeyGuard origin binding', () => {
  const KEY = { 'kc-apikey': 'kc_live_x' };
  const browserKey = { apiKeyId: 'k1', customerId: 'c1', planKey: 'free', keyType: 'browser', allowedOrigins: ['https://app.example.com'] };
  const serverKey = { apiKeyId: 'k2', customerId: 'c1', planKey: 'free', keyType: 'server', allowedOrigins: [] };

  it('allows a browser call from a registered origin', async () => {
    const { guard, ctx } = buildGuard(browserKey);
    await expect(
      guard.canActivate(ctx({ ...KEY, origin: 'https://app.example.com' }) as never),
    ).resolves.toBe(true);
  });

  it('rejects (403) a browser call from an unregistered origin — leaked browser key on another site', async () => {
    const { guard, ctx } = buildGuard(browserKey);
    await expect(
      guard.canActivate(ctx({ ...KEY, origin: 'https://evil.com' }) as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('allows server-to-server calls (no Origin header) for both key types', async () => {
    const browser = buildGuard(browserKey);
    await expect(browser.guard.canActivate(browser.ctx(KEY) as never)).resolves.toBe(true);
    const server = buildGuard(serverKey);
    await expect(server.guard.canActivate(server.ctx(KEY) as never)).resolves.toBe(true);
  });

  it('rejects (403) ANY browser call on a server key — a backend key leaked into frontend JS', async () => {
    const { guard, ctx } = buildGuard(serverKey);
    await expect(
      guard.canActivate(ctx({ ...KEY, origin: 'https://anywhere.com' }) as never),
    ).rejects.toMatchObject({ status: 403 });
  });
});
