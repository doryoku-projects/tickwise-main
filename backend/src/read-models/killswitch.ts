import type { ReadModelName } from './core/fields.js';
import { lowerMode, parseKillSwitch, type KillSwitchState, type ReadModelMode } from './flags.js';
import type { RmKeys } from './keys.js';
import type { StateTransport } from './transport.js';

/**
 * The runtime kill switch (design §2.2): `POST /admin/read-models/override
 * {model, mode}` writes `…:killswitch` on redis-state (AOF, no TTL); every
 * process reads it every 5 s AND before loading any model. It can only LOWER
 * a model's mode below the env's (`effectiveModes`); `serve` therefore clears
 * an override. `off` stops the feeder for that model, unloads it and frees its
 * buffers — which breaks an OOM restart loop without a redeploy.
 *
 * A process that cannot read redis-state keeps its last reading (fail-static):
 * a Redis blip must not flip every replica's models on or off at once.
 */
export class KillSwitch {
  private state: KillSwitchState = {};
  private lastReadAt = 0;

  constructor(
    private readonly transport: StateTransport,
    private readonly keys: RmKeys,
  ) {}

  /** Read it now (the "before any load" read); the last good reading when redis-state is unavailable. */
  async read(now = Date.now()): Promise<KillSwitchState> {
    try {
      this.state = parseKillSwitch(await this.transport.get(this.keys.killswitch));
      this.lastReadAt = now;
    } catch {
      // keep the last reading
    }
    return this.state;
  }

  current(): KillSwitchState {
    return this.state;
  }

  get readAt(): number {
    return this.lastReadAt;
  }

  /** Set one model's override; returns the stored state. */
  async write(model: ReadModelName, mode: ReadModelMode, by: string, now = Date.now()): Promise<KillSwitchState> {
    const current = parseKillSwitch(await this.transport.get(this.keys.killswitch));
    const next: KillSwitchState = { ...current, [model]: mode, at: now, by };
    // `serve` lowers nothing: store it as "no override" so the switch reads cleanly.
    if (mode === 'serve') delete next[model];
    await this.transport.set(this.keys.killswitch, JSON.stringify(next));
    this.state = next;
    return next;
  }
}

/** Would `mode` lower `configured`? (`serve` never does; the same mode does not.) */
export function lowers(configured: ReadModelMode, mode: ReadModelMode): boolean {
  return lowerMode(configured, mode) !== configured;
}
