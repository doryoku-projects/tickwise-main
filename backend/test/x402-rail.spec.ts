import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';
import { Eip3009DomainService } from '../src/payments/providers/x402/eip3009-domain.service.js';
import { X402PaymentProvider } from '../src/payments/providers/x402/x402.provider.js';
import {
  AUTHORIZATION_STATE_SELECTOR,
  DOMAIN_SEPARATOR_SELECTOR,
  NAME_SELECTOR,
  VERSION_SELECTOR,
  authorizationDomainSeparator,
} from '../src/payments/providers/x402/eip3009.js';
import type { PaymentToken } from '../src/config/payment-tokens.config.js';
import type { AppConfigService } from '../src/config/app-config.service.js';

/**
 * The x402 rail's two load-bearing guards.
 *
 * 1. `Eip3009DomainService` REFUSES a token whose EIP-712 domain it computes
 *    differently from the token's own `DOMAIN_SEPARATOR()`. Without that check,
 *    a bridged or non-standard deployment produces signatures the wallet makes
 *    happily and the token rejects — a silent, total failure with no error
 *    anywhere on our side.
 * 2. `X402PaymentProvider.createCheckout` mints ONE nonce per invoice and reuses
 *    it. The nonce IS the invoice reference on this rail, so a second nonce for
 *    one invoice is a second payable authorization — an overpayment we created.
 *
 * Both are driven against scripted `eth_call` responses through the same
 * `clientFor` seam `payment-watcher.spec.ts` uses.
 */

const USDC_BASE: PaymentToken = {
  chainId: 8453,
  symbol: 'USDC',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  decimals: 6,
  stable: true,
};
const TREASURY = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const CUSTOMER = '507f1f77bcf86cd799439011';
const INVOICE = '507f1f77bcf86cd799439022';

/** ABI-encode a `string` return, as `eth_call` would. */
const encodeString = (value: string): string =>
  encodeAbiParameters([{ type: 'string' }], [value]);

function config(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    evmRpcUrls: new Map([[8453, 'http://rpc.test']]),
    acceptedPaymentTokens: [USDC_BASE],
    x402TreasuryAddress: TREASURY,
    // The SIGNING window (Phase 2) and the QUOTE window are different clocks —
    // conflating them is what made renewals unpayable, so the fake carries both.
    x402AuthorizationTtlMs: 1_800_000,
    x402QuoteTtlMs: 30 * 24 * 60 * 60 * 1000,
    x402PaymentsConfigured: true,
    x402ConfigProblem: () => null,
    minConfirmationsFor: () => 30,
    ...overrides,
  } as unknown as AppConfigService;
}

/**
 * A scripted token. `version` and `separator` are independently settable so the
 * mismatch case can be built exactly as it occurs in the wild: a readable
 * name/version whose separator does not agree.
 */
function fakeToken(opts: { name?: string; version?: string; separator?: string; supportsEip3009?: boolean } = {}) {
  const name = opts.name ?? 'USD Coin';
  const version = opts.version ?? '2';
  const separator =
    opts.separator ??
    authorizationDomainSeparator({
      name,
      version,
      chainId: USDC_BASE.chainId,
      verifyingContract: USDC_BASE.address as Hex,
    });
  const calls: string[] = [];
  return {
    calls,
    rpc: {
      async ethCall(_to: string, data: string) {
        calls.push(data.slice(0, 10));
        if (data.startsWith(AUTHORIZATION_STATE_SELECTOR)) {
          if (opts.supportsEip3009 === false) throw new Error('execution reverted');
          return `0x${'0'.repeat(64)}`;
        }
        if (data === NAME_SELECTOR) return encodeString(name);
        if (data === VERSION_SELECTOR) return encodeString(version);
        if (data === DOMAIN_SEPARATOR_SELECTOR) return separator;
        throw new Error(`unexpected call ${data}`);
      },
      async blockNumber() {
        return 1000n;
      },
    },
  };
}

function buildDomainService(token: ReturnType<typeof fakeToken>, cfg = config()) {
  const service = new Eip3009DomainService(cfg);
  (service as unknown as { clientFor: () => unknown }).clientFor = () => token.rpc;
  return service;
}

describe('Eip3009DomainService — the on-chain ground-truth check', () => {
  it('verifies a token whose DOMAIN_SEPARATOR() agrees with our computation', async () => {
    const token = fakeToken();
    const domain = await buildDomainService(token).resolve(USDC_BASE);

    expect(domain).toMatchObject({ name: 'USD Coin', version: '2', chainId: 8453 });
    // The support probe runs FIRST — cheapest rejection of a non-EIP-3009 token.
    expect(token.calls[0]).toBe(AUTHORIZATION_STATE_SELECTOR);
  });

  it('REFUSES a token whose separator disagrees — the bridged/wrong-version trap', async () => {
    // Readable name and version, but the contract's own separator differs. This
    // is what a bridged USDC.e or an upgraded token looks like, and it is the
    // one failure that is otherwise completely silent.
    const token = fakeToken({ separator: `0x${'11'.repeat(32)}` });
    const service = buildDomainService(token);

    await expect(service.resolve(USDC_BASE)).rejects.toThrow(/does not match the token's own/i);
    expect(await service.isSupported(USDC_BASE)).toBe(false);
  });

  it('caches a definitive mismatch permanently — no retry can fix a wrong domain', async () => {
    const token = fakeToken({ separator: `0x${'11'.repeat(32)}` });
    const service = buildDomainService(token);

    await expect(service.resolve(USDC_BASE)).rejects.toThrow();
    const callsAfterFirst = token.calls.length;
    await expect(service.resolve(USDC_BASE)).rejects.toThrow(/not usable/i);
    // Second attempt short-circuits: no further RPC round trip.
    expect(token.calls.length).toBe(callsAfterFirst);
  });

  it('does NOT cache a transport failure — an unreachable node must not disable a token', async () => {
    let failing = true;
    const good = fakeToken();
    const service = new Eip3009DomainService(config());
    (service as unknown as { clientFor: () => unknown }).clientFor = () => ({
      async ethCall(to: string, data: string) {
        if (failing) throw new Error('ECONNREFUSED');
        return good.rpc.ethCall(to, data);
      },
    });

    await expect(service.resolve(USDC_BASE)).rejects.toThrow(/ECONNREFUSED|authorizationState/i);
    // The node comes back; the token must verify rather than stay poisoned.
    failing = false;
    await expect(service.resolve(USDC_BASE)).resolves.toMatchObject({ version: '2' });
  });

  it('refuses a token that does not implement EIP-3009 at all (the USDT case)', async () => {
    const token = fakeToken({ supportsEip3009: false });
    await expect(buildDomainService(token).resolve(USDC_BASE)).rejects.toThrow(
      /authorizationState|EIP-3009/i,
    );
  });

  it('caches a verified domain — one round trip per token, not one per checkout', async () => {
    const token = fakeToken();
    const service = buildDomainService(token);
    await service.resolve(USDC_BASE);
    const after = token.calls.length;
    await service.resolve(USDC_BASE);
    expect(token.calls.length).toBe(after);
  });
});

// ─── the provider ──────────────────────────────────────────────────────────

/** An in-memory stand-in for the authorizations collection. */
function authorizations(rows: Array<Record<string, unknown>> = []) {
  let nextId = 1;
  const matches = (row: Record<string, unknown>, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([k, v]) => String(row[k]) === String(v));

  return {
    rows,
    findOne(filter: Record<string, unknown>) {
      const found = rows.find((r) => matches(r, filter)) ?? null;
      const chain = { lean: () => chain, exec: async () => found };
      return chain;
    },
    async create(doc: Record<string, unknown>) {
      // The unique {invoiceId, chainId} index, modelled — a second mint for one
      // invoice must collide rather than quietly produce a second nonce.
      const clash = rows.some(
        (r) => String(r.invoiceId) === String(doc.invoiceId) && r.chainId === doc.chainId,
      );
      if (clash) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      const row = { _id: `auth${nextId++}`, ...doc };
      rows.push(row);
      return row;
    },
    /** Backs the rotate path, including its status guard. */
    findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>) {
      const chain = {
        lean: () => chain,
        exec: async () => {
          const row = rows.find((r) => matches(r, filter));
          if (!row) return null; // the status guard did not match
          const set = update.$set as Record<string, unknown> | undefined;
          const unset = update.$unset as Record<string, unknown> | undefined;
          if (set) Object.assign(row, set);
          if (unset) for (const k of Object.keys(unset)) delete row[k];
          return row;
        },
      };
      return chain;
    },
  };
}

function buildProvider(opts: { supported?: boolean; cfg?: AppConfigService; rows?: Array<Record<string, unknown>> } = {}) {
  const store = authorizations(opts.rows ?? []);
  const domains = {
    isSupported: async () => opts.supported ?? true,
    resolve: async () => ({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: USDC_BASE.address as Hex,
    }),
  } as unknown as Eip3009DomainService;
  const provider = new X402PaymentProvider(opts.cfg ?? config(), domains, store as never);
  // Stubbed rather than left to fail: without this the provider made a real DNS
  // lookup for `rpc.test` on every checkout, so these unit tests exercised the
  // network. `blockNumber` is the only call `currentHead` makes.
  (provider as unknown as { clientFor: () => unknown }).clientFor = () => ({
    async blockNumber() {
      return 1000n;
    },
  });
  return { provider, store };
}

const checkoutArgs = {
  reference: INVOICE,
  amountMinor: 1900,
  currency: 'USD',
  description: 'Standard',
  customerId: CUSTOMER,
  successUrl: 'https://portal.test/ok',
  cancelUrl: 'https://portal.test/no',
};

describe('X402PaymentProvider.createCheckout', () => {
  it('mints an authorization quote with the nonce as the invoice reference', async () => {
    const { provider, store } = buildProvider();
    const checkout = await provider.createCheckout(checkoutArgs);

    expect(checkout.instructions?.kind).toBe('authorization');
    const instructions = checkout.instructions as { nonce: string; treasuryAddress: string; amountBaseUnits: string; amountDisplay: string };
    expect(instructions.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    // The rail's ref IS the nonce — that is what `AuthorizationUsed` carries back.
    expect(checkout.ref).toBe(instructions.nonce);
    expect(instructions.treasuryAddress).toBe(TREASURY);
    // 1900 USD minor at 6 decimals = 19 USDC.
    expect(instructions.amountBaseUnits).toBe('19000000');
    expect(instructions.amountDisplay).toBe('19 USDC');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: 'issued', validAfter: 0 });
    // NOT stamped at mint: `from` needs a connected wallet, which does not exist
    // when a renewal invoice is raised by the sweep.
    expect(store.rows[0].fromAddress).toBeUndefined();
  });

  it('REUSES the same nonce on a second checkout while the quote is still LIVE', async () => {
    const { provider, store } = buildProvider();
    const first = await provider.createCheckout(checkoutArgs);
    const second = await provider.createCheckout(checkoutArgs);

    // Two live authorizations for one invoice would be two payments the customer
    // could each complete — an overpayment of our own making.
    expect(second.ref).toBe(first.ref);
    expect(store.rows).toHaveLength(1);
  });

  it('does NOT put a validBefore on the quote — that window belongs to the signature', async () => {
    const { provider, store } = buildProvider();
    await provider.createCheckout(checkoutArgs);
    // Stamping a 30-minute deadline HERE is what made every sweep-raised renewal
    // unpayable: the quote is minted ~7 days before its period starts.
    expect(store.rows[0].validBefore).toBeUndefined();
    expect(store.rows[0].quoteExpiresAt).toBeInstanceOf(Date);
    expect((store.rows[0].quoteExpiresAt as Date).getTime()).toBeGreaterThan(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    );
  });

  it('ROTATES an EXPIRED quote instead of handing back a dead one', async () => {
    const { provider, store } = buildProvider();
    const first = await provider.createCheckout(checkoutArgs);
    // The quote goes stale (a renewal sitting through its lead window).
    store.rows[0].quoteExpiresAt = new Date(Date.now() - 1000);

    const second = await provider.createCheckout(checkoutArgs);

    expect(second.ref).not.toBe(first.ref); // fresh nonce
    expect(store.rows).toHaveLength(1); // rotated IN PLACE, not duplicated
    expect(store.rows[0].status).toBe('issued');
    expect((store.rows[0].quoteExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('ROTATES when the invoice AMOUNT moved after minting (proration, credit applied)', async () => {
    const { provider, store } = buildProvider();
    const first = await provider.createCheckout(checkoutArgs);
    expect(store.rows[0].expectedBaseUnits).toBe('19000000');

    // The invoice is now for $4 after a proration credit. Reusing the old quote
    // would authorize $19 — inside a signature that cannot be corrected.
    const second = await provider.createCheckout({ ...checkoutArgs, amountMinor: 400 });

    expect(second.ref).not.toBe(first.ref);
    expect(store.rows[0].expectedBaseUnits).toBe('4000000');
  });

  it('REFUSES to rotate a submitted authorization — a relay may be in flight', async () => {
    const { provider, store } = buildProvider();
    const first = await provider.createCheckout(checkoutArgs);
    store.rows[0].status = 'submitted';
    store.rows[0].quoteExpiresAt = new Date(Date.now() - 1000);

    const second = await provider.createCheckout(checkoutArgs);

    // Replacing the nonce here would leave a real payment arriving against a
    // nonce nothing is watching for.
    expect(second.ref).toBe(first.ref);
    expect(store.rows[0].status).toBe('submitted');
  });

  it('clears a stale wallet binding and signature when it rotates', async () => {
    const { provider, store } = buildProvider();
    await provider.createCheckout(checkoutArgs);
    Object.assign(store.rows[0], {
      status: 'authorized',
      fromAddress: '0x1111111111111111111111111111111111111111',
      domainName: 'USD Coin',
      domainVersion: '2',
      signature: `0x${'ab'.repeat(65)}`,
      validBefore: Math.floor(Date.now() / 1000) - 60,
      quoteExpiresAt: new Date(Date.now() - 1000),
    });

    await provider.createCheckout(checkoutArgs);

    // Left in place, these would be verified against a payload nobody signed.
    for (const field of ['fromAddress', 'domainName', 'domainVersion', 'signature', 'validBefore']) {
      expect(store.rows[0][field]).toBeUndefined();
    }
  });

  it('REFUSES a non-USD invoice rather than quoting it 1:1 in USDC', async () => {
    const { provider } = buildProvider();
    await expect(
      provider.createCheckout({ ...checkoutArgs, currency: 'EUR' }),
    ).rejects.toMatchObject({ response: { error: expect.stringMatching(/USD invoices/i) } });
  });

  it('omits amountMinor from getPayment — reporting 0 would erase a paid invoice', async () => {
    const { provider, store } = buildProvider();
    const checkout = await provider.createCheckout(checkoutArgs);
    store.rows[0].status = 'settled';

    const payment = await provider.getPayment(checkout.ref);

    // `PaymentReconcileService` merges `fresh?.amountMinor ?? latest.amountMinor`.
    // A literal 0 here won that merge and re-applied the payment as zero, and
    // because the invoice total is RECOMPUTED from applied payments, the real
    // money vanished off a paid invoice.
    expect(payment?.amountMinor).toBeUndefined();
    expect(payment?.status).toBe('succeeded');
  });

  it('REFUSES a checkout with no customerId — the bug that broke the deposit rail 100%', async () => {
    const { provider } = buildProvider();
    await expect(
      provider.createCheckout({ ...checkoutArgs, customerId: undefined }),
    ).rejects.toMatchObject({ response: { error: expect.stringMatching(/customer id/i) } });
  });

  it('REFUSES a checkout when no accepted token has a verified domain', async () => {
    const { provider } = buildProvider({ supported: false });
    await expect(provider.createCheckout(checkoutArgs)).rejects.toMatchObject({
      response: { error: expect.stringMatching(/temporarily unavailable/i) },
    });
  });

  it('REFUSES a non-stablecoin — the signed amount cannot be corrected after the fact', async () => {
    const volatile = { ...USDC_BASE, symbol: 'WETH', stable: false };
    const { provider } = buildProvider({
      cfg: config({ acceptedPaymentTokens: [volatile] }),
    });
    await expect(provider.createCheckout(checkoutArgs)).rejects.toMatchObject({
      response: { error: expect.stringMatching(/not a stablecoin/i) },
    });
  });

  it('REFUSES an invalid invoice id rather than minting an unattributable nonce', async () => {
    const { provider } = buildProvider();
    await expect(
      provider.createCheckout({ ...checkoutArgs, reference: 'not-an-objectid' }),
    ).rejects.toMatchObject({ response: { error: expect.stringMatching(/invoice id/i) } });
  });

  it('holds no key and accepts no webhook — fails closed on both', async () => {
    const { provider } = buildProvider();
    expect(provider.verifyWebhook(Buffer.from('{}'), {})).toBe(false);
    expect(provider.parseWebhook(Buffer.from('{}'))).toBeNull();
    expect(provider.capabilities).toMatchObject({
      onChainDirect: true,
      hostedCheckout: false,
      webhooks: false,
      // Nothing on this rail can re-charge a wallet later; the sweep raises
      // every renewal invoice.
      recurring: false,
    });
  });

  it('resolves getPayment from the nonce prefix of a composite id (the dead-backstop bug)', async () => {
    const { provider, store } = buildProvider();
    const checkout = await provider.createCheckout(checkoutArgs);
    const nonce = checkout.ref;
    store.rows[0].status = 'settled';
    store.rows[0].txHash = '0xabc';

    // The watcher records `<nonce>:<tx>:<logIndex>`; a lookup of the whole
    // composite would match nothing and silently disable reconcile.
    const payment = await provider.getPayment(`${nonce}:0xabc:3`);
    expect(payment?.status).toBe('succeeded');
    expect(payment?.reference).toBe(INVOICE);
    // A bare nonce resolves too, so an admin passing one works.
    expect((await provider.getPayment(nonce))?.status).toBe('succeeded');
  });

  it('returns null for an unknown nonce, and pending for an unsettled one', async () => {
    const { provider } = buildProvider();
    expect(await provider.getPayment(`0x${'ab'.repeat(32)}`)).toBeNull();
    await provider.createCheckout(checkoutArgs);
    const checkout = await provider.createCheckout(checkoutArgs);
    expect((await provider.getPayment(checkout.ref))?.status).toBe('pending');
  });
});
