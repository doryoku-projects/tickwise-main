import { describe, expect, it, vi } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/billing/api-key.util.js';
import { ClientsService } from '../src/billing/clients.service.js';

describe('api-key.util', () => {
  it('generates a kc_live_ key whose hash matches hashApiKey(raw)', () => {
    const k = generateApiKey();
    expect(k.raw.startsWith('kc_live_')).toBe(true);
    expect(k.hash).toEqual(hashApiKey(k.raw));
    expect(k.prefix.length).toBe(16);
    expect(k.hash).not.toContain(k.raw); // hash never embeds the secret
  });
});

describe('ClientsService key lifecycle', () => {
  function build(overrides: { customers?: any; apiKeys?: any; usage?: any } = {}) {
    const customers = overrides.customers ?? {};
    const apiKeys = overrides.apiKeys ?? {};
    const usage = overrides.usage ?? {};
    return new ClientsService(customers as never, apiKeys as never, usage as never);
  }

  // `customers.email` carries a PARTIAL UNIQUE index, so a duplicate address
  // comes back as a raw MongoServerError (code 11000). Unhandled it escaped as
  // a 500 "Internal server error" with nothing actionable in it.
  it('creates a client, and turns a duplicate email into a 409 — not a 500', async () => {
    let createdArgs: any;
    const ok = build({
      customers: {
        create: async (doc: any) => ((createdArgs = doc), { toObject: () => ({ _id: 'c1', ...doc }) }),
      },
    });
    await expect(ok.createClient({ name: 'Acme', email: 'ops@acme.test' })).resolves.toMatchObject({
      name: 'Acme',
      email: 'ops@acme.test',
    });
    expect(createdArgs.planKey).toBeTruthy(); // defaults to the free plan key

    const duplicate = build({
      customers: {
        create: async () => {
          throw Object.assign(new Error('E11000 duplicate key error collection: customers index: email_1'), {
            code: 11000,
          });
        },
      },
    });
    await expect(duplicate.createClient({ name: 'Acme again', email: 'ops@acme.test' })).rejects.toMatchObject({
      status: 409,
      response: { error: 'A client with that email already exists' },
    });
  });

  it('rethrows a non-duplicate create failure untouched', async () => {
    const boom = new Error('connection reset');
    const service = build({ customers: { create: async () => { throw boom; } } });
    await expect(service.createClient({ name: 'Acme' })).rejects.toBe(boom);
  });

  it('issues a key, returning the raw secret once and storing only its hash', async () => {
    let createdArgs: any;
    const service = build({
      customers: { findById: () => ({ lean: () => ({ exec: async () => ({ _id: 'c1', status: 'active', planKey: 'free' }) }) }) },
      apiKeys: {
        create: async (doc: any) => {
          createdArgs = doc;
          return { _id: 'k1', keyPrefix: doc.keyPrefix, label: doc.label, status: doc.status };
        },
      },
    });

    const result = await service.issueKey('6650aaaaaaaaaaaaaaaaaaaa', { label: 'ci-bot' });
    expect(result.apiKey.startsWith('kc_live_')).toBe(true);
    expect(createdArgs.keyHash).toEqual(hashApiKey(result.apiKey));
    expect(createdArgs.label).toBe('ci-bot');
    // defaults to a server key with no origins
    expect(createdArgs.keyType).toBe('server');
    expect(createdArgs.allowedOrigins).toEqual([]);
    // raw secret must never equal the stored hash
    expect(createdArgs.keyHash).not.toEqual(result.apiKey);
  });

  it('resolves an active key to its client + plan', async () => {
    const raw = generateApiKey().raw;
    const service = build({
      apiKeys: {
        findOne: (q: any) => {
          expect(q).toMatchObject({ keyHash: hashApiKey(raw), status: 'active' });
          return { exec: async () => ({ _id: 'k1', customerId: 'c1' }) };
        },
        updateOne: () => ({ exec: async () => undefined }),
      },
      customers: { findById: () => ({ lean: () => ({ exec: async () => ({ _id: 'c1', status: 'active', planKey: 'pro' }) }) }) },
    });

    const resolved = await service.resolveByRawKey(raw);
    // legacy row (no keyType, no origins) is inferred as a server key
    expect(resolved).toEqual({ apiKeyId: 'k1', customerId: 'c1', planKey: 'pro', keyType: 'server', allowedOrigins: [] });
  });

  it('issues a browser key (origins required) and infers keyType on a legacy origin-bound row', async () => {
    let createdArgs: any;
    const service = build({
      customers: { findById: () => ({ lean: () => ({ exec: async () => ({ _id: 'c1', status: 'active', planKey: 'free' }) }) }) },
      apiKeys: { create: async (doc: any) => ((createdArgs = doc), { _id: 'k1', ...doc }) },
    });

    // browser key normalizes + stores origins
    await service.issueKey('6650aaaaaaaaaaaaaaaaaaaa', {
      keyType: 'browser',
      origins: ['https://App.Example.com/'],
    });
    expect(createdArgs.keyType).toBe('browser');
    expect(createdArgs.allowedOrigins).toEqual(['https://app.example.com']);

    // browser key with no origins → 400
    await expect(
      service.issueKey('6650aaaaaaaaaaaaaaaaaaaa', { keyType: 'browser', origins: [] }),
    ).rejects.toMatchObject({ status: 400 });

    // server key with origins → 400
    await expect(
      service.issueKey('6650aaaaaaaaaaaaaaaaaaaa', { keyType: 'server', origins: ['https://x.com'] }),
    ).rejects.toMatchObject({ status: 400 });

    // legacy row carrying origins but no keyType resolves as a browser key
    const raw = generateApiKey().raw;
    const svc2 = build({
      apiKeys: {
        findOne: () => ({ exec: async () => ({ _id: 'k1', customerId: 'c1', allowedOrigins: ['https://app.example.com'] }) }),
        updateOne: () => ({ exec: async () => undefined }),
      },
      customers: { findById: () => ({ lean: () => ({ exec: async () => ({ _id: 'c1', status: 'active', planKey: 'pro' }) }) }) },
    });
    const resolved = await svc2.resolveByRawKey(raw);
    expect(resolved).toEqual({
      apiKeyId: 'k1',
      customerId: 'c1',
      planKey: 'pro',
      keyType: 'browser',
      allowedOrigins: ['https://app.example.com'],
    });
  });

  it('scopes the *Owned key writes by customerId — the filter IS the authorization', async () => {
    const filters: any[] = [];
    // Every write "misses": the key belongs to another tenant, so the scoped
    // filter matches nothing. No fetch-compare-write step exists to race.
    const service = build({
      apiKeys: {
        findOneAndUpdate: (filter: any) => (filters.push(filter), { lean: () => ({ exec: async () => null }) }),
        findOneAndDelete: (filter: any) => (filters.push(filter), { lean: () => ({ exec: async () => null }) }),
      },
    });
    const keyId = '6650bbbbbbbbbbbbbbbbbbbb';
    const owner = '6650aaaaaaaaaaaaaaaaaaaa';

    await expect(service.revokeKeyOwned(keyId, owner)).rejects.toMatchObject({ status: 404 });
    await expect(service.deleteKeyOwned(keyId, owner)).rejects.toMatchObject({ status: 404 });
    await expect(service.setKeyOriginsOwned(keyId, owner, ['https://app.example.com'])).rejects.toMatchObject({ status: 404 });

    expect(filters).toHaveLength(3);
    for (const filter of filters) {
      expect(String(filter._id)).toBe(keyId);
      expect(String(filter.customerId)).toBe(owner); // never a bare { _id }
    }
  });

  it('turns a malformed id into a 404, not a 500, on the scoped paths', async () => {
    const service = build({ apiKeys: { findOneAndUpdate: () => ({ lean: () => ({ exec: async () => null }) }) } });
    await expect(service.revokeKeyOwned('not-an-id', '6650aaaaaaaaaaaaaaaaaaaa')).rejects.toMatchObject({ status: 404 });
    await expect(service.deleteKeyOwned('6650bbbbbbbbbbbbbbbbbbbb', 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('counts only ACTIVE keys for the plan ceiling', async () => {
    let filter: any;
    const service = build({
      apiKeys: { countDocuments: (f: any) => ((filter = f), { exec: async () => 3 }) },
    });
    expect(await service.countActiveKeys('6650aaaaaaaaaaaaaaaaaaaa')).toBe(3);
    expect(String(filter.customerId)).toBe('6650aaaaaaaaaaaaaaaaaaaa');
    expect(filter.status).toBe('active'); // revoked rows stay for audit, don't count
  });

  it('returns null for an unknown key and for a suspended client', async () => {
    const missing = build({ apiKeys: { findOne: () => ({ exec: async () => null }) } });
    expect(await missing.resolveByRawKey('kc_live_x')).toBeNull();

    const suspended = build({
      apiKeys: { findOne: () => ({ exec: async () => ({ _id: 'k1', customerId: 'c1' }) }), updateOne: () => ({ exec: async () => undefined }) },
      customers: { findById: () => ({ lean: () => ({ exec: async () => ({ status: 'suspended', planKey: 'free' }) }) }) },
    });
    expect(await suspended.resolveByRawKey('kc_live_x')).toBeNull();
  });
});
