import { can, currentProcessRole, roleCan, type ProcessRole } from './process-role.js';

/** The structural slice of an Express request/response this gate touches (no `express` types dependency). */
export interface GateRequest {
  method: string;
  url?: string;
  originalUrl?: string;
}
export interface GateResponse {
  status(code: number): { json(body: unknown): unknown };
}
export type GateNext = () => void;

/**
 * P2.1 — HTTP gating for worker roles (design §2.1, §2.2).
 *
 * In roles `sync | fee | feeder` the process serves NO API: `main.ts`
 * installs this middleware FIRST (before CORS, metering, the indexer-lane
 * context and the access log), and anything but `GET|HEAD /health` and
 * `/health/live` answers a bare 404 — no CORS headers, no metering, no
 * indexer context. Roles `all` and `api` pass every request through
 * untouched (the middleware is a no-op `next()`), so `all` is today exactly.
 */

/** The only paths a worker role answers. */
export const WORKER_ALLOWED_PATHS: readonly string[] = ['/health', '/health/live'];

function pathOf(req: GateRequest): string {
  const raw = (req.originalUrl ?? req.url ?? '/').split('?')[0] || '/';
  // `/health/` and `/health` are the same route to Nest.
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** Would a worker role let this request through? (pure) */
export function workerRoleAllows(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  return WORKER_ALLOWED_PATHS.includes(path);
}

/**
 * The middleware for `role` (default: this process's). In a role that holds
 * `http-api` it is a pass-through.
 */
export function roleGateMiddleware(role?: ProcessRole) {
  return (req: GateRequest, res: GateResponse, next: GateNext): void => {
    const allowsApi = role ? roleCan(role, 'http-api') : can('http-api');
    if (allowsApi) return next();
    if (workerRoleAllows(req.method, pathOf(req))) return next();
    res.status(404).json({ statusCode: 404, message: 'Not Found' });
  };
}

/** For the boot line in main.ts. */
export function roleGateSummary(role: ProcessRole = currentProcessRole()): string {
  return roleCan(role, 'http-api') ? 'http=full' : `http=${WORKER_ALLOWED_PATHS.join(',')} only`;
}
