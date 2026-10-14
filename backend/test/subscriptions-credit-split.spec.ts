import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { SubscriptionsService } from '../src/payments/subscriptions.service.js';

/**
 * `creditAppliedMinor` is the SUM of two sources; only one of them may ever go
 * back to the balance. This file pins the WRITER half of that split.
 *
 * WHY IT EXISTS: the void-path spec in `subscriptions-cancel` seeds
 * `creditFromBalanceMinor` on its fixture, so deleting the field from
 * `spendCustomerCredit`'s `$inc` left the entire 908-test suite green — and the
 * consequence of that regression is the exact inverse of the money-printing bug
 * it was added to fix: every balance spend silently becomes unrefundable, so a
 * customer who cancels an upgrade loses credit that really was theirs. A
 * surviving mutation is the only cheap way to find out you tested the reader
 * and not the writer.
 */

const CUSTOMER = '507f1f77bcf86cd799439099';

function build(balanceMinor: number, amountDueMinor: number) {
  const invoiceUpdates: Array<Record<string, unknown>> = [];
  const customerUpdates: Array<Record<string, unknown>> = [];
  const exec = <T>(v: T) => ({ exec: async () => v });

  const customers = {
    findById: vi.fn(() => ({ lean: () => exec({ creditBalanceMinor: balanceMinor }) })),
    updateOne: vi.fn((_f: unknown, u: Record<string, unknown>) => {
      customerUpdates.push(u);
      return exec({ matchedCount: 1 });
    }),
  };
  const invoices = {
    updateOne: vi.fn((_f: unknown, u: Record<string, unknown>) => {
      invoiceUpdates.push(u);
      return exec({ matchedCount: 1 });
    }),
  };

  const service = new SubscriptionsService(
    {} as never, invoices as never, {} as never, customers as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  (service as unknown as { logger: { log: () => void } }).logger = { log: () => {} };

  const invoice = { _id: 'inv1', number: 5, amountDueMinor, creditAppliedMinor: 0, creditFromBalanceMinor: 0 };
  return { service, invoice, invoiceUpdates, customerUpdates };
}

async function spend(h: ReturnType<typeof build>) {
  await (
    h.service as unknown as {
      spendCustomerCredit: (c: string, i: unknown) => Promise<void>;
    }
  ).spendCustomerCredit(CUSTOMER, h.invoice);
}

describe('spendCustomerCredit records what came from the balance', () => {
  it('increments creditFromBalanceMinor alongside creditAppliedMinor', async () => {
    const h = build(99, 200);

    await spend(h);

    // Both, by the same amount. `creditAppliedMinor` is what the invoice shows
    // the customer; `creditFromBalanceMinor` is what the void path may return.
    expect(h.invoiceUpdates).toHaveLength(1);
    expect(h.invoiceUpdates[0]).toEqual({
      $inc: { creditAppliedMinor: 99, creditFromBalanceMinor: 99, amountDueMinor: -99 },
    });
    expect(h.customerUpdates[0]).toEqual({ $inc: { creditBalanceMinor: -99 } });
  });

  it('records only what it actually spent when the balance exceeds the amount due', async () => {
    // Balance $5, invoice $1 — the refundable part is the $1 taken, not the $5 held.
    const h = build(500, 100);

    await spend(h);

    expect(h.invoiceUpdates[0]).toEqual({
      $inc: { creditAppliedMinor: 100, creditFromBalanceMinor: 100, amountDueMinor: -100 },
    });
  });

  it('keeps the in-memory invoice consistent with the write', async () => {
    // `raiseInvoice` returns this object to callers that read the fields back,
    // so a write the local copy does not mirror is a silent divergence.
    const h = build(99, 200);

    await spend(h);

    expect(h.invoice.creditAppliedMinor).toBe(99);
    expect(h.invoice.creditFromBalanceMinor).toBe(99);
  });

  it('writes nothing when there is no balance to spend', async () => {
    const h = build(0, 200);

    await spend(h);

    expect(h.invoiceUpdates).toHaveLength(0);
    expect(h.customerUpdates).toHaveLength(0);
  });
});
