import { API_BASE_URL } from './api';

/**
 * One authenticated realm: where its JWT lives and where an expired session
 * lands. Admin and portal sessions coexist in one browser, so a 401 must only
 * ever clear its OWN token and bounce to its OWN login.
 */
export interface HttpRealm {
  /** localStorage key holding the bearer token. `null` = public client. */
  tokenKey: string | null;
  /** Where a 401 sends the browser. Omit for a public client. */
  loginPath?: string;
  /** Pathnames that ARE the login flow — never redirect away from these, or the 401 loops. */
  publicPaths?: string[];
}

export interface HttpClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  getToken(): string | null;
  setToken(token: string): void;
  clearToken(): void;
}

/**
 * A non-2xx response, carrying the STATUS alongside the server's message.
 *
 * `message` is byte-for-byte what the plain `new Error(message)` carried before,
 * so every existing `err instanceof Error ? err.message : …` call site keeps
 * working untouched — this only ADDS the one fact those sites could not see.
 *
 * That fact matters because the server's prose is not an API. Branching on
 * "does this message read like a verification failure" breaks the moment
 * someone rewords a sentence or localises it; `status` is the contract.
 */
export class HttpError extends Error {
  /** The HTTP status of the failed response. */
  readonly status: number;

  /**
   * The parsed JSON body, when there was one.
   *
   * Some refusals are ACTIONABLE and carry the thing the caller needs: a repeat
   * checkout answers 409 with the pay link of the purchase already in flight,
   * so that the portal can send the customer to the payment they started rather
   * than raising a second invoice. Without the body, the only route to that
   * link would be parsing it out of the prose, which is exactly what `status`
   * exists to avoid.
   *
   * `unknown` rather than a typed shape: it is whatever the server sent, and
   * every reader must narrow it themselves (see `checkoutConflict`).
   */
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * The HTTP status behind a rejection, or `null` when the failure was not an
 * HTTP response at all (a network drop, an aborted fetch, a bug).
 *
 * Callers should treat `null` as "unknown, assume nothing" — never as a status
 * they can compare against.
 */
export function httpStatus(err: unknown): number | null {
  return err instanceof HttpError ? err.status : null;
}

export function createHttpClient({ tokenKey, loginPath, publicPaths = [] }: HttpRealm): HttpClient {
  const hasStore = () => typeof window !== 'undefined' && tokenKey !== null;
  const getToken = () => (hasStore() ? window.localStorage.getItem(tokenKey as string) : null);
  const setToken = (token: string) => {
    if (hasStore()) window.localStorage.setItem(tokenKey as string, token);
  };
  const clearToken = () => {
    if (hasStore()) window.localStorage.removeItem(tokenKey as string);
  };

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = getToken();
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      let message = res.statusText;
      let body: unknown;
      try {
        body = await res.json();
        const parsed = body as { error?: string; message?: string } | null;
        message = parsed?.error ?? parsed?.message ?? message;
      } catch {
        /* not JSON — the status line is all there is */
      }
      if (res.status === 401 && tokenKey) {
        clearToken();
        // Token expired/invalid mid-session — kick to login without a manual
        // refresh. location.assign (not router.replace) on purpose: the full
        // reload nukes any authed React state still mounted.
        const here = typeof window === 'undefined' ? '' : window.location.pathname;
        if (loginPath && here && here !== loginPath && !publicPaths.includes(here)) {
          window.location.assign(loginPath);
        }
      }
      throw new HttpError(message, res.status, body);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return { request, getToken, setToken, clearToken };
}
