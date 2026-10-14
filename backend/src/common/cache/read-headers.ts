import { QUERY_TIMEOUT_RETRY_AFTER_SECONDS, QueryTimeoutException } from '../../database/user-read.js';
import type { ReadMeta } from './swr-cache.js';

/** The one response method this needs — Express's `Response` satisfies it. */
export interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

/**
 * Run a cached read for a controller and translate what it learned into
 * headers: `X-Cache: hit|stale|miss` on success, `Cache-Control: no-store` on
 * an answer no cache may keep (`meta.noStore`: partial, stale-fallback,
 * pending), and `Retry-After` (+ `no-store`) on the 503 a timed-out read with
 * nothing stale to serve becomes. The body is whatever the read returned —
 * the route is used with `@Res({ passthrough: true })`.
 */
export async function withReadHeaders<T>(
  res: HeaderTarget | undefined,
  run: (meta: ReadMeta) => Promise<T>,
): Promise<T> {
  const meta: ReadMeta = {};
  try {
    const out = await run(meta);
    if (meta.cache) res?.setHeader('X-Cache', meta.cache);
    if (meta.noStore) res?.setHeader('Cache-Control', 'no-store');
    return out;
  } catch (err) {
    if (err instanceof QueryTimeoutException) {
      res?.setHeader('Retry-After', String(err.retryAfterSeconds ?? QUERY_TIMEOUT_RETRY_AFTER_SECONDS));
      res?.setHeader('Cache-Control', 'no-store');
    }
    throw err;
  }
}
