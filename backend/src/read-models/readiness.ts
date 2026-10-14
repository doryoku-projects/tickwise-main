import type { ReadModelName } from './core/fields.js';
import { READ_MODEL_NAMES } from './core/fields.js';
import type { ReadModelMode } from './flags.js';

/**
 * `GET /health/ready` (design §6.7 / §13, P-R R4): Railway's DEPLOY health
 * check once a model serves. 200 when every model whose EFFECTIVE mode on this
 * replica is `serve` is ready (§6.7: loaded, every served shard ready, caught
 * up, data younger than `READ_MODELS_MAX_LAG_MS`) — or when
 * `READ_MODELS_READY_TIMEOUT_MS` has passed since the PROCESS started; 503
 * otherwise. A broken model therefore blocks a deploy only if Railway's own
 * healthcheck timeout (counted from the CONTAINER's start) is shorter than
 * that timeout plus the boot: set Railway's timeout above
 * `READ_MODELS_READY_TIMEOUT_MS` + ~60 s, or lower the env below Railway's
 * (the requests a not-ready model cannot answer go to Mongo anyway).
 *
 * A replica whose role serves nothing (`READ_MODELS_ROLE=none` / `feeder`:
 * no engine runs there) never gates on a model.
 *
 * `shadow` and `off` models never gate (nothing is served from them), and a
 * model the kill switch or the memory guard lowered is not `serve` any more.
 * With every model `off` the route always answers 200 — today's behaviour for
 * a deploy that does not use it. `GET /health` is unchanged.
 *
 * The per-request gate is still the engines' own (`route()`); Railway stops
 * probing once a deploy is live, so this is a deploy gate, not a router.
 */

export interface HealthReadyInput {
  enabled: boolean;
  /** Does this replica's role serve (both / server)? A non-serving role never gates. Default true. */
  serves?: boolean;
  role?: string;
  modes: Record<ReadModelName, ReadModelMode> | null;
  readiness: Record<ReadModelName, { ready: boolean; reason?: string }> | null;
  bootAt: number;
  now: number;
  timeoutMs: number;
}

export interface HealthReadyResult {
  status: 200 | 503;
  body: {
    ready: boolean;
    readModels: 'off' | 'on';
    /** This replica's read-models role (when known). */
    role?: string;
    /** Ready only because the boot timeout passed (a model still is not). */
    timedOut?: boolean;
    sinceBootMs: number;
    models: Record<string, { mode: ReadModelMode; ready: boolean; gates: boolean; reason?: string }>;
  };
}

export function healthReady(input: HealthReadyInput): HealthReadyResult {
  const sinceBootMs = Math.max(0, input.now - input.bootAt);
  if (!input.enabled) return { status: 200, body: { ready: true, readModels: 'off', sinceBootMs, models: {} } };
  const models: HealthReadyResult['body']['models'] = {};
  const serves = input.serves !== false;
  const role = input.role ? { role: input.role } : {};
  let waiting = false;
  for (const model of READ_MODEL_NAMES) {
    const mode = input.modes?.[model] ?? 'off';
    const state = input.readiness?.[model];
    const ready = Boolean(state?.ready);
    const gates = serves && mode === 'serve';
    models[model] = { mode, ready, gates, ...(ready ? {} : { reason: state?.reason ?? (input.readiness ? 'not_ready' : 'booting') }) };
    if (gates && !ready) waiting = true;
  }
  if (!waiting) return { status: 200, body: { ready: true, readModels: 'on', ...role, sinceBootMs, models } };
  if (sinceBootMs >= input.timeoutMs) return { status: 200, body: { ready: true, readModels: 'on', ...role, timedOut: true, sinceBootMs, models } };
  return { status: 503, body: { ready: false, readModels: 'on', ...role, sinceBootMs, models } };
}
