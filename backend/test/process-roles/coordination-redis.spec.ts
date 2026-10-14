import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A stand-in ioredis client: `connect()` moves `wait` → `connecting`, and the
 * spec decides when the connection becomes `ready` (or fails).
 */
const made = vi.hoisted(() => ({ clients: [] as Array<EventEmitter & { status: string; connect: () => Promise<void> }> }));

vi.mock('ioredis', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeRedis extends Emitter {
    status = 'wait';
    connect = vi.fn(async () => {
      this.status = 'connecting';
      await new Promise<void>((resolve, reject) => {
        this.once('ready', () => resolve());
        this.once('fail', (err: Error) => reject(err));
      });
    });
    quit = vi.fn(async () => {
      this.status = 'end';
    });
    constructor() {
      super();
      made.clients.push(this as never);
    }
  }
  return { Redis: FakeRedis };
});

import { CoordinationRedis, SharedControlClient } from '../../src/common/coordination-redis.js';

afterEach(() => {
  made.clients.length = 0;
});

const quiet = { warn: () => undefined };

function becomeReady(index = 0) {
  const c = made.clients[index]!;
  c.status = 'ready';
  c.emit('ready');
}

describe('CoordinationRedis.client() — callers during the first connect (review fix)', () => {
  it('five concurrent callers during the connect ALL get the client (not just the first)', async () => {
    const coordination = new CoordinationRedis(undefined);
    const pending = Array.from({ length: 5 }, () => coordination.client());
    await new Promise((r) => setImmediate(r));
    expect(made.clients).toHaveLength(1);
    expect(made.clients[0]!.status).toBe('connecting');
    becomeReady();
    const got = await Promise.all(pending);
    expect(got.every((c) => c === made.clients[0])).toBe(true);
    expect(made.clients[0]!.connect).toHaveBeenCalledTimes(1);
  });

  it('a caller that arrives while connecting waits at most the bound, then answers unavailable', async () => {
    const client = new SharedControlClient(() => 'redis://x', {}, 'spec', quiet, 30);
    const first = client.get();
    const t0 = Date.now();
    const second = await client.get();
    expect(second).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    made.clients[0]!.emit('fail', new Error('refused'));
    expect(await first).toBeUndefined();
  });

  it('a failed connect answers unavailable at once for every waiter (close), never throws', async () => {
    const client = new SharedControlClient(() => 'redis://x', {}, 'spec', quiet, 5_000);
    const pending = [client.get(), client.get()];
    await new Promise((r) => setImmediate(r));
    const c = made.clients[0]!;
    c.status = 'reconnecting';
    c.emit('fail', new Error('ECONNREFUSED'));
    c.emit('close');
    const t0 = Date.now();
    expect(await Promise.all(pending)).toEqual([undefined, undefined]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('reconnecting / end answer unavailable without waiting', async () => {
    const client = new SharedControlClient(() => 'redis://x', {}, 'spec', quiet, 5_000);
    const first = client.get();
    await new Promise((r) => setImmediate(r));
    becomeReady();
    expect(await first).toBe(made.clients[0]);
    made.clients[0]!.status = 'reconnecting';
    const t0 = Date.now();
    expect(await client.get()).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
