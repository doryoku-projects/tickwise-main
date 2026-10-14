import { leasesHeld } from '../common/lease-runner.js';
import { currentProcessRole, leasesEnabled, type ProcessRole } from '../common/process-role.js';

/**
 * P2.1 — `GET /health/live` (design §2.1): the Railway healthcheck for worker
 * roles, answered in EVERY role, with NO I/O (no Mongo, no Redis, no indexer)
 * — a standby waiting in the background for a lease must pass it while the
 * old holder is still alive.
 *
 * Deviation from the design's file list (recorded): the ROUTE is declared on
 * `HealthController` (`@Get('live')`), which `HealthModule` already
 * registers, rather than on a second controller class that would need a
 * module edit to exist at all. This file holds the response builders both
 * the live route and the worker-role `/health` use.
 */

const startedAt = Date.now();

export interface LivenessBody {
  ok: true;
  status: 'ok';
  role: ProcessRole;
  uptimeSec: number;
  timestamp: string;
}

export function livenessBody(now = Date.now()): LivenessBody {
  return {
    ok: true,
    status: 'ok',
    role: currentProcessRole(),
    uptimeSec: Math.max(0, Math.round((now - startedAt) / 1000)),
    timestamp: new Date(now).toISOString(),
  };
}

export interface WorkerHealthBody {
  ok: true;
  status: 'ok';
  service: 'positions-backend';
  role: ProcessRole;
  leases: { enabled: boolean; held: string[] };
  timestamp: string;
}

/** `/health` in a worker role (`sync | fee | feeder`): liveness + role + leases, no indexer probes. */
export function workerHealthBody(now = Date.now()): WorkerHealthBody {
  return {
    ok: true,
    status: 'ok',
    service: 'positions-backend',
    role: currentProcessRole(),
    leases: { enabled: leasesEnabled(), held: leasesHeld() },
    timestamp: new Date(now).toISOString(),
  };
}
