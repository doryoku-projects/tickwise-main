import { API_BASE_URL } from '@/lib/api';
import { buildRequest, findEndpoint } from '@/lib/playground-endpoints';

/**
 * The playground's request proxy.
 *
 * ── WHY THIS EXISTS AT ALL, AND WHY IT IS NOT A `fetch` IN THE PAGE ──────────
 *
 * A browser cannot call `/v1` with most customers' keys. `ApiKeyGuard` 403s a
 * **server** key outright whenever the request carries an `Origin` header —
 * that rule is the whole protection against a backend key pasted into frontend
 * JS — and a **browser** key needs `plan.allowBrowserKeys`, which Free does not
 * have, plus this portal's origin registered on the key. So a playground that
 * fetched `/v1` from the page would 403 for every Free customer and for every
 * paid one who had not bound this origin, and the error would read as "your key
 * is broken" rather than "that is not what this key is for".
 *
 * Running the call server-side sends it with NO `Origin`, which is the
 * server-to-server case both key types allow. The customer's key does what it
 * says on the tin, and nothing about the guard has to be relaxed.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not accept a URL, or a path, or a header set. It accepts an endpoint
 * ID from `PLAYGROUND_ENDPOINTS` and builds the URL from that catalogue's
 * template. A proxy that forwards a caller-supplied path is an SSRF primitive
 * aimed at everything the API host can reach, and "we validate it with a regex"
 * is how that goes wrong slowly.
 *
 * It does not log, store, echo or persist the API key. The key is read from the
 * body, used once as a header, and goes out of scope. It is never written to a
 * response, and this file must not gain a `console.log(body)`.
 */

export const runtime = 'nodejs';
/** Never cached: it is a live call whose whole point is the live answer. */
export const dynamic = 'force-dynamic';

/**
 * The header name the API expects. Mirrors the backend's `API_KEY_HEADER`
 * (default `KC-APIKey`); overridable for a deployment that changed it, since a
 * mismatch here fails as a confusing 401 rather than as a config error.
 */
const KEY_HEADER = process.env.NEXT_PUBLIC_API_KEY_HEADER || 'KC-APIKey';

/** A playground call is a human pressing a button; it should not hang a tab. */
const TIMEOUT_MS = 15_000;

/**
 * Charts responses are the big ones. Past this we stop reading rather than
 * stream megabytes into a `<pre>` that nobody can scroll.
 */
const MAX_BODY_BYTES = 2_000_000;

interface ProxyRequest {
  endpointId?: unknown;
  values?: unknown;
  apiKey?: unknown;
}

function bad(error: string, status = 400) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  let body: ProxyRequest;
  try {
    body = (await request.json()) as ProxyRequest;
  } catch {
    return bad('Malformed request body.');
  }

  const endpoint = findEndpoint(body.endpointId);
  if (!endpoint) return bad('Unknown endpoint.');

  const values: Record<string, string> = {};
  if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
    for (const [k, v] of Object.entries(body.values as Record<string, unknown>)) {
      if (typeof v === 'string') values[k] = v;
    }
  }

  const built = buildRequest(endpoint, values);
  if (!built.ok) return bad(built.error);

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  // The two metadata routes are unguarded on the backend, so a key is optional
  // there — and sending one anyway would meter nothing but would fail if the
  // key were revoked, which is a confusing way to break a free route.
  if (endpoint.routeKey !== null && !apiKey) return bad('An API key is required for this endpoint.');
  if (apiKey.length > 512) return bad('That does not look like an API key.');

  /*
   * THE PORTAL SESSION IS REQUIRED, so this is not an open relay.
   *
   * The proxy's whole function is to strip the `Origin` header, which is
   * precisely the check that stops a leaked server key being used from a
   * browser. Left unauthenticated it would hand that bypass to any page on the
   * internet. Verified against the API rather than by decoding the token here:
   * this app holds no JWT secret, and a signature it cannot check is not a
   * check.
   */
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return bad('Sign in to use the playground.', 401);

  const session = await fetch(`${API_BASE_URL}/account/auth/me`, {
    headers: { authorization },
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!session || !session.ok) return bad('Sign in to use the playground.', 401);

  const url = `${API_BASE_URL}${built.request.path}${built.request.search}`;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      headers: apiKey ? { [KEY_HEADER]: apiKey } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Distinguish "we could not reach the API" from "the API said no": the
    // first is our problem and the second is the answer the customer came for.
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return Response.json(
      { error: timedOut ? `The API did not respond within ${TIMEOUT_MS / 1000}s.` : 'Could not reach the API.' },
      { status: 502 },
    );
  }

  const raw = await response.text();
  const truncated = raw.length > MAX_BODY_BYTES;
  const text = truncated ? raw.slice(0, MAX_BODY_BYTES) : raw;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON body is itself informative (an HTML error page from a proxy in
    // front of the API, say), so it is passed through as text rather than
    // replaced with a parse error.
  }

  /*
   * Only the metering headers are forwarded, by name. The customer is entitled
   * to their own quota figures; they are not entitled to whatever else a proxy
   * or the framework attached, and an allow-list means a header added upstream
   * later cannot start leaking through this hole by default.
   */
  const meta: Record<string, string> = {};
  for (const name of [
    'x-quota-limit',
    'x-quota-remaining',
    'x-quota-reset',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'retry-after',
  ]) {
    const value = response.headers.get(name);
    if (value !== null) meta[name] = value;
  }

  return Response.json({
    status: response.status,
    statusText: response.statusText,
    durationMs: Date.now() - startedAt,
    url: `${built.request.path}${built.request.search}`,
    headers: meta,
    truncated,
    body: parsed,
    text: parsed === null ? text : undefined,
  });
}
