'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Play } from 'lucide-react';
import { ErrorNotice, SkeletonRows } from '../../../components/StateViews';
import { catalogApi, type UnitCost } from '../../../lib/catalog-api';
import { getPortalToken, portalApi, type ApiKeySummary } from '../../../lib/portal-api';
import {
  PLAYGROUND_ENDPOINTS,
  buildRequest,
  defaultValues,
  findEndpoint,
} from '../../../lib/playground-endpoints';

interface ProxyResult {
  status: number;
  statusText: string;
  durationMs: number;
  url: string;
  headers: Record<string, string>;
  truncated: boolean;
  body: unknown;
  text?: string;
}

/**
 * Try the API against your own key, from inside the portal.
 *
 * ── THE TWO CONSTRAINTS THAT SHAPE THIS WHOLE PAGE ──────────────────────────
 *
 * **1. The call cannot be made from the browser.** `ApiKeyGuard` 403s a server
 * key whenever an `Origin` header is present, and browser keys need
 * `plan.allowBrowserKeys` (Free does not have it) plus this origin registered.
 * So every request goes through `/api/playground`, which runs server-side and
 * therefore sends no Origin. See that file for the rest of the reasoning.
 *
 * **2. We cannot read the customer's key.** Keys are stored hashed and the
 * secret is shown exactly once, at issuance — so the portal genuinely does not
 * know it and cannot fill it in. The customer pastes it, or creates a key here
 * and it is held in React state for the session. It is deliberately NOT put in
 * `localStorage`: a long-lived secret in storage is the thing the key-type
 * rules exist to avoid, and losing it on reload costs one paste.
 */
export default function PlaygroundPage() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [costs, setCosts] = useState<UnitCost[]>([]);

  const [endpointId, setEndpointId] = useState(PLAYGROUND_ENDPOINTS[0].id);
  // Seeded once from the endpoint the picker opens on, and re-seeded only when
  // the picker changes — never from an effect, which would overwrite whatever
  // the customer had just typed into the endpoint they are already on.
  const [values, setValues] = useState<Record<string, string>>(() =>
    defaultValues(PLAYGROUND_ENDPOINTS[0]),
  );
  const [apiKey, setApiKey] = useState('');

  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ProxyResult | null>(null);
  const [sendError, setSendError] = useState('');

  const endpoint = useMemo(
    () => PLAYGROUND_ENDPOINTS.find((e) => e.id === endpointId) ?? PLAYGROUND_ENDPOINTS[0],
    [endpointId],
  );

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const { keys: list } = await portalApi.listKeys();
      setKeys(list);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load your API keys');
    }
    // The cost table is a nice-to-have: a failure here must not block the page,
    // it just means the "costs N units" line is omitted rather than guessed.
    try {
      const { units } = await catalogApi.listUnitCosts();
      setCosts(units);
    } catch {
      setCosts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeKeys = (keys ?? []).filter((k) => k.status === 'active');
  const cost = endpoint.routeKey ? costs.find((c) => c.routeKey === endpoint.routeKey)?.cost : 0;
  const preview = buildRequest(endpoint, values);

  async function send() {
    setSending(true);
    setSendError('');
    setResult(null);
    try {
      const response = await fetch('/api/playground', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The portal session, so the proxy is not an open relay.
          authorization: `Bearer ${getPortalToken() ?? ''}`,
        },
        body: JSON.stringify({ endpointId: endpoint.id, values, apiKey }),
      });
      const payload = (await response.json()) as ProxyResult & { error?: string };
      if (payload.error) {
        setSendError(payload.error);
        return;
      }
      setResult(payload);
    } catch {
      setSendError('The request could not be sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <div className="portalHead">
        <div>
          <h1>Playground</h1>
          <p>
            Try the endpoints against your own key. Calls are real — they count against your quota
            exactly as they would from your code.
          </p>
        </div>
      </div>

      {keys === null && !loadError ? (
        <div className="admin-card">
          <SkeletonRows rows={4} />
        </div>
      ) : loadError ? (
        <ErrorNotice message={loadError} onRetry={() => void load()} />
      ) : activeKeys.length === 0 ? (
        <NoKeyGate />
      ) : (
        <>
          <div className="admin-card">
            <h2 className="admin-h">Request</h2>

            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <label className="block">
                <span className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
                  Endpoint
                </span>
                <select
                  className="admin-input w-full"
                  value={endpointId}
                  onChange={(e) => {
                    setEndpointId(e.target.value);
                    // Parameters do not carry over: the same NAME means a
                    // different thing between endpoints (a pools `poolId` path
                    // segment vs the positions filter), and a stale value
                    // silently sent to the next call is worse than an empty box.
                    // Replaced outright by the new endpoint's defaults, so
                    // nothing from the previous one survives the switch.
                    setValues(defaultValues(findEndpoint(e.target.value) ?? PLAYGROUND_ENDPOINTS[0]));
                    setResult(null);
                    setSendError('');
                  }}
                >
                  {PLAYGROUND_ENDPOINTS.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.method} {e.path}
                    </option>
                  ))}
                </select>
                <span className="admin-note">{endpoint.summary}</span>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
                  API key
                </span>
                <input
                  className="admin-input w-full font-mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={endpoint.routeKey === null ? 'not needed for this endpoint' : 'kc_live_…'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                {/* Said plainly, because "why can't it just use my key?" is the
                    first thing anyone asks here. */}
                <span className="admin-note">
                  Paste one of your keys. We store only a hash, so the secret is shown once at
                  issuance and cannot be filled in for you.
                </span>
              </label>
            </div>

            {endpoint.params.length > 0 ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {endpoint.params.map((param) => {
                  const id = `pg-${param.name}`;
                  return (
                    <label key={param.name} className="block min-w-0">
                      <span className="mb-1.5 block font-mono text-[0.6875rem] text-muted-foreground">
                        {param.name}
                        {param.in === 'path' ? (
                          <span className="ml-1 text-destructive">*</span>
                        ) : null}
                      </span>

                      {param.kind === 'enum' ? (
                        <select
                          id={id}
                          className="admin-input w-full"
                          value={values[param.name] ?? ''}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [param.name]: e.target.value }))
                          }
                        >
                          <option value="">{param.in === 'path' ? 'choose…' : 'default'}</option>
                          {param.options?.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : param.kind === 'boolean' ? (
                        <select
                          id={id}
                          className="admin-input w-full"
                          value={values[param.name] ?? ''}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [param.name]: e.target.value }))
                          }
                        >
                          <option value="">default</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          id={id}
                          className="admin-input w-full font-mono"
                          inputMode={param.kind === 'number' ? 'numeric' : 'text'}
                          placeholder={param.placeholder ?? (param.in === 'query' ? 'default' : '')}
                          value={values[param.name] ?? ''}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [param.name]: e.target.value }))
                          }
                        />
                      )}

                      {param.help ? <span className="admin-note">{param.help}</span> : null}
                    </label>
                  );
                })}
              </div>
            ) : null}

            {/* Exactly what the server will call, built by the same pure
                function the proxy uses — so this is a preview, not a guess. */}
            <div className="mt-4 overflow-x-auto rounded-lg border border-border/60 bg-surface-2/50 p-3 font-mono text-xs">
              <span className="text-muted-foreground">{endpoint.method} </span>
              {preview.ok ? (
                <span>
                  {preview.request.path}
                  <span className="text-primary">{preview.request.search}</span>
                </span>
              ) : (
                <span className="text-warning">{preview.error}</span>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                className="admin-btn primary"
                type="button"
                disabled={sending || !preview.ok}
                onClick={() => void send()}
              >
                <Play className="mr-1.5 inline h-3.5 w-3.5" />
                {sending ? 'Sending…' : 'Send request'}
              </button>
              <span className="admin-note">
                {endpoint.routeKey === null
                  ? 'Free and unmetered — this endpoint costs nothing.'
                  : cost === undefined
                    ? 'Cost unavailable.'
                    : `Costs ${cost} ${cost === 1 ? 'unit' : 'units'}.`}
              </span>
            </div>

            {sendError ? <p className="payInstrWarn mt-3">{sendError}</p> : null}
          </div>

          {result ? <ResponsePanel result={result} /> : null}
        </>
      )}
    </div>
  );
}

/**
 * The gate. Shown when the account holds no ACTIVE key, which includes the
 * case where every key has been revoked — `status` is checked rather than mere
 * existence, because a revoked key in the list is not something to try with.
 */
function NoKeyGate() {
  return (
    <div className="admin-card">
      <h2 className="admin-h">An API key is needed first</h2>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p>
            The playground sends real requests, so it needs a real key. Create one and paste the
            secret back here — it is shown only at issuance, so copy it before you close the dialog.
          </p>
          <p className="admin-note">
            A <strong>server</strong> key is the right choice: the playground calls the API from our
            server, not from your browser.
          </p>
        </div>
        <Link className="admin-btn primary shrink-0" href="/portal/keys">
          Create an API key
        </Link>
      </div>
    </div>
  );
}

function ResponsePanel({ result }: { result: ProxyResult }) {
  const ok = result.status >= 200 && result.status < 300;
  const quotaRemaining = result.headers['x-quota-remaining'];
  const quotaLimit = result.headers['x-quota-limit'];
  const retryAfter = result.headers['retry-after'];

  return (
    <div className="admin-card">
      <h2 className="admin-h">Response</h2>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-md px-2 py-1 font-medium ${
            ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
          }`}
        >
          {result.status} {result.statusText}
        </span>
        <span className="font-mono text-muted-foreground">{result.durationMs} ms</span>
        {quotaRemaining !== undefined ? (
          <span className="font-mono text-muted-foreground">
            quota {Number(quotaRemaining).toLocaleString()}
            {quotaLimit !== undefined ? ` / ${Number(quotaLimit).toLocaleString()}` : ''} left
          </span>
        ) : null}
        {/* Only on a 429, and it is the one number that tells them what to do. */}
        {retryAfter !== undefined ? (
          <span className="font-mono text-warning">retry after {retryAfter}s</span>
        ) : null}
      </div>

      <div className="mt-2 overflow-x-auto font-mono text-xs text-muted-foreground">
        {result.url}
      </div>

      {result.truncated ? (
        <p className="admin-note">
          The response was large and has been cut short for display. The call itself completed
          normally.
        </p>
      ) : null}

      <pre className="mt-3 max-h-[28rem] overflow-auto rounded-lg border border-border/60 bg-background/60 p-3 font-mono text-xs leading-relaxed">
        {result.body !== null && result.body !== undefined
          ? JSON.stringify(result.body, null, 2)
          : (result.text ?? '')}
      </pre>
    </div>
  );
}
