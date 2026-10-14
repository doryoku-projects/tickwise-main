import { READ_MODEL_NAMES, type ReadModelName } from './core/fields.js';

/**
 * Read-model flags (design §2.2): one mode per model, from the env, LOWERED
 * (never raised) by the runtime kill switch.
 *
 *  - `off`    — today's behaviour exactly: nothing loads, no feeder, no Redis keys.
 *  - `shadow` — the models are built and maintained (and, from R4, checked
 *               against Mongo); every response is still Mongo's.
 *  - `serve`  — the models answer (R2/R3); Mongo for rows by id and as the fallback.
 * R1 builds and maintains the models; nothing reads them yet, so `shadow` and
 * `serve` behave the same until the engines land.
 *
 * Roles (§2.4): `both` (today's single process: keeps the models AND is a
 * feeder candidate), `feeder` (P2: a warm feeder candidate that serves
 * nothing), `server` (P2 api: consumes, never holds the lease), `none`.
 * `auto` maps P2's `PROCESS_ROLE` when it exists (all → both, api → server,
 * feeder → feeder, sync / fee → none) and is `both` today.
 */

export type ReadModelMode = 'off' | 'shadow' | 'serve';
export type ReadModelsRole = 'both' | 'feeder' | 'server' | 'none';
export type ConfiguredRole = 'auto' | ReadModelsRole;

export const READ_MODEL_MODES: readonly ReadModelMode[] = ['off', 'shadow', 'serve'];
const ORDER: Record<ReadModelMode, number> = { off: 0, shadow: 1, serve: 2 };

export function isMode(value: unknown): value is ReadModelMode {
  return value === 'off' || value === 'shadow' || value === 'serve';
}

export function isModelName(value: unknown): value is ReadModelName {
  return value === 'rank' || value === 'pools';
}

/** The lower of two modes. */
export function lowerMode(a: ReadModelMode, b: ReadModelMode): ReadModelMode {
  return ORDER[a] <= ORDER[b] ? a : b;
}

export interface FlagsConfig {
  readonly readModelsMode: ReadModelMode;
  readonly poolCatalogMode?: ReadModelMode;
  readonly rankEngineMode?: ReadModelMode;
}

/** The env's mode per model (`POOL_CATALOG_MODE` / `RANK_ENGINE_MODE`, else `READ_MODELS_MODE`). */
export function configuredModes(config: FlagsConfig): Record<ReadModelName, ReadModelMode> {
  return {
    rank: config.rankEngineMode ?? config.readModelsMode,
    pools: config.poolCatalogMode ?? config.readModelsMode,
  };
}

/** The runtime override written by `POST /admin/read-models/override` (redis-state). */
export interface KillSwitchState {
  rank?: ReadModelMode;
  pools?: ReadModelMode;
  /** When it was last written (ms) and by whom (free text). */
  at?: number;
  by?: string;
}

/** A stored kill switch (JSON), tolerant of garbage: unknown fields and values are dropped. */
export function parseKillSwitch(raw: string | null | undefined): KillSwitchState {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const out: KillSwitchState = {};
    if (isMode(value.rank)) out.rank = value.rank;
    if (isMode(value.pools)) out.pools = value.pools;
    if (typeof value.at === 'number') out.at = value.at;
    if (typeof value.by === 'string') out.by = value.by;
    return out;
  } catch {
    return {};
  }
}

/** The effective mode per model: the env's, lowered by the kill switch (it can only lower). */
export function effectiveModes(configured: Record<ReadModelName, ReadModelMode>, kill: KillSwitchState): Record<ReadModelName, ReadModelMode> {
  return {
    rank: kill.rank ? lowerMode(configured.rank, kill.rank) : configured.rank,
    pools: kill.pools ? lowerMode(configured.pools, kill.pools) : configured.pools,
  };
}

/** The models a mode table keeps (everything not `off`). */
export function activeModels(modes: Record<ReadModelName, ReadModelMode>): Set<ReadModelName> {
  return new Set(READ_MODEL_NAMES.filter((model) => modes[model] !== 'off'));
}

/** `READ_MODELS_ROLE` (+ P2's `PROCESS_ROLE` when set) → this process's role. */
export function resolveRole(configured: ConfiguredRole, processRole?: string): ReadModelsRole {
  if (configured !== 'auto') return configured;
  switch ((processRole ?? '').trim().toLowerCase()) {
    case '':
    case 'all':
      return 'both';
    case 'api':
      return 'server';
    case 'feeder':
      return 'feeder';
    default:
      return 'none';
  }
}

/**
 * Why a `PROCESS_ROLE=feeder` process has nothing to do, or undefined when it
 * does (or is not a feeder). The feeder role's ONLY job is to hold the read
 * models' feeder lease; with every model off, or READ_MODELS_ROLE pinned to a
 * role that cannot hold the lease, it boots healthy (it answers /health) and
 * does no work — a misconfigured deploy that looks fine (boot smoke finding).
 */
export function idleFeederReason(processRole: string | undefined, configured: ConfiguredRole, modes: Record<ReadModelName, ReadModelMode>): string | undefined {
  if ((processRole ?? '').trim().toLowerCase() !== 'feeder') return undefined;
  if (activeModels(modes).size === 0) return 'every read model is off (READ_MODELS_MODE / POOL_CATALOG_MODE / RANK_ENGINE_MODE)';
  const role = resolveRole(configured, processRole);
  if (!isFeederCandidate(role)) return `READ_MODELS_ROLE=${configured} resolves to ${role}, which cannot hold the feeder lease`;
  return undefined;
}

/** Does a process of this role hold models in memory? */
export function keepsModels(role: ReadModelsRole): boolean {
  return role !== 'none';
}

/** Can a process of this role hold the feeder lease? */
export function isFeederCandidate(role: ReadModelsRole): boolean {
  return role === 'both' || role === 'feeder';
}

/**
 * In `serve`, the share of eligible requests answered by the model
 * (`READ_MODELS_SERVE_PERCENT`, ramp 10 → 50 → 100); the rest go to Mongo.
 */
export function selectedForServe(percent: number, random: () => number = Math.random): boolean {
  if (!(percent > 0)) return false;
  if (percent >= 100) return true;
  return random() * 100 < percent;
}
