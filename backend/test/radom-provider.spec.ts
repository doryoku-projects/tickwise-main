import { describe, expect, it } from 'vitest';
import { radomStatus, RadomPaymentProvider, toMinor } from '../src/payments/providers/radom.provider.js';
import type { AppConfigService } from '../src/config/app-config.service.js';

/**
 * The Radom rail's SECURITY surface. Nothing here touches the network: what is
 * being pinned is the webhook authentication and the deliberate poverty of
 * `parseWebhook`, both of which are properties of this file's logic and must
 * survive the wire-format corrections that will land when the sandbox account
 * exists.
 */

const SECRET = 'a-strong-webhook-secret-value';
const PREVIOUS = 'the-previous-webhook-secret';

function provider(overrides: Partial<Record<string, unknown>> = {}): RadomPaymentProvider {
  const config = {
    radomApiKey: 'rdm_test_key',
    radomApiBaseUrl: 'https://api.radom.test',
    radomWebhookSecret: SECRET,
    radomWebhookSecretPrevious: undefined,
    radomAcceptedMethods: [{ token: 'USDC', network: 'Ethereum' }],
    radomCheckoutTtlMs: 3_600_000,
    ...overrides,
  } as unknown as AppConfigService;
  return new RadomPaymentProvider(config);
}

const body = Buffer.from(JSON.stringify({ id: 'evt_1', eventType: 'newPayment' }));

describe('RadomPaymentProvider.isConfigured', () => {
  it('requires BOTH the API key and the webhook secret', () => {
    // A key with no webhook secret can TAKE money and then cannot be told that
    // it did — worse than being switched off. Same both-halves rule as
    // `mailConfigured` and `configuredOauthProviders`.
    expect(provider().isConfigured()).toBe(true);
    expect(provider({ radomWebhookSecret: undefined }).isConfigured()).toBe(false);
    expect(provider({ radomApiKey: undefined }).isConfigured()).toBe(false);
  });
});

describe('RadomPaymentProvider.verifyWebhook', () => {
  it('accepts the current secret', () => {
    expect(provider().verifyWebhook(body, { 'radom-verification-key': SECRET })).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(provider().verifyWebhook(body, { 'radom-verification-key': 'nope' })).toBe(false);
  });

  it('does not THROW on a secret of a different length', () => {
    // THE `timingSafeEqual` TRAP. It throws on unequal lengths, so comparing a
    // stored secret against an attacker-controlled header directly turns the
    // security check into a 500 — and a 500-vs-401 split is a length oracle for
    // the secret. Hashing both sides first makes both operands 32 bytes.
    // MUTATION: compare the raw strings with `timingSafeEqual` → this throws.
    expect(() => provider().verifyWebhook(body, { 'radom-verification-key': 'x' })).not.toThrow();
    expect(provider().verifyWebhook(body, { 'radom-verification-key': 'x' })).toBe(false);
    const long = 'y'.repeat(4096);
    expect(() => provider().verifyWebhook(body, { 'radom-verification-key': long })).not.toThrow();
  });

  it('fails CLOSED when no secret is configured', () => {
    // MUTATION: return true when `current` is absent → this fails, and an
    // unset secret would read as "skip the check" on the one unauthenticated
    // write path into the money code.
    const p = provider({ radomWebhookSecret: undefined });
    expect(p.verifyWebhook(body, { 'radom-verification-key': 'anything' })).toBe(false);
    expect(p.verifyWebhook(body, {})).toBe(false);
  });

  it('fails closed on a missing or blank header', () => {
    expect(provider().verifyWebhook(body, {})).toBe(false);
    expect(provider().verifyWebhook(body, { 'radom-verification-key': '   ' })).toBe(false);
  });

  it('fails closed on a DUPLICATE header', () => {
    // Node presents a repeated header as an array. Something in front of us saw
    // two values and picking one is guessing which is ours — the same
    // fail-closed rule as `readBinderCookie`.
    expect(
      provider().verifyWebhook(body, { 'radom-verification-key': [SECRET, 'planted'] }),
    ).toBe(false);
  });

  it('accepts the PREVIOUS secret during a rotation', () => {
    const p = provider({ radomWebhookSecretPrevious: PREVIOUS });
    expect(p.verifyWebhook(body, { 'radom-verification-key': PREVIOUS })).toBe(true);
    expect(p.verifyWebhook(body, { 'radom-verification-key': SECRET })).toBe(true);
    expect(p.verifyWebhook(body, { 'radom-verification-key': 'neither' })).toBe(false);
  });

  it('does not accept a previous secret that was never configured', () => {
    expect(provider().verifyWebhook(body, { 'radom-verification-key': PREVIOUS })).toBe(false);
  });
});

describe('RadomPaymentProvider.parseWebhook — takes ids, never money', () => {
  it('extracts the event id and the payment id, and NOTHING that grants anything', () => {
    // THE CORE PROPERTY. Radom authenticates with a static shared key, so a
    // verified body proves only that the sender knew a secret. Anyone holding
    // it could post an amount and a status of their choosing — so the envelope
    // has no field to put them in, and `PaymentApplyService` re-fetches.
    const raw = Buffer.from(
      JSON.stringify({
        id: 'evt_99',
        eventType: 'newPayment',
        eventData: { newPayment: { paymentId: 'pay_42', amount: '999999', status: 'succeeded' } },
      }),
    );
    const envelope = provider().parseWebhook(raw);
    expect(envelope).toEqual({
      providerEventId: 'evt_99',
      kind: 'payment',
      providerPaymentId: 'pay_42',
    });
    expect(Object.keys(envelope ?? {})).not.toContain('amountMinor');
    expect(Object.keys(envelope ?? {})).not.toContain('status');
  });

  it('marks an event type we do not act on as `ignored`, not as a failure', () => {
    // `ignored` answers 200, which is what stops the rail retrying an event we
    // will never act on for the rest of its retry window.
    const raw = Buffer.from(JSON.stringify({ id: 'evt_1', eventType: 'subscriptionCancelled' }));
    expect(provider().parseWebhook(raw)).toEqual({ providerEventId: 'evt_1', kind: 'ignored' });
  });

  it('marks a payment event with no payment id as `ignored` rather than guessing', () => {
    const raw = Buffer.from(JSON.stringify({ id: 'evt_2', eventType: 'newPayment', eventData: {} }));
    expect(provider().parseWebhook(raw)?.kind).toBe('ignored');
  });

  it('returns null for a body with no event id — there is nothing to dedupe on', () => {
    expect(provider().parseWebhook(Buffer.from(JSON.stringify({ eventType: 'newPayment' })))).toBeNull();
  });

  it('returns null for a non-JSON body instead of throwing', () => {
    expect(provider().parseWebhook(Buffer.from('<html>gateway error</html>'))).toBeNull();
    expect(provider().parseWebhook(Buffer.from(''))).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(provider().parseWebhook(Buffer.from('"a string"'))).toBeNull();
    expect(provider().parseWebhook(Buffer.from('[1,2,3]'))).toBeNull();
  });
});

describe('radomStatus — an unknown status must never grant anything', () => {
  it('maps the rail\'s success words to `succeeded`', () => {
    for (const word of ['success', 'succeeded', 'complete', 'completed', 'confirmed', 'paid', 'PAID']) {
      expect(radomStatus(word)).toBe('succeeded');
    }
  });

  it('maps the rail\'s terminal-failure words to `failed`', () => {
    for (const word of ['failed', 'error', 'cancelled', 'canceled', 'expired']) {
      expect(radomStatus(word)).toBe('failed');
    }
  });

  it('falls to `pending` for a status this build does not recognise', () => {
    // MUTATION: make the fallback `succeeded` → these fail. It is the whole
    // safety of the mapping: the rail is free to add a status name at any time,
    // and a build that has not learned it yet must WAIT for a reconcile rather
    // than hand out a plan on a word it cannot read. `pending` keeps the
    // payment in the reconcile queue; `succeeded` grants on a guess.
    expect(radomStatus('someFutureStatus')).toBe('pending');
    expect(radomStatus('')).toBe('pending');
    expect(radomStatus(undefined)).toBe('pending');
    expect(radomStatus('partially_refunded')).toBe('pending');
  });
});

describe('toMinor — decimal string to integer cents', () => {
  it('converts without the float truncation trap', () => {
    // MUTATION: `Math.trunc(Number(value) * 100)` → this fails on 19.99, which
    // is 1998.9999999999998 in IEEE-754 and truncates a cent short on EVERY
    // payment of that amount.
    expect(toMinor('19.99')).toBe(1999);
    expect(toMinor('0.07')).toBe(7);
    expect(toMinor('790.00')).toBe(79000);
    expect(toMinor('1234.56')).toBe(123456);
  });

  it('reads 0 for anything unparseable rather than propagating NaN', () => {
    expect(toMinor(undefined)).toBe(0);
    expect(toMinor('')).toBe(0);
    expect(toMinor('not a number')).toBe(0);
  });
});

describe('RadomPaymentProvider.capabilities', () => {
  it('declares NO body signature, which is what mandates the re-fetch', () => {
    // MUTATION: set this true → nothing fails today, because the apply path
    // re-fetches unconditionally. It is asserted anyway: the flag is how a
    // reader learns why, and a future optimisation that skipped the re-fetch
    // "because the signature is verified" would be reading this field.
    expect(provider().capabilities.bodySignature).toBe(false);
  });

  it('declares NOT recurring — the sweep is the only thing that renews', () => {
    expect(provider().capabilities.recurring).toBe(false);
  });

  it('declares variable settlement — crypto senders round and fees come out', () => {
    expect(provider().capabilities.variableSettlement).toBe(true);
  });
});
