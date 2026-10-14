/**
 * P2.1 — what this process runs (`PROCESS_ROLE`) and whether fleet-wide
 * leases coordinate it (`PROCESS_LEASES`). Design: tickwise-p2p3-design §2.
 *
 * ONE image and ONE DI graph in every role: modules are never conditionally
 * imported. Side effects are gated at their start hooks with `can(capability)`.
 *
 *   PROCESS_ROLE   all (default) | api | sync | fee | feeder
 *   PROCESS_LEASES auto (default: off in `all`, on in every split role) | on | off
 *
 * `all` + `auto` is EXACTLY today's single process: every capability answers
 * true and `leasesEnabled()` is false, so nothing below that is marked
 * "(leases)" does anything — no Redis lease, no flow lock, no BullMQ global
 * concurrency, no status fan-in. A split role with leases `off` is refused at
 * boot (`[alert] process_role.no_leases`): two processes of one fleet would
 * each run every singleton.
 *
 * The settings come from `configureProcessRole()` (main.ts, from the
 * validated config) and, until that runs, from the same env parsed the same
 * way — so a module that asks `can()` early never sees a different role than
 * the one Zod validated, and a spec that configures nothing runs as `all`.
 */

export const PROCESS_ROLES = ['all', 'api', 'sync', 'fee', 'feeder'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

export const PROCESS_LEASES_SETTINGS = ['auto', 'on', 'off'] as const;
export type ProcessLeasesSetting = (typeof PROCESS_LEASES_SETTINGS)[number];

/**
 * Every side effect a role may or may not start (design §2.2). The matrix is
 * the single source of truth; `all` holds every one.
 */
export type Capability =
  /** `/api`, `/v1`, `/account`, `/admin`, webhooks (anything but health). */
  | 'http-api'
  /** `/health` with indexer probes and `/health/ready`; worker roles answer a liveness `/health`. */
  | 'health-full'
  /** BullMQ Workers: positions-sync, positions-refresh, background-sweeps, position-live-refresh. */
  | 'queue-workers'
  /** BullMQ `payments` Worker + its repeatables. */
  | 'payments-worker'
  /** `TokenVerificationService`: wherever payments settle or the relay runs. */
  | 'token-verification'
  /** Scheduler (lease `scheduler`): repeatables, obliterate, boot kicks, backfill resume, global concurrency, redis-state memory sample. */
  | 'scheduler'
  /** Live listener poll loops (lease `live:<chain>:<protocol>`). */
  | 'live-listener'
  /** Fee ticks, view/dirty drains, RAM store + hint consumer (lease `fee-worker`). */
  | 'fee-worker'
  /** Fee signal producer `markViewed` (API reads). */
  | 'fee-view-signals'
  /** Fee signal producer `markDirty` (live listener, backfill lane). */
  | 'fee-dirty-signals'
  /** P3.1: the first fee reading inside the backfill flush. */
  | 'backfill-fee-read'
  /** Write-budget AIMD controller candidate (lease `wb-controller`). */
  | 'write-budget-controller'
  /** Leaderboard warmup timers. Leases on (snapshots in Redis): leader-only via `LeaderLoop`, lease `leaderboard-warmup`. */
  | 'leaderboard-warmup'
  /** Token exclusion-set refresh timer. Leases on: leader-only via `LeaderLoop`, lease `exclusions`. */
  | 'exclusion-timer'
  /** `IndexingStatusService` boot warm + refresh timer. Leases on: leader-only via `LeaderLoop`, lease `indexing-status`. */
  | 'indexing-status-warm'
  /** Leaderboard count-cache warm timer. */
  | 'count-cache-warm'
  /** Deep-page walks. */
  | 'deep-walks'
  /** `/v1/stats` lease. */
  | 'v1-stats'
  /** x402 relay (lock `relayer:<address>`). */
  | 'x402-relay'
  /** Sync-run heartbeat / reaper (`SyncRepository`). */
  | 'run-reaper';

/** Capability → the roles that hold it (design §2.2). `all` is in every row. */
export const ROLE_MATRIX: Readonly<Record<Capability, readonly ProcessRole[]>> = Object.freeze({
  'http-api': ['all', 'api'],
  'health-full': ['all', 'api'],
  'queue-workers': ['all', 'sync'],
  'payments-worker': ['all', 'sync'],
  'token-verification': ['all', 'api', 'sync'],
  scheduler: ['all', 'sync'],
  'live-listener': ['all', 'sync'],
  'fee-worker': ['all', 'fee'],
  'fee-view-signals': ['all', 'api'],
  'fee-dirty-signals': ['all', 'sync'],
  'backfill-fee-read': ['all', 'sync'],
  'write-budget-controller': ['all', 'api', 'sync', 'fee'],
  'leaderboard-warmup': ['all', 'api'],
  'exclusion-timer': ['all', 'api'],
  'indexing-status-warm': ['all', 'api'],
  'count-cache-warm': ['all', 'api'],
  'deep-walks': ['all', 'api'],
  'v1-stats': ['all', 'api'],
  'x402-relay': ['all', 'api'],
  'run-reaper': ['all', 'sync'],
});

export const CAPABILITIES = Object.keys(ROLE_MATRIX) as Capability[];

/**
 * The matrix cells NO `can()` / `roleCan()` call enforces yet, and why. The
 * matrix is the design's table; a capability absent here MUST have a consumer
 * in `src/` (pinned by `test/process-roles/capability-consumers.spec.ts`, which
 * also fails once a listed one gains a consumer, so this list cannot rot).
 *  - `via-http-api`: request-driven only — a split role without `http-api`
 *    never receives the request (`RoleGateMiddleware` 404s it), so the cell
 *    holds without a gate of its own.
 *  - `owed: …`: a real side effect that still runs in every role until the
 *    named consumer adds its gate.
 */
export const UNGATED_CAPABILITIES: Readonly<Partial<Record<Capability, string>>> = Object.freeze({
  'deep-walks': 'via-http-api',
  'v1-stats': 'via-http-api',
  'x402-relay': 'via-http-api',
  'count-cache-warm': 'via-http-api (LeaderboardCountService has no timer; counts are request-driven)',
  'fee-view-signals':
    'via-http-api (markViewed has one caller, the detail view in LeaderboardService; the method itself is not gated)',
  'fee-dirty-signals':
    'via its producers: the live listener (`live-listener`) and the backfill flush (`queue-workers`). markDirty itself must ' +
    'NOT be gated — the fee worker re-queues its own retries with it in role `fee`',
});

/**
 * Per-role defaults for settings whose env is UNSET (design §2.2). `all` is
 * today's value everywhere. The integrator's config getters read these when
 * the env is absent; an explicit env always wins.
 */
export interface RoleDefaults {
  mongoMaxPoolSize: number;
  mongoWaitQueueTimeoutMs: number;
  /** `INDEXER_MAX_IN_FLIGHT` (api ×3 should set 2 explicitly). */
  indexerMaxInFlight: number;
  /** `INDEXER_BUDGET_LOCAL_SHARE`: the share of the fleet budget a process takes alone when Redis is down. */
  indexerBudgetLocalShare: number;
  /** `PROCESS_STATUS_PUBLISH_MS`: 0 = no status fan-in. */
  statusPublishMs: number;
  /**
   * `INDEXER_INTERACTIVE_RESERVED_IN_FLIGHT`: of the in-flight slots, those
   * only interactive (`/api`, `/v1`) calls may use. `all` keeps today's 4; a
   * role without `http-api` reserves none (and the gateway ignores any
   * reserve there — `servesInteractive`).
   */
  indexerInteractiveReservedInFlight: number;
}

export const ROLE_DEFAULTS: Readonly<Record<ProcessRole, RoleDefaults>> = Object.freeze({
  all: { mongoMaxPoolSize: 60, mongoWaitQueueTimeoutMs: 10_000, indexerMaxInFlight: 12, indexerBudgetLocalShare: 1, statusPublishMs: 0, indexerInteractiveReservedInFlight: 4 },
  api: { mongoMaxPoolSize: 12, mongoWaitQueueTimeoutMs: 2_000, indexerMaxInFlight: 3, indexerBudgetLocalShare: 0.25, statusPublishMs: 10_000, indexerInteractiveReservedInFlight: 1 },
  sync: { mongoMaxPoolSize: 30, mongoWaitQueueTimeoutMs: 30_000, indexerMaxInFlight: 6, indexerBudgetLocalShare: 0.5, statusPublishMs: 10_000, indexerInteractiveReservedInFlight: 0 },
  fee: { mongoMaxPoolSize: 15, mongoWaitQueueTimeoutMs: 30_000, indexerMaxInFlight: 2, indexerBudgetLocalShare: 0.25, statusPublishMs: 10_000, indexerInteractiveReservedInFlight: 0 },
  feeder: { mongoMaxPoolSize: 5, mongoWaitQueueTimeoutMs: 30_000, indexerMaxInFlight: 2, indexerBudgetLocalShare: 0.25, statusPublishMs: 10_000, indexerInteractiveReservedInFlight: 0 },
});

export interface ProcessRoleSettings {
  role: ProcessRole;
  /** As configured (`auto` resolved separately into `leases`). */
  leasesSetting: ProcessLeasesSetting;
  /** Resolved: `auto` → off in `all`, on in every split role. */
  leases: boolean;
}

/** Thrown at boot for a split role with `PROCESS_LEASES=off`. */
export class ProcessRoleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessRoleConfigError';
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isProcessRole(value: unknown): value is ProcessRole {
  return typeof value === 'string' && (PROCESS_ROLES as readonly string[]).includes(value);
}

/** Blank/unset → `all`; anything else must be a known role. */
export function parseProcessRole(value: unknown): ProcessRole {
  const v = clean(value);
  if (v === '') return 'all';
  if (isProcessRole(v)) return v;
  throw new ProcessRoleConfigError(`PROCESS_ROLE must be one of ${PROCESS_ROLES.join('|')} (got "${String(value)}")`);
}

/** Blank/unset → `auto`. */
export function parseProcessLeases(value: unknown): ProcessLeasesSetting {
  const v = clean(value);
  if (v === '') return 'auto';
  if ((PROCESS_LEASES_SETTINGS as readonly string[]).includes(v)) return v as ProcessLeasesSetting;
  throw new ProcessRoleConfigError(`PROCESS_LEASES must be one of ${PROCESS_LEASES_SETTINGS.join('|')} (got "${String(value)}")`);
}

/**
 * Resolve role + leases. `auto` → off in `all`, on in a split role; a split
 * role with leases `off` throws (`[alert] process_role.no_leases`).
 */
export function resolveProcessRoleSettings(input: { role?: unknown; leases?: unknown }): ProcessRoleSettings {
  const role = parseProcessRole(input.role);
  const leasesSetting = parseProcessLeases(input.leases);
  const leases = leasesSetting === 'on' ? true : leasesSetting === 'off' ? false : role !== 'all';
  if (role !== 'all' && !leases) {
    throw new ProcessRoleConfigError(
      `[alert] process_role.no_leases role=${role} PROCESS_LEASES=off — a split role needs leases (every singleton would run in every process)`,
    );
  }
  return { role, leasesSetting, leases };
}

/** The structural view of `AppConfigService` this module reads (getters added by the integrator). */
export interface ProcessRoleConfigView {
  processRole?: string;
  processLeases?: string;
}

let configured: ProcessRoleSettings | undefined;
let fromEnvCache: ProcessRoleSettings | undefined;

function settingsFromEnv(): ProcessRoleSettings {
  if (!fromEnvCache) {
    try {
      fromEnvCache = resolveProcessRoleSettings({ role: process.env.PROCESS_ROLE, leases: process.env.PROCESS_LEASES });
    } catch {
      // Zod refuses the boot for a bad value; until it runs, answer today.
      return { role: 'all', leasesSetting: 'auto', leases: false };
    }
  }
  return fromEnvCache;
}

/**
 * Fix this process's role (main.ts, before the app is created; specs). Accepts
 * a config view or already-resolved settings. Throws for a split role with
 * leases off.
 */
export function configureProcessRole(source: ProcessRoleConfigView | ProcessRoleSettings): ProcessRoleSettings {
  const settings =
    'leasesSetting' in source
      ? resolveProcessRoleSettings({ role: source.role, leases: source.leasesSetting })
      : resolveProcessRoleSettings({ role: source.processRole, leases: source.processLeases });
  configured = settings;
  return settings;
}

/** Specs only: forget `configureProcessRole` and the env cache. */
export function resetProcessRoleForTests(): void {
  configured = undefined;
  fromEnvCache = undefined;
}

export function processRoleSettings(): ProcessRoleSettings {
  return configured ?? settingsFromEnv();
}

export function currentProcessRole(): ProcessRole {
  return processRoleSettings().role;
}

/** Does `role` hold `capability`? (pure; `all` holds everything) */
export function roleCan(role: ProcessRole, capability: Capability): boolean {
  const roles = ROLE_MATRIX[capability];
  return roles ? roles.includes(role) : false;
}

/** Does THIS process hold `capability`? `all` answers true for every one. */
export function can(capability: Capability): boolean {
  return roleCan(currentProcessRole(), capability);
}

/** Leases resolved for this process (`auto` → off in `all`, on in a split role). */
export function leasesEnabled(): boolean {
  return processRoleSettings().leases;
}

export function isSplitRole(role: ProcessRole = currentProcessRole()): boolean {
  return role !== 'all';
}

export function roleDefaults(role: ProcessRole = currentProcessRole()): RoleDefaults {
  return ROLE_DEFAULTS[role];
}

/** The status-publish interval every process uses once leases are on (`all` included). */
export const STATUS_PUBLISH_MS_WITH_LEASES = 10_000;

/**
 * `PROCESS_STATUS_PUBLISH_MS` when unset: 10 000 whenever leases are on —
 * role `all` included, or an `all` process beside split roles (rollout step 5)
 * would publish nothing and `[alert] process_role.mixed` could never fire —
 * else the role default (0 in `all` + leases off = today: no fan-in).
 */
export function statusPublishMsDefault(
  role: ProcessRole = currentProcessRole(),
  leases: boolean = leasesEnabled(),
): number {
  return leases ? STATUS_PUBLISH_MS_WITH_LEASES : ROLE_DEFAULTS[role].statusPublishMs;
}

/**
 * `READ_MODELS_ROLE=auto` for a process role (P-R design: all→both,
 * api→server, feeder→feeder, sync/fee→none). Mirrors `read-models/flags.ts`
 * `resolveRole(…, processRole)`.
 */
export function readModelsRoleFor(role: ProcessRole): 'both' | 'server' | 'feeder' | 'none' {
  switch (role) {
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

/** The capabilities of a role, for the boot line and status. */
export function capabilitiesOf(role: ProcessRole): Capability[] {
  return CAPABILITIES.filter((capability) => roleCan(role, capability));
}

/** `[process-role] role=… leases=… caps=…` — main.ts logs it once at boot. */
export function processRoleBootLine(settings: ProcessRoleSettings = processRoleSettings()): string {
  return `[process-role] role=${settings.role} leases=${settings.leases ? 'on' : 'off'} (PROCESS_LEASES=${settings.leasesSetting}) caps=${capabilitiesOf(settings.role).join(',')}`;
}
