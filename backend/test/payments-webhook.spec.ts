import 'reflect-metadata';
import { NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Model } from 'mongoose';
import { PaymentsWebhookController } from '../src/payments/payments-webhook.controller.js';
import type { ApplyInput, ApplyOutcome, PaymentApplyService } from '../src/payments/payment-apply.service.js';
import type {
  PaymentProvider,
  ProviderPayment,
  WebhookEnvelope,
} from '../src/payments/payment-provider.interface.js';
import type { PaymentProviderRegistry } from '../src/payments/provider-registry.js';
import type { WebhookEvent } from '../src/payments/schemas/webhook-event.schema.js';

/**
 * `POST /webhooks/payments/:provider` — the one unauthenticated write path into
 * the billing subsystem.
 *
 * The status code is a CONTROL SIGNAL here, not a description: a rail retries
 * on anything that is not 2xx. So every assertion below is really about whether
 * the rail is being told to come back, and the two properties that matter most
 * are (a) no business outcome is ever a 5xx, and (b) nothing from the body is
 * ever believed.
 *
 * Real controller, stubbed models — asserting against a stubbed controller
 * would test nothing.
 */

const BODY = Buffer.from(JSON.stringify({ id: 'evt_1', eventType: 'newPayment' }));

interface Stack {
  controller: PaymentsWebhookController;
  events: StoredEvent[];
  applied: ApplyInput[];
  getPaymentCalls: string[];
}

interface StoredEvent {
  _id: string;
  provider: string;
  providerEventId: string;
  payloadHash: string;
  status: string;
  attempts: number;
  lastError?: string;
  receivedAt: Date;
}

/** A duplicate-key error shaped exactly as the Mongo driver raises one. */
function e11000(): Error & { code: number } {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

function buildStack(
  opts: {
    verify?: boolean;
    envelope?: WebhookEnvelope | null;
    payment?: ProviderPayment | null;
    getPaymentThrows?: Error;
    seedEvent?: Partial<StoredEvent>;
    applyOutcome?: ApplyOutcome;
    applyThrows?: Error;
    webhooks?: boolean;
    knownProvider?: boolean;
  } = {},
): Stack {
  const events: StoredEvent[] = [];
  if (opts.seedEvent) {
    events.push({
      _id: 'seed',
      provider: 'radom',
      providerEventId: 'evt_1',
      payloadHash: 'a-different-hash',
      status: 'processed',
      attempts: 1,
      receivedAt: new Date(),
      ...opts.seedEvent,
    });
  }
  const applied: ApplyInput[] = [];
  const getPaymentCalls: string[] = [];

  const eventsModel = {
    async create(doc: Omit<StoredEvent, '_id'>) {
      if (events.some((e) => e.provider === doc.provider && e.providerEventId === doc.providerEventId)) {
        // The unique `{provider, providerEventId}` index. Insert-first, and
        // E11000 IS the replay answer.
        throw e11000();
      }
      const row: StoredEvent = { _id: `evt-${events.length}`, ...doc };
      events.push(row);
      return row;
    },
    findOne(filter: { provider: string; providerEventId: string }) {
      const found = events.find(
        (e) => e.provider === filter.provider && e.providerEventId === filter.providerEventId,
      );
      return { lean: () => ({ exec: async () => found ?? null }) };
    },
    deleteOne(filter: Record<string, unknown>) {
      return {
        exec: async () => {
          const idx = events.findIndex((e) => e._id === filter._id);
          if (idx >= 0) events.splice(idx, 1);
          return { deletedCount: idx >= 0 ? 1 : 0 };
        },
      };
    },
    updateOne(filter: Record<string, unknown>, update: { $set?: Partial<StoredEvent>; $inc?: { attempts: number } }) {
      return {
        exec: async () => {
          const row = events.find(
            (e) =>
              e._id === filter._id ||
              (e.provider === filter.provider && e.providerEventId === filter.providerEventId),
          );
          if (row) {
            if (update.$set) Object.assign(row, update.$set);
            if (update.$inc?.attempts) row.attempts += update.$inc.attempts;
          }
          return { matchedCount: row ? 1 : 0 };
        },
      };
    },
  } as unknown as Model<WebhookEvent>;

  const provider: PaymentProvider = {
    key: 'radom',
    capabilities: {
      hostedCheckout: true,
      recurring: false,
      webhooks: opts.webhooks ?? true,
      bodySignature: false,
      variableSettlement: true,
    },
    isConfigured: () => true,
    createCheckout: async () => ({ ref: 'x', hostedUrl: 'https://pay.test/x' }),
    async getPayment(id: string) {
      getPaymentCalls.push(id);
      if (opts.getPaymentThrows) throw opts.getPaymentThrows;
      return opts.payment === undefined
        ? { providerPaymentId: id, status: 'succeeded', amountMinor: 9900, currency: 'USD', reference: 'inv1' }
        : opts.payment;
    },
    verifyWebhook: () => opts.verify ?? true,
    parseWebhook: () =>
      opts.envelope === undefined
        ? { providerEventId: 'evt_1', kind: 'payment', providerPaymentId: 'pay_1' }
        : opts.envelope,
  };

  const registry = {
    find: (key: string) => ((opts.knownProvider ?? true) && key === 'radom' ? provider : undefined),
  } as unknown as PaymentProviderRegistry;

  const applyService = {
    async apply(input: ApplyInput) {
      applied.push(input);
      if (opts.applyThrows) throw opts.applyThrows;
      return opts.applyOutcome ?? { applied: true, reason: 'applied' as const };
    },
  } as unknown as PaymentApplyService;

  return {
    controller: new PaymentsWebhookController(eventsModel, registry, applyService),
    events,
    applied,
    getPaymentCalls,
  };
}

const req = (body?: Buffer) => ({ rawBody: body ?? BODY, headers: {} });

describe('webhook — authentication', () => {
  it('401s a body whose signature does not verify, and applies nothing', async () => {
    const stack = buildStack({ verify: false });
    await expect(stack.controller.receive('radom', req())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(stack.applied).toHaveLength(0);
    // Nothing is even recorded — an unauthenticated request must not be able to
    // fill `webhook_events` with rows of its choosing.
    expect(stack.events).toHaveLength(0);
  });

  it('401s when rawBody is missing rather than verifying an empty buffer', async () => {
    // Almost always a missing `rawBody: true` in main.ts. Failing CLOSED here
    // means the symptom is "every delivery rejected", not "every delivery
    // accepted unverified".
    const stack = buildStack();
    await expect(
      stack.controller.receive('radom', { rawBody: undefined, headers: {} }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(stack.applied).toHaveLength(0);
  });

  it('404s an unknown rail, and a KNOWN rail that has no webhooks — the same answer', async () => {
    // Identical for both so a prober cannot enumerate which rails this
    // deployment has credentials for.
    await expect(
      buildStack({ knownProvider: false }).controller.receive('nope', req()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      buildStack({ webhooks: false }).controller.receive('radom', req()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('webhook — the body is never believed', () => {
  it('ALWAYS re-fetches the payment before applying anything', async () => {
    // THE CORE PROPERTY. Radom authenticates with a static shared key, so a
    // verified body proves only that the sender knew a secret.
    // MUTATION: pass the envelope straight to `apply` → this fails.
    const stack = buildStack();
    await stack.controller.receive('radom', req());
    expect(stack.getPaymentCalls).toEqual(['pay_1']);
    expect(stack.applied).toHaveLength(1);
    // What reached the fold is the RE-FETCHED payment, not the envelope.
    expect(stack.applied[0].payment.amountMinor).toBe(9900);
  });

  it('200s an authenticated body it cannot parse, and applies nothing', async () => {
    // The sender knew the secret, so this is a shape change on our side of the
    // contract. No number of retries teaches us to parse it, so telling the
    // rail to retry (4xx/5xx) would just re-deliver forever.
    const stack = buildStack({ envelope: null });
    const result = await stack.controller.receive('radom', req());
    expect(result).toEqual({ received: true, handled: false, reason: 'unparseable' });
    expect(stack.applied).toHaveLength(0);
  });

  it('200s an event type it does not act on, and records it as ignored', async () => {
    const stack = buildStack({ envelope: { providerEventId: 'evt_1', kind: 'ignored' } });
    const result = await stack.controller.receive('radom', req());
    expect(result.reason).toBe('ignored');
    expect(stack.events[0].status).toBe('ignored');
    expect(stack.applied).toHaveLength(0);
  });

  it('200s a payment the rail has never heard of, and applies nothing', async () => {
    // `getPayment` returning null means "forged or stale id from a sender
    // holding a valid key" — a transport failure THROWS and is handled below.
    const stack = buildStack({ payment: null });
    const result = await stack.controller.receive('radom', req());
    expect(result.reason).toBe('unknown-payment');
    expect(stack.applied).toHaveLength(0);
    expect(stack.events[0].status).toBe('ignored');
  });
});

describe('webhook — replay', () => {
  it('200s a replay without applying it a second time', async () => {
    // Layer 1: the unique `{provider, providerEventId}` index, used the
    // race-free way round — insert first, treat E11000 as "already seen".
    const stack = buildStack();
    const first = await stack.controller.receive('radom', req());
    expect(first.handled).toBe(true);
    expect(stack.applied).toHaveLength(1);

    const second = await stack.controller.receive('radom', req());
    expect(second).toEqual({ received: true, handled: false, reason: 'duplicate' });
    expect(stack.applied).toHaveLength(1); // NOT two
  });

  it('counts a replay attempt on the stored event', async () => {
    const stack = buildStack();
    await stack.controller.receive('radom', req());
    await stack.controller.receive('radom', req());
    expect(stack.events[0].attempts).toBe(2);
  });

  it('does not re-fetch on a replay — the work happens after the insert', async () => {
    const stack = buildStack();
    await stack.controller.receive('radom', req());
    await stack.controller.receive('radom', req());
    expect(stack.getPaymentCalls).toHaveLength(1);
  });
});

describe('webhook — business outcomes are 200s, infrastructure is a 503', () => {
  it('200s a refused payment (short, wrong currency, invoice already settled)', async () => {
    // MUTATION: throw on `outcome.applied === false` → this fails, and every
    // short payment would be re-delivered by the rail until it gave up.
    for (const outcome of [
      { applied: false, reason: 'refused' as const, refusal: 'short-paid' as const },
      { applied: false, reason: 'refused' as const, refusal: 'currency-mismatch' as const },
      { applied: false, reason: 'duplicate' as const },
      { applied: false, reason: 'unknown-invoice' as const },
    ]) {
      const stack = buildStack({ applyOutcome: outcome });
      const result = await stack.controller.receive('radom', req());
      expect(result.received).toBe(true);
      expect(result.handled).toBe(false);
      expect(stack.events[0].status).toBe('processed');
    }
  });

  it('503s when the rail cannot be reached to re-fetch — the one retryable case', async () => {
    const stack = buildStack({ getPaymentThrows: new Error('socket hang up') });
    await expect(stack.controller.receive('radom', req())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(stack.applied).toHaveLength(0);
    // The event row is RELEASED, not marked failed. See the next test — that
    // is the whole reason the 503 is worth sending.
    expect(stack.events).toHaveLength(0);
  });

  it('a retry AFTER a 503 is processed, not swallowed as a replay', async () => {
    // THE REGRESSION (2026-08-06 review). `webhook_events` is inserted BEFORE
    // the re-fetch — it has to be, insert-first is what makes the replay guard
    // race-free — so leaving the row behind meant the rail's retry hit the
    // unique {provider, providerEventId} index, was answered `duplicate`, and
    // the payment was NEVER applied. A 503 that guarantees its own retry is
    // discarded is worse than a 200: it looks like resilience and is a silent
    // drop.
    // MUTATION: replace the deleteOne with a `finish(eventId, 'failed')` → fails.
    let failNext = true;
    const stack = buildStack({ getPaymentThrows: new Error('socket hang up') });
    // Rebuild the provider's getPayment so the FIRST call throws and the
    // second succeeds, which is exactly the shape of a transient outage.
    const registry = (stack.controller as unknown as { registry: { find: (k: string) => { getPayment: unknown } | undefined } }).registry;
    const provider = registry.find('radom')!;
    provider.getPayment = async (id: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('socket hang up');
      }
      return { providerPaymentId: id, status: 'succeeded', amountMinor: 9900, currency: 'USD', reference: 'inv1' };
    };

    await expect(stack.controller.receive('radom', req())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(stack.applied).toHaveLength(0);

    // The rail retries the SAME event id.
    const retry = await stack.controller.receive('radom', req());
    expect(retry.handled).toBe(true);
    expect(stack.applied).toHaveLength(1);
  });

  it('marks the event failed and RETHROWS when the apply itself blows up', async () => {
    // A Mongo outage or a bug — genuinely unexpected, and genuinely retryable,
    // so it propagates as a 500 rather than being swallowed into a 200. The
    // event is left `failed` with the reason, which is what
    // `payment-reconcile`'s stuck-event pass looks for.
    const stack = buildStack({ applyThrows: new Error('Mongo unreachable') });
    await expect(stack.controller.receive('radom', req())).rejects.toThrow('Mongo unreachable');
    expect(stack.events).toHaveLength(1);
    expect(stack.events[0].status).toBe('failed');
    expect(stack.events[0].lastError).toContain('Mongo unreachable');
  });
});

describe('webhook — payload mutation under a reused event id', () => {
  it('flags the same event id arriving with a different body, and grants nothing', async () => {
    // A replay is normal and silent. The same id with a DIFFERENT body is
    // either the rail mutating a payload or somebody with the shared key
    // replaying an id with a payload of their own. Nothing is granted either
    // way — the re-fetch decides — but `payloadHash` exists to make it visible.
    const stack = buildStack({ seedEvent: { payloadHash: 'not-the-hash-of-this-body' } });
    const result = await stack.controller.receive('radom', req());
    expect(result.reason).toBe('duplicate');
    expect(stack.applied).toHaveLength(0);
  });
});
