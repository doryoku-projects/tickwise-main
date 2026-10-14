import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'kc_live_';

export interface GeneratedApiKey {
  /** The raw secret — shown to the admin once, never persisted. */
  raw: string;
  /** SHA-256 hex of `raw`, the stored lookup value. */
  hash: string;
  /** Non-secret leading chars for display. */
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const raw = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 16) };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw.trim()).digest('hex');
}

/**
 * Normalize a browser origin to its canonical `scheme://host[:port]` form
 * (lowercase, default ports stripped, no path/query/trailing slash) — the
 * exact string browsers send in the `Origin` header. Returns null for
 * anything that isn't a clean http(s) origin (paths, wildcards, garbage),
 * so invalid input is rejected at write time.
 *
 * A SCHEME-LESS host (e.g. `app.example.org`) is accepted and assumed
 * `https://` — the form a browser uses for a production site — so a customer
 * can paste either `app.example.org` or `https://app.example.org` and
 * both store identically. An explicit scheme is kept as-is, so local dev must
 * still type `http://localhost:3000` (a bare `localhost:3000` becomes https).
 */
export function normalizeOrigin(input: string): string | null {
  let trimmed = input.trim();
  if (!trimmed) return null;
  // We don't support wildcard origins; reject them explicitly (URL parsing is
  // lenient enough to otherwise accept `*` as a literal host, e.g. an admin
  // typing `*.example.com` expecting pattern matching that doesn't exist).
  if (trimmed.includes('*')) return null;
  if (!trimmed.includes('://')) trimmed = `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Reject anything beyond a bare origin — a path/query/hash in the config is
  // almost certainly a mistake (Origin headers never carry them).
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  if (url.username || url.password) return null;
  // URL#origin lowercases the host and strips default ports (443/80).
  return url.origin.toLowerCase();
}
