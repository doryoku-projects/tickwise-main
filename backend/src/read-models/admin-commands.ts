import { randomBytes } from 'node:crypto';
import type { RmKeys } from './keys.js';
import type { StateTransport } from './transport.js';

/**
 * Admin → lease-holder commands (design §14), carried by redis-state so any
 * replica can take the admin request: the route LPUSHes a command, the holder
 * RPOPs one per second and records the outcome in `…:cmd:last`.
 *
 *  - `rescan {model, shard?}` — one shard: an in-epoch shard scan; no shard: a
 *    new epoch with a full cold scan;
 *  - `scan {action: pause | resume | pace, docsPerSec?, target?}` — the
 *    feeder's running scan (`target: feeder`, the default) or lane B's
 *    verification scan (`target: verify`), ≤ 5k/s each, never both at once;
 *  - `snapshot` — write a snapshot now;
 *  - `sweep` — run the redis-models janitor (the route also runs it directly).
 * Commands expire after 10 min unread (no holder).
 */

export type AdminCommand =
  | { type: 'rescan'; model: 'rank' | 'pools'; shard?: string }
  | { type: 'scan'; action: 'pause' | 'resume' | 'pace'; docsPerSec?: number; target?: 'feeder' | 'verify' }
  | { type: 'snapshot' }
  | { type: 'sweep' };

const COMMAND_TTL_MS = 10 * 60_000;

export class AdminCommands {
  constructor(
    private readonly transport: StateTransport,
    private readonly keys: RmKeys,
  ) {}

  /** Queue a command; returns its id. */
  async push(command: AdminCommand, by: string): Promise<string> {
    const id = randomBytes(6).toString('hex');
    await this.transport.push(this.keys.commands, JSON.stringify({ ...command, id, by, at: new Date().toISOString() }), COMMAND_TTL_MS);
    return id;
  }

  /** The holder's poll. */
  pop(): Promise<string | null> {
    return this.transport.pop(this.keys.commands);
  }

  async recordDone(record: Record<string, unknown>): Promise<void> {
    await this.transport.set(this.keys.lastCommand, JSON.stringify(record), 24 * 3_600_000);
  }

  async last(): Promise<Record<string, unknown> | null> {
    const raw = await this.transport.get(this.keys.lastCommand);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
