import type { ReadModelName } from './core/fields.js';
import type { FleetBeat } from './fleet.js';
import { fleetCircuit } from './fleet.js';
import type { ReadModelMode } from './flags.js';
import type { AlertLog } from './status.js';

/**
 * Degraded mode and the fleet circuit (design §7.2, P-R R4).
 *
 * Per request the engines (`PoolCatalogService.route`, `RankEngineService
 * .route`) decide engine vs Mongo; every refusal carries a reason and goes to
 * today's Mongo path. This module adds what sits ABOVE a single request:
 *
 *  - **Model-level degraded state** (`DegradedTracker`): a model configured
 *    `serve` that cannot serve on this replica — not ready (§6.7), a shard not
 *    ready, the kill switch below the env's mode, shed by the memory guard.
 *    Logged as `[alert] read_models.degraded model=… reason=…` once per
 *    transition (ready → degraded, or a new reason), and a plain log line on
 *    recovery. The FIRST load after boot is not a transition: a replica that
 *    is still loading only alerts once `READ_MODELS_READY_TIMEOUT_MS` has
 *    passed without the model becoming ready (a deploy is not an incident).
 *  - **Per-request reasons** split into `degraded.<reason>` (model / shard
 *    state, engine errors), `unsupported.<reason>` (the compiler refused the
 *    query, a quarantined field) and `policy.<reason>` (not meant for the
 *    engine: mode, serve percent) — `classifyFallback`.
 *  - **The fleet circuit** (`CircuitWatcher`, over `fleet.ts`'s heartbeats):
 *    open for a model when ≥ 50% of the live replicas report it not ready, or
 *    no holder appended for > 60 s. `[alert] read_models.fleet_degraded` once
 *    per opening, a log line on closing.
 *  - **The route under degradation** (`degradedRoute`): `p1` (default) =
 *    today's P1 Mongo path, unchanged; `narrow` (D-2, needs the user's
 *    approval) only while the circuit is open. `narrow` is a decision this
 *    module makes; the list services must honour it (not wired yet — see
 *    `NARROW_WIRED`), so until then it behaves exactly as `p1` and the status
 *    block says so.
 */

export type DegradedPolicy = 'p1' | 'narrow';
export type RouteDecision = 'engine' | 'p1' | 'narrow';
export type FallbackClass = 'policy' | 'unsupported' | 'degraded';

/**
 * Whether `LeaderboardService` / `PoolsService` implement the `narrow` policy
 * (cached / landing windows and indexed shapes from Mongo, the rest 503 +
 * Retry-After while the circuit is open). They do not yet (D-2 is pending):
 * a configured `narrow` routes like `p1` and the status says `effective: p1`.
 */
export const NARROW_WIRED = false;

const POLICY_REASONS = new Set(['mode', 'percent']);
const UNSUPPORTED_REASONS = new Set(['no_plan', 'sort', 'shape']);

/** Which counter family a per-request fallback reason belongs to. */
export function classifyFallback(reason: string): FallbackClass {
  if (POLICY_REASONS.has(reason)) return 'policy';
  if (UNSUPPORTED_REASONS.has(reason) || reason.startsWith('unsupported:') || reason.startsWith('cast:')) return 'unsupported';
  return 'degraded';
}

/** An engine's `requests.fallback` meter → `{degraded, unsupported, policy}` (each `{reason: n}`). */
export function splitFallbacks(fallback: Record<string, number> | undefined): Record<FallbackClass, Record<string, number>> {
  const out: Record<FallbackClass, Record<string, number>> = { degraded: {}, unsupported: {}, policy: {} };
  for (const [reason, n] of Object.entries(fallback ?? {})) {
    const family = out[classifyFallback(reason)];
    family[reason] = (family[reason] ?? 0) + n;
  }
  return out;
}

/** The route of a request the engine did not take: today's P1 path, or `narrow` while the circuit is open. */
export function degradedRoute(policy: DegradedPolicy, circuitOpen: boolean, narrowWired = NARROW_WIRED): Exclude<RouteDecision, 'engine'> {
  return policy === 'narrow' && narrowWired && circuitOpen ? 'narrow' : 'p1';
}

/** The full per-request decision (engine first; a refusal follows the degraded policy). */
export function decideRoute(engine: { serve: boolean }, policy: DegradedPolicy, circuitOpen: boolean, narrowWired = NARROW_WIRED): RouteDecision {
  return engine.serve ? 'engine' : degradedRoute(policy, circuitOpen, narrowWired);
}

/**
 * Why a model configured `serve` cannot serve on this replica (undefined = it
 * can, or it is not configured to serve). Order matters: the operator's own
 * actions first (memory shed, kill switch), then the runtime's readiness.
 */
export function modelDegradedReason(args: {
  configured: ReadModelMode;
  effective: ReadModelMode;
  shed: boolean;
  running: boolean;
  readiness?: { ready: boolean; reason?: string } | null;
  /** Does this replica's role serve (both / server)? A non-serving role is never degraded. Default true. */
  serves?: boolean;
}): string | undefined {
  if (args.configured !== 'serve' || args.serves === false) return undefined;
  if (args.shed) return 'memory';
  if (args.effective !== 'serve') return 'killswitch';
  if (!args.running || !args.readiness) return 'not_running';
  if (!args.readiness.ready) return args.readiness.reason ?? 'not_ready';
  return undefined;
}

interface ModelState {
  reason?: string;
  since: number;
  /** Ready at least once since boot (before that, not-ready is "loading", not a transition). */
  everReady: boolean;
  alerted: boolean;
  transitions: number;
}

/** Model-level degraded transitions (§7.2): one alert per transition, a log line on recovery. */
export class DegradedTracker {
  private readonly state = new Map<ReadModelName, ModelState>();

  constructor(
    private readonly alerts: Pick<AlertLog, 'alert'>,
    private readonly log: (message: string) => void,
    private readonly bootAt: number,
    private readonly readyTimeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record the model's current reason (undefined = serving or not configured to serve). */
  observe(model: ReadModelName, reason: string | undefined): void {
    const now = this.now();
    const prev = this.state.get(model);
    if (!prev) {
      this.state.set(model, { reason, since: now, everReady: reason === undefined, alerted: false, transitions: 0 });
      // Configured serve and still loading at boot: no alert yet (see below).
      if (reason !== undefined && !isLoadingReason(reason)) this.raise(model, reason, undefined);
      return;
    }
    if (prev.reason === reason) {
      // Still loading past the ready timeout: that IS an incident, once.
      if (reason !== undefined && !prev.everReady && !prev.alerted && now - this.bootAt >= this.readyTimeoutMs) {
        prev.alerted = true;
        prev.transitions++;
        this.alerts.alert('read_models.degraded', `model=${model} reason=${reason} (not ready ${Math.round((now - this.bootAt) / 1000)} s after boot)`, model);
      }
      return;
    }
    const was = prev.reason;
    const sinceMs = now - prev.since;
    prev.reason = reason;
    prev.since = now;
    if (reason === undefined) {
      const first = !prev.everReady;
      prev.everReady = true;
      prev.alerted = false;
      if (first) this.log(`read models: ${model} ready to serve ${Math.round((now - this.bootAt) / 1000)} s after boot`);
      else if (was !== undefined) this.log(`read models: ${model} serving again (was degraded: ${was}, for ${Math.round(sinceMs / 1000)} s)`);
      return;
    }
    if (!prev.everReady && !prev.alerted && now - this.bootAt < this.readyTimeoutMs && isLoadingReason(reason)) return;
    this.raise(model, reason, was);
  }

  private raise(model: ReadModelName, reason: string, was: string | undefined): void {
    const state = this.state.get(model)!;
    state.alerted = true;
    state.transitions++;
    this.alerts.alert('read_models.degraded', `model=${model} reason=${reason}${was ? ` (was ${was})` : ''}`, model);
  }

  /** Is the model degraded right now (configured serve, not serving)? */
  degraded(model: ReadModelName): string | undefined {
    return this.state.get(model)?.reason;
  }

  snapshot(now = this.now()): Record<string, { degraded: boolean; reason: string | null; sinceMs: number; transitions: number; everReady: boolean }> {
    const out: Record<string, { degraded: boolean; reason: string | null; sinceMs: number; transitions: number; everReady: boolean }> = {};
    for (const [model, s] of this.state) {
      out[model] = { degraded: s.reason !== undefined, reason: s.reason ?? null, sinceMs: now - s.since, transitions: s.transitions, everReady: s.everReady };
    }
    return out;
  }
}

/**
 * Before a model's first readiness every readiness reason is "still loading"
 * (snapshot load, cold scan, catch-up); only the operator's own levers — the
 * kill switch and the memory guard — are degradations from the start.
 */
function isLoadingReason(reason: string): boolean {
  return reason !== 'killswitch' && reason !== 'memory';
}

export interface CircuitState {
  open: boolean;
  notReady: number;
  live: number;
  reason?: string;
}

/** The fleet circuit per model, with transition alerts (§7.2). */
export class CircuitWatcher {
  private circuit: Record<string, CircuitState> = {};
  private readonly openedAt = new Map<string, number>();
  private readonly opened = new Map<string, number>();
  private lastBeats: FleetBeat[] = [];
  private lastAt = 0;
  private failures = 0;
  /** Models whose circuit has been CLOSED at least once since this process booted. */
  private readonly everClosed = new Set<string>();
  /** Models already alerted for still loading past the ready timeout. */
  private readonly lateAlerted = new Set<string>();
  private readonly bootAt: number;

  /**
   * A circuit that opens before its model has EVER served is a boot, not an
   * incident (the internal design notes): every replica starts not ready, and the
   * M10 rig logged `fleet_degraded` for both models 5 s after every start. That
   * first open is logged only; it alerts once if the circuit is still open
   * `readyTimeoutMs` after boot. An open after the circuit has been closed
   * (the model was serving) alerts at once, as before.
   */
  constructor(
    private readonly alerts: Pick<AlertLog, 'alert'>,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
    bootAt?: number,
    private readonly readyTimeoutMs: number = 300_000,
  ) {
    this.bootAt = bootAt ?? this.now();
  }

  /** Feed the current heartbeats for the models that are on. */
  update(beats: readonly FleetBeat[], models: readonly ReadModelName[]): Record<string, CircuitState> {
    const now = this.now();
    const next = fleetCircuit(beats, models, now);
    for (const model of models) {
      const was = this.circuit[model]?.open ?? false;
      const is = next[model]?.open ?? false;
      const detail = is ? `${next[model].reason ?? 'not ready'} (${next[model].notReady}/${next[model].live} replicas not ready)` : '';
      if (!is) this.everClosed.add(model);
      if (is && !was) {
        this.openedAt.set(model, now);
        this.opened.set(model, (this.opened.get(model) ?? 0) + 1);
        if (this.everClosed.has(model)) this.alerts.alert('read_models.fleet_degraded', `model=${model} circuit OPEN: ${detail}`, model);
        else this.log(`read models: ${model} fleet circuit open while loading (${detail}) — not alerted before the model first serves`);
      } else if (is && !this.everClosed.has(model) && !this.lateAlerted.has(model) && now - this.bootAt > this.readyTimeoutMs) {
        this.lateAlerted.add(model);
        this.alerts.alert('read_models.fleet_degraded', `model=${model} circuit still OPEN ${Math.round((now - this.bootAt) / 1000)} s after boot: ${detail}`, model);
      } else if (!is && was) {
        const since = this.openedAt.get(model);
        this.openedAt.delete(model);
        this.log(`read models: ${model} fleet circuit closed${since ? ` after ${Math.round((now - since) / 1000)} s` : ''}`);
      }
    }
    // A model turned off leaves the table (its circuit means nothing any more).
    for (const model of Object.keys(this.circuit)) if (!models.includes(model as ReadModelName)) this.openedAt.delete(model);
    this.circuit = next;
    this.lastBeats = [...beats];
    this.lastAt = now;
    this.failures = 0;
    return next;
  }

  /** redis-state could not be read: keep the last circuit (fail-static), count it. */
  failed(): void {
    this.failures++;
  }

  isOpen(model: ReadModelName): boolean {
    return this.circuit[model]?.open ?? false;
  }

  snapshot(now = this.now()) {
    return {
      circuit: this.circuit,
      members: this.lastBeats,
      readAgoMs: this.lastAt ? now - this.lastAt : null,
      readFailures: this.failures,
      opened: Object.fromEntries(this.opened),
      openForMs: Object.fromEntries([...this.openedAt].map(([model, at]) => [model, now - at])),
    };
  }
}
