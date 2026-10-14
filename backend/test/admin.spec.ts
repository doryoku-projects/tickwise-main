import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminController } from '../src/admin/admin.controller.js';

// Constructor order after the tx-sync removal:
//   (config, queues, syncRepo)
// The transaction-run / reset-stuck / reprice-stored routes were deleted —
// transaction sync now rides entirely on the position refresh tick.

const ADMIN_SECRET = 'test-admin-secret';

/**
 * These routes are gated by the header, not by a JWT, so every call must present it.
 *
 * `adminSecret` is a required positional rather than a defaulted one: an explicit
 * `undefined` would otherwise fall back to the default and quietly configure the
 * secret in the very test asserting the unconfigured case.
 */
function makeController(adminSecret: string | undefined) {
  return new AdminController(
    { adminSecret } as never,
    {} as never,
    {} as never,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The gate itself. These routes carry no @UseGuards — `assertAdmin` IS the
// authorization — and it used to `return` when ADMIN_SECRET was unset, leaving
// `POST /admin/sync/run {"all":true,"fromStart":true}` (cursor reset + full
// rescan of every enabled chain) reachable with no credential. The Dockerfile
// sets NODE_ENV=production and no ADMIN_SECRET, so that was the shipped default.
// ─────────────────────────────────────────────────────────────────────────────
describe('AdminController admin-secret gate', () => {
  it('refuses every call when ADMIN_SECRET is unconfigured, rather than failing open', async () => {
    const controller = makeController(undefined);

    await expect(controller.syncStatus(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an unconfigured secret even when the caller supplies one', async () => {
    const controller = makeController('');

    await expect(controller.syncStatus('anything')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong secret with 403', async () => {
    const controller = makeController(ADMIN_SECRET);

    await expect(controller.syncStatus('not-the-secret')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a missing secret with 403 when one IS configured', async () => {
    const controller = makeController(ADMIN_SECRET);

    await expect(controller.syncStatus(undefined)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AdminController recompute-aggregates (the admin aggregate healer, 2026-10-03)', () => {
  // `adminSecret` positional and required: a default would turn an explicit
  // `undefined` back into a configured secret (see `makeController`).
  function controller(queues: Record<string, unknown>, adminSecret: string | undefined) {
    return new AdminController({ adminSecret } as never, queues as never, {} as never);
  }

  it('queues the healer for one integration', async () => {
    const enqueueRecomputeAggregates = vi.fn(async () => 'job-1');
    const result = await controller({ enqueueRecomputeAggregates }, ADMIN_SECRET).recomputeAggregates(ADMIN_SECRET, {
      chainId: 4663,
      protocol: 'uniswap-v4',
    });
    expect(enqueueRecomputeAggregates).toHaveBeenCalledWith(4663, 'uniswap-v4');
    expect(result).toEqual({ jobId: 'job-1', chainId: 4663, protocol: 'uniswap-v4' });
  });

  it('queues it for every integration with all=true', async () => {
    const enqueueRecomputeAggregatesAll = vi.fn(async () => [{ chainId: 1, protocol: 'uniswap-v4', jobId: 'a' }]);
    const result = await controller({ enqueueRecomputeAggregatesAll }, ADMIN_SECRET).recomputeAggregates(ADMIN_SECRET, { all: true });
    expect(result).toEqual({ jobs: [{ chainId: 1, protocol: 'uniswap-v4', jobId: 'a' }] });
  });

  it('is behind the admin secret, before any work', async () => {
    const enqueueRecomputeAggregates = vi.fn();
    await expect(
      controller({ enqueueRecomputeAggregates }, ADMIN_SECRET).recomputeAggregates('wrong', { chainId: 1, protocol: 'uniswap-v4' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller({ enqueueRecomputeAggregates }, undefined).recomputeAggregates(undefined, { all: true }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(enqueueRecomputeAggregates).not.toHaveBeenCalled();
  });

  it('needs a target unless all=true', async () => {
    const result = await controller({}, ADMIN_SECRET).recomputeAggregates(ADMIN_SECRET, {});
    expect(result).toEqual({ error: 'chainId and protocol are required unless all=true' });
  });
});
