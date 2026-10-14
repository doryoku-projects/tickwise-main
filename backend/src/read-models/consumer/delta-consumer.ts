import type { DeltaEntry } from '../feeder/delta-codec.js';
import { ModelDivergedError, type ModelStore, type StreamPosition } from '../core/model-store.js';
import type { Manifest } from '../feeder/snapshot-store.js';
import type { ModelsTransport } from '../transport.js';

/** Entries applied between event-loop turns during a catch-up. */
export const APPLY_YIELD_EVERY = 100;

/**
 * A replica that does not hold the feeder lease follows the delta stream
 * (design §2.5, §3.6):
 *
 *  - Boot: load the newest manifest's snapshot, then `XREAD` from its
 *    `streamId` (exclusive). No manifest yet → NOT READY, poll.
 *  - Order is (fence, epoch, s). Within the current (fence, epoch) an entry is
 *    applied only when `s == last + 1`; `s <= last` is a duplicate (skipped);
 *    a gap is NOT READY → reload from the latest manifest.
 *  - A higher fence at `s == last + 1` in the same epoch is a takeover:
 *    accepted, and the fence floor rises. An entry (or manifest) below the
 *    floor is ignored — a paused ex-holder's.
 *  - A NEW epoch is accepted only through its manifest: when the manifest
 *    `continues` exactly this replica's position the switch is seamless (no
 *    reload); otherwise reload from that manifest.
 *  - `…:inc` is polled with the manifest every second: a change means
 *    redis-models was lost — wait for the new incarnation's manifest
 *    (continuation or reload).
 */

export type EntryVerdict =
  | { verdict: 'apply'; takeover: boolean }
  | { verdict: 'skip'; reason: 'below_floor' | 'older_epoch' | 'duplicate' }
  | { verdict: 'gap'; expected: number }
  | { verdict: 'new_epoch' };

/** The ordering rule for one entry against the replica's position and fence floor. */
export function judgeEntry(pos: StreamPosition, floor: number, entry: Pick<DeltaEntry, 'f' | 'e' | 's'>): EntryVerdict {
  if (entry.f < floor) return { verdict: 'skip', reason: 'below_floor' };
  if (entry.e < pos.epoch) return { verdict: 'skip', reason: 'older_epoch' };
  if (entry.e > pos.epoch) return { verdict: 'new_epoch' };
  if (entry.s <= pos.s) return { verdict: 'skip', reason: 'duplicate' };
  if (entry.s !== pos.s + 1) return { verdict: 'gap', expected: pos.s + 1 };
  return { verdict: 'apply', takeover: entry.f > pos.fence };
}

/** Does `manifest` continue exactly the position `pos` (a seamless epoch switch)? */
export function continuesFrom(manifest: Pick<Manifest, 'continues'>, pos: StreamPosition): boolean {
  const c = manifest.continues;
  return Boolean(c && c.fence === pos.fence && c.epoch === pos.epoch && c.s === pos.s);
}

export interface ConsumerDeps {
  store: ModelStore;
  transport: ModelsTransport;
  /** Load a manifest's snapshot into the store (replacing its tables and position). */
  load: (manifest: Manifest) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  alert?: (name: string, detail: string) => void;
  /** XREAD block (ms). */
  blockMs?: number;
  /** Manifest / incarnation poll (ms). */
  pollMs?: number;
}

/** Entries per read. */
const READ_COUNT = 1_000;

export type ConsumerPhase = 'idle' | 'waiting_manifest' | 'loading' | 'following' | 'reloading' | 'stopped';

export class DeltaConsumer {
  phase: ConsumerPhase = 'idle';
  /** Fence floor: entries / manifests below it are ignored. */
  floor = 0;
  /** Last time a read reached the stream's tail (it returned fewer entries than asked for), ms. */
  lastDrainedAt = 0;
  /** Last time a heartbeat entry was applied (ms). */
  lastHeartbeatAt = 0;
  /** Last time any entry was applied (ms). */
  lastAppliedAt = 0;
  applied = 0;
  skipped = 0;
  reloads = 0;
  lastReloadReason?: string;
  private stopped = false;
  private reloadWanted?: string;
  private lastPollAt = 0;
  private loopDone?: Promise<void>;
  private loopRunning = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ConsumerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Is the follow loop running? */
  get running(): boolean {
    return this.loopRunning;
  }

  /** Start following (in the background). `loaded` = the store already holds a model at its position. No-op when already running. */
  start(loaded: boolean): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.stopped = false;
    if (!loaded) this.reloadWanted = 'boot';
    this.loopDone = this.loop()
      .catch((err) => {
        this.deps.alert?.('read_models.consumer_failed', (err as Error)?.message ?? String(err));
      })
      .finally(() => {
        this.loopRunning = false;
      });
  }

  /** Stop following; resolves when the loop has stopped (the store stays as it is). */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loopDone;
    this.phase = 'stopped';
  }

  /** Ask for a reload from the newest manifest (a model turned on, a divergence). */
  requestReload(reason: string): void {
    this.reloadWanted = reason;
  }

  /**
   * Is this replica caught up (§6.7)? It read up to the stream's tail within
   * the last 2 s, and the holder is alive: an entry arrived within the last
   * 3 s (the holder appends a batch or, idle, a heartbeat at least every
   * second; data freshness itself is the entries' `ca`, checked as lag).
   */
  caughtUp(now = this.now()): boolean {
    return this.phase === 'following' && now - this.lastDrainedAt <= 2_000 && now - this.lastAppliedAt <= 3_000;
  }

  private async loop(): Promise<void> {
    const blockMs = this.deps.blockMs ?? 1_000;
    while (!this.stopped) {
      try {
        if (this.reloadWanted !== undefined) {
          const reason = this.reloadWanted;
          this.reloadWanted = undefined;
          const ok = await this.reload(reason);
          if (!ok) {
            this.reloadWanted = reason;
            await this.sleep(1_000);
            continue;
          }
        }
        if (this.now() - this.lastPollAt >= (this.deps.pollMs ?? 1_000)) {
          this.lastPollAt = this.now();
          await this.poll();
          if (this.reloadWanted !== undefined) continue;
        }
        this.phase = 'following';
        const entries = await this.deps.transport.read(this.deps.store.pos.id, READ_COUNT, blockMs);
        if (this.stopped) return;
        if (entries.length === 0) {
          this.lastDrainedAt = this.now();
          continue;
        }
        const complete = await this.applyAll(entries);
        if (complete && entries.length < READ_COUNT) this.lastDrainedAt = this.now();
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof ModelDivergedError) {
          this.deps.alert?.('read_models.consumer_diverged', err.message);
          this.reloadWanted = 'diverged';
          continue;
        }
        this.deps.alert?.('read_models.consumer_retry', (err as Error)?.message ?? String(err));
        await this.sleep(1_000);
      }
    }
  }

  /**
   * Apply a run of entries in order. Returns false when it stopped at a gap or
   * a new epoch that needs a reload (requested). A catch-up read is up to
   * 1,000 entries: the event loop gets a turn every `APPLY_YIELD_EVERY` of
   * them (a replica answering HTTP must not stall on one XREAD).
   */
  async applyAll(entries: readonly DeltaEntry[]): Promise<boolean> {
    let seen = 0;
    for (const entry of entries) {
      if (++seen % APPLY_YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const pos = this.deps.store.tailPosition;
      const verdict = judgeEntry(pos, this.floor, entry);
      switch (verdict.verdict) {
        case 'skip':
          this.skipped++;
          // Even a skipped entry moves the read cursor past it (it is never wanted).
          this.deps.store.pos = { ...this.deps.store.pos, id: entry.id ?? this.deps.store.pos.id };
          continue;
        case 'gap':
          this.requestReload(`gap: s=${entry.s} expected ${verdict.expected} (epoch ${entry.e})`);
          return false;
        case 'new_epoch': {
          const manifest = await this.deps.transport.manifest();
          if (manifest && manifest.epoch === entry.e && manifest.fence >= this.floor && continuesFrom(manifest, pos)) {
            // Seamless switch: same contents, the epoch restarts its sequence.
            this.deps.store.pos = { ...this.deps.store.pos, epoch: manifest.epoch, s: 0, fence: manifest.fence, inc: manifest.inc };
            this.floor = Math.max(this.floor, manifest.fence);
            const again = judgeEntry(this.deps.store.tailPosition, this.floor, entry);
            if (again.verdict !== 'apply') {
              this.requestReload(`new epoch ${entry.e}: first entry s=${entry.s}`);
              return false;
            }
            this.applyOne(entry);
            continue;
          }
          this.requestReload(`new epoch ${entry.e} not continuing epoch ${pos.epoch} s=${pos.s}`);
          return false;
        }
        case 'apply':
          if (verdict.takeover) this.floor = Math.max(this.floor, entry.f);
          this.applyOne(entry);
          continue;
      }
    }
    return true;
  }

  private applyOne(entry: DeltaEntry): void {
    this.deps.store.applyEntry(entry);
    this.floor = Math.max(this.floor, entry.f);
    this.applied++;
    this.lastAppliedAt = this.now();
    if (entry.k === 'heartbeat') this.lastHeartbeatAt = this.now();
  }

  /** Incarnation / manifest checks (every second). */
  private async poll(): Promise<void> {
    const pos = this.deps.store.pos;
    const inc = await this.deps.transport.incarnation();
    if (pos.inc && inc !== pos.inc) {
      // redis-models was lost: wait for the new incarnation's manifest.
      const manifest = await this.deps.transport.manifest();
      if (!manifest || manifest.inc !== inc) return;
      if (manifest.fence < this.floor) return;
      if (continuesFrom(manifest, pos)) {
        this.deps.store.pos = { ...pos, epoch: manifest.epoch, s: 0, fence: manifest.fence, inc: manifest.inc, id: manifest.streamId };
        this.floor = Math.max(this.floor, manifest.fence);
        this.deps.log?.(`redis-models incarnation changed: continuing in epoch ${manifest.epoch} without a reload`);
        return;
      }
      this.requestReload(`redis-models incarnation changed (${pos.inc} → ${inc})`);
    }
  }

  /** Load the newest manifest; false when there is none (yet) or it is below the floor. */
  private async reload(reason: string): Promise<boolean> {
    this.phase = this.deps.store.pos.s > 0 || this.deps.store.tables.size > 0 ? 'reloading' : 'waiting_manifest';
    const manifest = await this.deps.transport.manifest();
    if (!manifest) {
      this.phase = 'waiting_manifest';
      return false;
    }
    if (manifest.fence < this.floor) return false;
    this.phase = 'loading';
    this.lastReloadReason = reason;
    await this.deps.load(manifest);
    this.floor = Math.max(this.floor, manifest.fence);
    this.reloads++;
    this.deps.log?.(`loaded snapshot fence=${manifest.fence} epoch=${manifest.epoch} s=${manifest.s} (${reason})`);
    this.phase = 'following';
    return true;
  }
}
