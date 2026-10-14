import type { ReadModelName } from './core/fields.js';
import type { RmKeys } from './keys.js';
import type { StateTransport } from './transport.js';

/**
 * Fleet readiness (design §7.2): each serving replica writes `{ready per
 * model}` to redis-state every 5 s with a 15 s TTL; the circuit of a model is
 * OPEN when ≥ 50% of the live replicas report it not ready, or when no feeder
 * holder has appended for > 60 s. R1 publishes and reports it
 * (`/admin/sync/status` → `readModels.fleet`); the router (R4) acts on it.
 */

export interface FleetBeat {
  replica: string;
  role: string;
  holder: boolean;
  ready: Partial<Record<ReadModelName, boolean>>;
  /** Wall time of the last append this replica saw (holder: made; consumer: applied). */
  lastAppendAt: number;
  at: number;
}

export const FLEET_TTL_MS = 15_000;
export const FLEET_EVERY_MS = 5_000;
const HOLDER_SILENT_MS = 60_000;

/**
 * The heartbeats live in ONE hash per deployment (field = replica): a beat is
 * an `HSET` (the hash's TTL refreshed), the circuit ONE `HGETALL` — never a
 * SCAN of redis-state (`REDIS_URL`, shared with BullMQ). A field older than
 * `FLEET_TTL_MS` is a dead replica: dropped from the answer and `HDEL`ed.
 */
export class Fleet {
  constructor(
    private readonly transport: StateTransport,
    private readonly keys: RmKeys,
    private readonly now: () => number = Date.now,
  ) {}

  async beat(beat: FleetBeat): Promise<void> {
    await this.transport.hset(this.keys.fleet, beat.replica, JSON.stringify(beat), FLEET_TTL_MS * 4);
  }

  async members(): Promise<FleetBeat[]> {
    const rows = await this.transport.hgetall(this.keys.fleet);
    const now = this.now();
    const out: FleetBeat[] = [];
    const stale: string[] = [];
    for (const [replica, value] of Object.entries(rows)) {
      try {
        const beat = JSON.parse(value) as FleetBeat;
        if (!(typeof beat.at === 'number' && now - beat.at <= FLEET_TTL_MS)) stale.push(replica);
        else out.push(beat);
      } catch {
        stale.push(replica); // a garbled heartbeat
      }
    }
    if (stale.length > 0) await this.transport.hdel(this.keys.fleet, stale).catch(() => undefined);
    return out;
  }
}

/** The circuit per model from the live heartbeats. */
export function fleetCircuit(beats: readonly FleetBeat[], models: readonly ReadModelName[], now = Date.now()): Record<string, { open: boolean; notReady: number; live: number; reason?: string }> {
  const lastAppend = Math.max(0, ...beats.map((b) => b.lastAppendAt || 0));
  const silent = beats.length > 0 && now - lastAppend > HOLDER_SILENT_MS;
  const out: Record<string, { open: boolean; notReady: number; live: number; reason?: string }> = {};
  for (const model of models) {
    const reporting = beats.filter((b) => b.ready[model] !== undefined);
    const notReady = reporting.filter((b) => b.ready[model] === false).length;
    const half = reporting.length > 0 && notReady * 2 >= reporting.length;
    out[model] = {
      open: half || silent,
      notReady,
      live: reporting.length,
      ...(half ? { reason: `${notReady}/${reporting.length} replicas not ready` } : silent ? { reason: 'no append for > 60 s' } : {}),
    };
  }
  return out;
}
