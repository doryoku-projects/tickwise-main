import {
  Controller,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDuplicateKey, PaymentApplyService } from './payment-apply.service.js';
import type { WebhookHeaders } from './payment-provider.interface.js';
import { PaymentProviderRegistry } from './provider-registry.js';
import { WebhookEvent } from './schemas/webhook-event.schema.js';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

/** The Express request shape this handler needs. `rawBody` comes from `main.ts`. */
interface RawRequest {
  rawBody?: Buffer;
  body?: unknown;
  headers: WebhookHeaders;
}

/**
 * `POST /webhooks/payments/:provider` — the one unauthenticated write path into
 * the billing subsystem.
 *
 * ── WHY THERE IS NO DTO ────────────────────────────────────────────────────
 *
 * The handler takes `@Req()` and nothing else. A DTO would be validated by the
 * global pipe with `forbidNonWhitelisted`, so the FIRST field the vendor adds
 * to their payload — which they will, without telling us — would 400 every
 * delivery. And a 400 is the answer that makes them retry, so the failure mode
 * is a queue of rejected real payments. The body is read as raw bytes because a
 * signature is over bytes: `JSON.parse` → `JSON.stringify` is not the identity
 * function (key order, unicode escapes, number formatting), so verifying a
 * re-serialised body verifies something the sender never signed.
 *
 * ── WHAT STATUS CODE MEANS WHAT ────────────────────────────────────────────
 *
 * A rail retries on anything that is not 2xx, so the status code is a control
 * signal, not a description:
 *
 *   200  handled, ignored, replayed, refused, unparseable — DO NOT RETRY.
 *        Every business outcome is a 200. A short payment, a wrong currency, an
 *        invoice already settled, an event type we do not act on: retrying
 *        cannot change any of them, so a non-2xx would just re-deliver forever.
 *   401  the shared key did not match. Deliberately terminal-looking, and
 *        alerted on: the sender is either misconfigured or not the rail.
 *   404  no such rail. Also what an UNCONFIGURED rail returns, so a prober
 *        cannot enumerate which credentials this deployment holds.
 *   503  we could not reach the rail to re-fetch the payment. THE ONE CASE
 *        WHERE A RETRY IS THE RIGHT ANSWER, and the only 5xx here.
 *
 * ── THE THREE IDEMPOTENCY LAYERS ───────────────────────────────────────────
 *
 *   1. `webhook_events` unique `{provider, providerEventId}` — insert FIRST,
 *      before any work, so the index decides whether this is new or a replay.
 *   2. `payments` unique `{provider, providerPaymentId}` — a SECOND, separate
 *      layer, because two different event ids can legitimately describe the
 *      same charge (created + confirmed) and layer 1 would let both through.
 *   3. `Payment.appliedAt` — the atomic claim inside `PaymentApplyService`.
 */
@Controller('webhooks/payments')
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(
    @InjectModel(WebhookEvent.name) private readonly events: Model<WebhookEvent>,
    @Inject(PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry,
    @Inject(PaymentApplyService) private readonly applyService: PaymentApplyService,
  ) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(@Param('provider') providerKey: string, @Req() req: RawRequest) {
    const provider = this.registry.find(providerKey);
    // Unknown and unconfigured are the same answer on purpose — see the class
    // comment. `resolve` would 400 and name the rail; this must not.
    if (!provider || !provider.capabilities.webhooks) {
      throw new NotFoundException({ error: 'Not found' });
    }

    const raw = req.rawBody;
    if (!raw || raw.length === 0) {
      // Almost always a missing `rawBody: true` in `main.ts` rather than a bad
      // sender, and that misconfiguration would silently reject every real
      // delivery — so it is loud.
      this.logger.error(
        `[alert] payments.webhook_no_raw_body provider=${providerKey} — is rawBody enabled in main.ts?`,
      );
      throw new UnauthorizedException({ error: 'Unauthorized' });
    }

    if (!provider.verifyWebhook(raw, req.headers)) {
      // Alerted, because a run of these is either a rotation somebody did not
      // finish or somebody probing the endpoint. NOTHING about the body or the
      // presented key is logged.
      this.logger.error(`[alert] payments.webhook_signature_failed provider=${providerKey}`);
      throw new UnauthorizedException({ error: 'Unauthorized' });
    }

    const envelope = provider.parseWebhook(raw);
    if (!envelope) {
      // Authenticated but unreadable. 200 rather than 400: the sender knew the
      // secret, so this is a shape change on our side of the contract, and no
      // number of retries will teach us to parse it. The alert is the repair.
      this.logger.error(
        `[alert] payments.webhook_unparseable provider=${providerKey} bytes=${raw.length}`,
      );
      return { received: true, handled: false, reason: 'unparseable' };
    }

    // LAYER 1 — insert first, act second.
    const payloadHash = createHash('sha256').update(raw).digest('hex');
    let eventId: unknown;
    try {
      const created = await this.events.create({
        provider: providerKey,
        providerEventId: envelope.providerEventId,
        payloadHash,
        status: 'received',
        attempts: 1,
        receivedAt: new Date(),
      });
      eventId = created._id;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      await this.notePossibleMutation(providerKey, envelope.providerEventId, payloadHash);
      return { received: true, handled: false, reason: 'duplicate' };
    }

    try {
      if (envelope.kind !== 'payment' || !envelope.providerPaymentId) {
        await this.finish(eventId, 'ignored');
        return { received: true, handled: false, reason: 'ignored' };
      }

      // THE RE-FETCH. Unconditional, and the entire reason this rail is safe:
      // Radom authenticates with a static header key, so a verified body proves
      // only that the sender knew a secret — anyone who ever obtained it could
      // otherwise post an amount and a status of their choosing. Nothing from
      // the body reaches the fold; only this payment id was taken from it.
      let fetched;
      try {
        fetched = await provider.getPayment(envelope.providerPaymentId);
      } catch (err) {
        // Transport failure. THE one retryable case, so it is the one 5xx —
        // and the 503 is only worth sending if the retry can actually do
        // something.
        //
        // IT COULD NOT. The `webhook_events` row is inserted BEFORE this
        // re-fetch (it has to be: insert-first is what makes the replay guard
        // race-free), so the rail's retry would hit the unique
        // `{provider, providerEventId}` index, be answered `duplicate`, and the
        // payment would never be applied. A 503 that guarantees its own retry
        // is discarded is worse than a 200 — it looks like resilience and is a
        // silent drop.
        //
        // So the row is DELETED before throwing. Nothing was granted and
        // nothing was recorded against the payment, so there is no state to
        // keep; the retry arrives as a genuinely new event. `payment-reconcile`
        // is the backstop if the rail gives up.
        await this.events.deleteOne({ _id: eventId }).exec().catch(() => undefined);
        this.logger.error(
          `[alert] payments.webhook_refetch_failed provider=${providerKey} payment=${envelope.providerPaymentId}` +
            ' — event row released so the retry is not swallowed as a replay',
        );
        throw new ServiceUnavailableException({ error: 'Could not verify the payment upstream — retry.' });
      }

      if (!fetched) {
        // `getPayment` returns null ONLY for "the rail has never heard of this
        // id" — a transport failure throws, and is handled above. So this is a
        // forged or stale id from a sender holding a valid key.
        await this.finish(eventId, 'ignored', 'Unknown to the provider');
        this.logger.error(
          `[alert] payments.webhook_unknown_payment provider=${providerKey} payment=${envelope.providerPaymentId}`,
        );
        return { received: true, handled: false, reason: 'unknown-payment' };
      }

      const outcome = await this.applyService.apply({ provider: providerKey, payment: fetched });
      await this.finish(eventId, 'processed');
      return { received: true, handled: outcome.applied, reason: outcome.reason };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      // Anything else is genuinely unexpected — a Mongo outage, a bug. The
      // event is marked failed so `payment-reconcile` surfaces it, and the
      // exception propagates as a 500 because a retry might actually work.
      await this.finish(eventId, 'failed', err instanceof Error ? err.message : String(err)).catch(
        () => undefined,
      );
      throw err;
    }
  }

  private async finish(eventId: unknown, status: 'processed' | 'ignored' | 'failed', lastError?: string) {
    await this.events
      .updateOne(
        { _id: eventId },
        {
          $set: {
            status,
            processedAt: new Date(),
            ...(lastError ? { lastError: lastError.slice(0, 500) } : {}),
          },
        },
      )
      .exec();
  }

  /**
   * A replay is normal and silent. The SAME event id carrying a DIFFERENT body
   * is not: it means either the rail mutated a payload under an id it had
   * already used, or somebody with the shared key is replaying an event id with
   * a payload of their own. Nothing is granted either way — the re-fetch is
   * what decides — but it is exactly the signal worth having, which is why
   * `WebhookEvent.payloadHash` exists at all.
   */
  private async notePossibleMutation(
    provider: string,
    providerEventId: string,
    payloadHash: string,
  ): Promise<void> {
    const existing = await this.events.findOne({ provider, providerEventId }).lean().exec();
    if (existing && existing.payloadHash !== payloadHash) {
      this.logger.error(
        `[alert] payments.webhook_payload_mutated provider=${provider} event=${providerEventId} ` +
          '— same event id, different body; nothing was granted',
      );
    }
    await this.events.updateOne({ provider, providerEventId }, { $inc: { attempts: 1 } }).exec();
  }
}
