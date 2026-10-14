import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AuthorizationWatcherService,
  findPairedTransfer,
} from '../src/payments/providers/x402/authorization-watcher.service.js';
import { TreasurySubmitterService } from '../src/payments/providers/x402/treasury-submitter.service.js';
import {
  AUTHORIZATION_USED_TOPIC,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
} from '../src/payments/providers/x402/eip3009.js';
import { TRANSFER_TOPIC, addressToTopic } from '../src/payments/providers/x402/evm-rpc.client.js';
import type { AppConfigService } from '../src/config/app-config.service.js';
import type { PaymentApplyService } from '../src/payments/payment-apply.service.js';

/**
 * SETTLEMENT — the one rule standing between this rail and a free-money bug.
 *
 * An `AuthorizationUsed(authorizer, nonce)` event is NOT proof of payment. The
 * token stores `authorizationState[authorizer][nonce]`, so a nonce is unique only
 * PER AUTHORIZER: a customer can spend the SAME nonce value from a second wallet
 * they control, and two different events can carry one nonce. Settling on the
 * event alone would let somebody satisfy their invoice with a transfer that went
 * somewhere else entirely, or for a fraction of the amount.
 *
 * So the watcher requires, in the SAME transaction, a `Transfer` of the expected
 * amount, of the right token, from the authorizer, to the treasury the
 * authorization was signed for. `findPairedTransfer` is that check, kept pure and
 * exported so it can be attacked here without a chain.
 */

const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TREASURY = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const ATTACKER = '0x000000000000000000000000000000000000dead';
const PAYER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const EXPECTED = 19_000_000n; // 19 USDC

/** An ERC-20 `Transfer` log as `eth_getTransactionReceipt` returns it. */
function transferLog(args: {
  token?: string;
  from: string;
  to: string;
  value: bigint;
  logIndex?: number;
}) {
  return {
    address: args.token ?? TOKEN,
    topics: [TRANSFER_TOPIC, addressToTopic(args.from), addressToTopic(args.to)],
    data: `0x${args.value.toString(16).padStart(64, '0')}`,
    blockNumber: '0x64',
    transactionHash: '0xtx',
    logIndex: `0x${(args.logIndex ?? 0).toString(16)}`,
  };
}

describe('findPairedTransfer — the settle gate', () => {
  const want = { tokenAddress: TOKEN, from: PAYER, to: TREASURY, minValue: EXPECTED };

  it('accepts the exact expected transfer', () => {
    const found = findPairedTransfer([transferLog({ from: PAYER, to: TREASURY, value: EXPECTED })], want);
    expect(found?.value).toBe(EXPECTED);
  });

  it('accepts an OVERPAYMENT — the fold credits the excess', () => {
    const found = findPairedTransfer(
      [transferLog({ from: PAYER, to: TREASURY, value: EXPECTED + 1_000_000n })],
      want,
    );
    expect(found?.value).toBe(20_000_000n);
  });

  it('REFUSES a transfer to somebody else — the per-authorizer nonce trap', () => {
    // The attack this exists for: an `AuthorizationUsed` carrying OUR nonce, but
    // the money went to the attacker's own address. Settling on the event alone
    // would have granted a plan for a payment we never received.
    expect(
      findPairedTransfer([transferLog({ from: PAYER, to: ATTACKER, value: EXPECTED })], want),
    ).toBeUndefined();
  });

  it('REFUSES a transfer from a different wallet than the authorizer', () => {
    expect(
      findPairedTransfer([transferLog({ from: ATTACKER, to: TREASURY, value: EXPECTED })], want),
    ).toBeUndefined();
  });

  it('REFUSES an UNDERPAYMENT rather than treating it as exact', () => {
    expect(
      findPairedTransfer([transferLog({ from: PAYER, to: TREASURY, value: EXPECTED - 1n })], want),
    ).toBeUndefined();
  });

  it('REFUSES A SELF-TRANSFER — the treasury paying itself moves nothing', () => {
    // `from === to` leaves the treasury's balance exactly as it was, but emits a
    // `Transfer` that satisfies every other check here — so without this guard the
    // invoice settles and NOTHING has been paid. Reachable only with the
    // treasury's own key (an operator connecting the wrong account while testing),
    // which is why it is caught at BOTH layers: refused at issue time, and refused
    // again here, on the side that actually grants entitlement.
    expect(
      findPairedTransfer([transferLog({ from: TREASURY, to: TREASURY, value: EXPECTED })], {
        tokenAddress: TOKEN,
        from: TREASURY,
        to: TREASURY,
        minValue: EXPECTED,
      }),
    ).toBeUndefined();
  });

  it('REFUSES a transfer of a DIFFERENT TOKEN to the treasury', () => {
    // Sending a worthless token that happens to have a `Transfer` event must not
    // settle a USDC invoice.
    const fake = '0x1111111111111111111111111111111111111111';
    expect(
      findPairedTransfer([transferLog({ token: fake, from: PAYER, to: TREASURY, value: EXPECTED })], want),
    ).toBeUndefined();
  });

  it('finds the RIGHT transfer among several in one transaction', () => {
    const found = findPairedTransfer(
      [
        transferLog({ from: PAYER, to: ATTACKER, value: EXPECTED, logIndex: 0 }),
        transferLog({ from: ATTACKER, to: TREASURY, value: EXPECTED, logIndex: 1 }),
        transferLog({ from: PAYER, to: TREASURY, value: EXPECTED, logIndex: 2 }),
      ],
      want,
    );
    expect(found?.value).toBe(EXPECTED);
  });

  it('ignores a non-Transfer log with the right addresses', () => {
    const notTransfer = {
      ...transferLog({ from: PAYER, to: TREASURY, value: EXPECTED }),
      topics: [AUTHORIZATION_USED_TOPIC, addressToTopic(PAYER), addressToTopic(TREASURY)],
    };
    expect(findPairedTransfer([notTransfer], want)).toBeUndefined();
  });
});

// ─── the watcher, end to end over scripted RPC ─────────────────────────────

function buildWatcher(opts: {
  rows: Array<Record<string, unknown>>;
  receiptLogs: ReturnType<typeof transferLog>[];
  receiptStatus?: string;
}) {
  const applied: Array<{ invoiceId: string; amountMinor?: number }> = [];
  const applyService = {
    apply: vi.fn(async (input: { invoiceId: string; payment: { amountMinor?: number } }) => {
      applied.push({ invoiceId: input.invoiceId, amountMinor: input.payment.amountMinor });
      return { applied: true, reason: 'applied' as const };
    }),
  } as unknown as PaymentApplyService;

  const config = {
    x402PaymentsConfigured: true,
    acceptedPaymentTokens: [{ chainId: 8453, symbol: 'USDC', address: TOKEN, decimals: 6, stable: true }],
    evmRpcUrls: new Map([[8453, 'http://rpc.test']]),
    minConfirmationsFor: () => 2,
    paymentWatchBlockRange: 2000,
  } as unknown as AppConfigService;

  const updates: Array<Record<string, unknown>> = [];
  // Filters are captured too. The watcher's watermark bug lived entirely in an
  // updateMany FILTER while its update document was correct, so a harness that
  // records only the update cannot see it — which is why this suite stayed green
  // through a defect that silently dropped real payments.
  const updateManyCalls: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  // Honours sort/limit rather than discarding them: the same defect was also
  // invisible because `limit: () => ...` ignored its argument, so every row the
  // test supplied came back regardless of the cap.
  const authorizations = {
    find: () => ({
      sort: () => ({
        limit: (n: number) => ({ lean: () => ({ exec: async () => opts.rows.slice(0, n) }) }),
      }),
    }),
    updateOne: (_f: unknown, u: Record<string, unknown>) => ({
      exec: async () => {
        updates.push(u);
        return { modifiedCount: 1 };
      },
    }),
    updateMany: (f: Record<string, unknown>, u: Record<string, unknown>) => ({
      exec: async () => {
        updates.push(u);
        updateManyCalls.push({ filter: f, update: u });
        return { modifiedCount: 1 };
      },
    }),
  };

  const watcher = new AuthorizationWatcherService(config, applyService, authorizations as never);
  const nonce = String(opts.rows[0]?.nonce ?? '');
  (watcher as unknown as { clientFor: () => unknown }).clientFor = () => ({
    async blockNumber() {
      return 1000n;
    },
    async logsByTopic() {
      return [
        {
          address: TOKEN,
          topics: [AUTHORIZATION_USED_TOPIC, addressToTopic(PAYER), nonce],
          data: '0x',
          blockNumber: '0x64',
          transactionHash: '0xtx',
          logIndex: '0x5',
        },
      ];
    },
    async getTransactionReceipt() {
      return {
        status: opts.receiptStatus ?? '0x1',
        blockNumber: '0x64',
        transactionHash: '0xtx',
        logs: opts.receiptLogs,
      };
    },
  });
  return { watcher, applied, updates, updateManyCalls, applyService };
}

const ROW = {
  _id: 'auth1',
  invoiceId: 'inv1',
  chainId: 8453,
  nonce: `0x${'11'.repeat(32)}`,
  tokenAddress: TOKEN,
  tokenSymbol: 'USDC',
  tokenDecimals: 6,
  treasuryAddress: TREASURY,
  expectedBaseUnits: EXPECTED.toString(),
  status: 'submitted',
  lastScannedBlock: 900,
  minConfirmations: 2,
};

describe('AuthorizationWatcherService.watchChain', () => {
  it('SETTLES when the paired transfer proves the money reached the treasury', async () => {
    const { watcher, applied, updates } = buildWatcher({
      rows: [ROW],
      receiptLogs: [transferLog({ from: PAYER, to: TREASURY, value: EXPECTED })],
    });

    const report = await watcher.watchChain(8453);

    expect(report.applied).toBe(1);
    // 19 USDC at 6 decimals → 1900 USD minor units.
    expect(applied[0]).toEqual({ invoiceId: 'inv1', amountMinor: 1900 });
    expect(updates.some((u) => (u.$set as Record<string, unknown>)?.status === 'settled')).toBe(true);
  });

  it('settles the AMOUNT THAT ACTUALLY MOVED, not the amount quoted', async () => {
    const { watcher, applied } = buildWatcher({
      rows: [ROW],
      receiptLogs: [transferLog({ from: PAYER, to: TREASURY, value: 25_000_000n })],
    });
    await watcher.watchChain(8453);
    // The fold turns the excess into account credit; inventing 1900 here would
    // silently discard $6 of a customer's money.
    expect(applied[0]?.amountMinor).toBe(2500);
  });

  it('does NOT settle when the transfer went somewhere else', async () => {
    const { watcher, applied } = buildWatcher({
      rows: [ROW],
      receiptLogs: [transferLog({ from: PAYER, to: ATTACKER, value: EXPECTED })],
    });

    const report = await watcher.watchChain(8453);

    expect(report.found).toBe(1); // the event was seen…
    expect(report.applied).toBe(0); // …and refused
    expect(applied).toHaveLength(0);
  });

  it('does NOT settle a REVERTED transaction', async () => {
    const { watcher, applied } = buildWatcher({
      rows: [ROW],
      receiptLogs: [transferLog({ from: PAYER, to: TREASURY, value: EXPECTED })],
      receiptStatus: '0x0',
    });
    await watcher.watchChain(8453);
    expect(applied).toHaveLength(0);
  });

  it('HOLDS the watermark when a settle fails — the payment must not be skipped', async () => {
    const { watcher, updates } = buildWatcher({
      rows: [ROW],
      receiptLogs: [transferLog({ from: PAYER, to: TREASURY, value: EXPECTED })],
    });
    (watcher as unknown as { applyService: { apply: () => Promise<never> } }).applyService = {
      apply: async () => {
        throw new Error('Mongo unreachable mid-apply');
      },
    };

    const report = await watcher.watchChain(8453);

    expect(report.errors).toBe(1);
    // Advancing past this block would lose the payment forever; a re-scan is
    // idempotent and costs one eth_getLogs.
    expect(updates.some((u) => (u.$set as Record<string, unknown>)?.lastScannedBlock !== undefined)).toBe(
      false,
    );
  });

  it('watches only chains with BOTH an accepted token and an RPC endpoint', () => {
    const { watcher } = buildWatcher({ rows: [], receiptLogs: [] });
    expect(watcher.watchedChainIds()).toEqual([8453]);
  });
});

// ─── the relay calldata ────────────────────────────────────────────────────

describe('TreasurySubmitterService.encodeRelayCalldata', () => {
  const submitter = new TreasurySubmitterService({
    x402SubmitterPrivateKey: undefined,
    evmRpcUrls: new Map(),
  } as unknown as AppConfigService);

  it('encodes the bytes-signature overload, matching an independent ABI encoding', () => {
    const signature = `0x${'ab'.repeat(65)}`;
    const calldata = submitter.encodeRelayCalldata({
      from: PAYER,
      to: TREASURY,
      valueBaseUnits: EXPECTED,
      validAfter: 0,
      validBefore: 1_800_000_000,
      nonce: `0x${'11'.repeat(32)}`,
      signature,
    });

    // Derived INDEPENDENTLY: the selector from keccak of the canonical signature,
    // the arguments from a separate encode. A wrong overload or a reordered
    // argument list makes the two disagree.
    const selector = keccak256(
      toHex('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'),
    ).slice(0, 10);
    const args = encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes' },
      ],
      [
        PAYER as Hex,
        TREASURY as Hex,
        EXPECTED,
        0n,
        1_800_000_000n,
        `0x${'11'.repeat(32)}` as Hex,
        signature as Hex,
      ],
    );

    expect(calldata).toBe(`${selector}${args.slice(2)}`);
    expect(calldata.startsWith(TRANSFER_WITH_AUTHORIZATION_SELECTOR)).toBe(true);
  });

  it('reports NOT ready with no key, so the customer-submits path is used', () => {
    submitter.onModuleInit();
    expect(submitter.isReady).toBe(false);
    expect(submitter.address).toBeUndefined();
  });

  it('derives the relayer address from a configured key', () => {
    const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const withKey = new TreasurySubmitterService({
      x402SubmitterPrivateKey: key,
      evmRpcUrls: new Map(),
    } as unknown as AppConfigService);
    withKey.onModuleInit();
    expect(withKey.isReady).toBe(true);
    expect(withKey.address).toBe(privateKeyToAccount(key).address);
  });
});

/**
 * The watermark must only advance for authorizations that were ACTUALLY in the
 * eth_getLogs topic filter. Advancing it for every pending row marked rows as
 * scanned that were never asked about, and `scanFloor` (a min over those marks)
 * then moved past the block their payment landed in — a silent, permanent loss.
 */
describe('watcher watermark is restricted to the rows it scanned', () => {
  it('advances lastScannedBlock ONLY for the authorizations in this tick', async () => {
    // One more row than the scan cap, so the last one is provably out of scope.
    const rows = Array.from({ length: 501 }, (_, i) => ({
      ...ROW,
      _id: `auth${i}`,
      invoiceId: `inv${i}`,
      nonce: `0x${i.toString(16).padStart(64, '0')}`,
    }));

    const { watcher, updateManyCalls } = buildWatcher({ rows, receiptLogs: [] });
    await watcher.watchChain(8453);

    // The tick also runs the retire sweep, which is its own updateMany — select
    // the watermark write by its update document rather than by position.
    const marks = updateManyCalls.filter(
      (c) => (c.update.$set as Record<string, unknown>)?.lastScannedBlock !== undefined,
    );
    expect(marks).toHaveLength(1);
    const filter = marks[0].filter as { _id?: { $in: string[] } };

    // The filter must name ids explicitly — not {chainId, status}, which would
    // sweep in the row this tick never looked at.
    expect(filter._id?.$in).toBeDefined();
    expect(filter).not.toHaveProperty('status');
    expect(filter._id!.$in).toHaveLength(500);

    // The 501st row was never scanned, so it must NOT be marked as scanned.
    expect(filter._id!.$in).not.toContain('auth500');
    // ...and the ones that were scanned must be.
    expect(filter._id!.$in).toContain('auth0');
  });

  it('marks every row when the pending set fits inside one tick', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...ROW,
      _id: `auth${i}`,
      invoiceId: `inv${i}`,
      nonce: `0x${i.toString(16).padStart(64, '0')}`,
    }));

    const { watcher, updateManyCalls } = buildWatcher({ rows, receiptLogs: [] });
    await watcher.watchChain(8453);

    const marks = updateManyCalls.filter(
      (c) => (c.update.$set as Record<string, unknown>)?.lastScannedBlock !== undefined,
    );
    const filter = marks[0].filter as { _id: { $in: string[] } };
    expect(filter._id.$in.sort()).toEqual(['auth0', 'auth1', 'auth2']);
  });
});

describe('retire sweep bounds the pending set', () => {
  it('never retires a submitted authorization — a transaction may be in flight', async () => {
    const { watcher, updateManyCalls } = buildWatcher({ rows: [ROW], receiptLogs: [] });
    await watcher.watchChain(8453);

    const retires = updateManyCalls.filter(
      (c) => (c.update.$set as Record<string, unknown>)?.status === 'expired',
    );
    expect(retires).toHaveLength(1);
    const or = (retires[0].filter as { $or: Array<Record<string, unknown>> }).$or;
    expect(or.map((c) => c.status).sort()).toEqual(['authorized', 'issued']);
    expect(or.map((c) => c.status)).not.toContain('submitted');
  });

  it('only retires quotes already dead for the grace period', async () => {
    const { watcher, updateManyCalls } = buildWatcher({ rows: [ROW], receiptLogs: [] });
    await watcher.watchChain(8453);

    const retire = updateManyCalls.find(
      (c) => (c.update.$set as Record<string, unknown>)?.status === 'expired',
    )!;
    const f = retire.filter as { quoteExpiresAt: { $lt: Date } };
    // Comfortably in the past — days, not seconds.
    expect(f.quoteExpiresAt.$lt.getTime()).toBeLessThan(Date.now() - 6 * 24 * 60 * 60 * 1000);
  });
});
