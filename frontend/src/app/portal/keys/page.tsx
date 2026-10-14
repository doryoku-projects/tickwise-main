'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { OriginsInput } from '../../../components/OriginsInput';
import { EmptyState, ErrorNotice, SkeletonRows } from '../../../components/StateViews';
import { KeyReveal } from '../../../components/portal/KeyReveal';
import {
  portalApi,
  type AccountOverview,
  type ApiKeySummary,
  type IssuedApiKey,
} from '../../../lib/portal-api';

export default function PortalKeysPage() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [loading, setLoading] = useState(true);
  /** Failure to LOAD the list (shown in place of the table). */
  const [loadError, setLoadError] = useState('');
  /** Failure of an ACTION — create/revoke/delete/origins (shown by the form). */
  const [error, setError] = useState('');

  // create form
  const [label, setLabel] = useState('');
  const [keyType, setKeyType] = useState<'server' | 'browser'>('server');
  const [origins, setOrigins] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);

  // inline origin editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editList, setEditList] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      // The overview carries the plan's key ceiling and whether browser keys
      // are allowed — both gate the create form.
      const [keyRes, overviewRes] = await Promise.all([portalApi.listKeys(), portalApi.overview()]);
      setKeys(keyRes.keys ?? []);
      setOverview(overviewRes);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load your keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCount = keys.filter((k) => k.status === 'active').length;
  const maxKeys = overview?.keys.max ?? 0;
  const atCeiling = maxKeys > 0 && activeCount >= maxKeys;
  const browserAllowed = overview?.plan?.allowBrowserKeys !== false;

  async function create() {
    setError('');
    if (keyType === 'browser' && origins.length === 0) {
      setError('A browser key needs at least one allowed site URL (e.g. https://app.example.com).');
      return;
    }
    setCreating(true);
    try {
      const key = await portalApi.createKey({
        label: label.trim(),
        keyType,
        origins: keyType === 'browser' ? origins : [],
      });
      // The raw secret exists only in this response — hand it straight to the
      // reveal surface and never store it anywhere else.
      setIssued(key);
      setLabel('');
      setOrigins([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    setError('');
    try {
      await portalApi.revokeKey(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    }
  }

  async function remove(id: string) {
    if (!confirm('Permanently delete this API key? Anything using it stops working immediately.')) return;
    setError('');
    try {
      await portalApi.deleteKey(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function saveOrigins(id: string) {
    setError('');
    try {
      await portalApi.setKeyOrigins(id, editList);
      setEditingId(null);
      setEditList([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the allowed site URLs');
    }
  }

  return (
    <div>
      <div className="portalHead">
        <div>
          <h1>API keys</h1>
          <p>
            Send your key as the <span className="mono">KC-APIKey</span> header. Server keys are rejected from
            browsers; browser keys only work from the site URLs you list.
          </p>
        </div>
      </div>

      <div className="admin-card">
        <h2 className="admin-h">Create a key</h2>
        <div className="admin-row" style={{ marginBottom: 10 }}>
          <input
            className="admin-input"
            placeholder="Label (e.g. production backend)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <select
            className="admin-select"
            value={keyType}
            onChange={(e) => setKeyType(e.target.value as 'server' | 'browser')}
          >
            <option value="server">Server key (backend-only)</option>
            <option value="browser" disabled={!browserAllowed}>
              Browser key (frontend, origin-bound)
            </option>
          </select>
          {keyType === 'browser' && <OriginsInput value={origins} onChange={setOrigins} />}
          <button className="admin-btn" onClick={create} disabled={creating || atCeiling}>
            {creating ? 'Creating…' : 'Create key'}
          </button>
        </div>

        <p className="admin-note">
          {keyType === 'server'
            ? 'Server keys are rejected when a request carries an Origin header — keep them on your backend.'
            : 'Browser keys work only from the listed site URLs, so a leaked key is useless elsewhere (https is assumed if you omit the scheme).'}
        </p>
        {!browserAllowed && (
          <p className="admin-note">
            Your plan doesn&apos;t include browser keys. <Link href="/pricing">Compare plans</Link>.
          </p>
        )}
        {atCeiling && (
          <p className="admin-note">
            You&apos;ve used all {maxKeys} keys on your plan. Revoke one, or{' '}
            <Link href="/pricing">move to a bigger plan</Link>.
          </p>
        )}
        {error && <div className="admin-error">{error}</div>}
      </div>

      <div className="admin-card">
        <h2 className="admin-h">
          Your keys{maxKeys > 0 ? ` — ${activeCount} of ${maxKeys} active` : ''}
        </h2>

        {!browserAllowed && keys.length > 0 && (
          <p className="admin-note">
            Site URLs are a browser-key feature — your plan issues server-only keys.{' '}
            <Link href="/pricing">Compare plans</Link>.
          </p>
        )}

        {loading ? (
          <SkeletonRows rows={3} />
        ) : loadError ? (
          <ErrorNotice message={loadError} onRetry={() => void load()} />
        ) : keys.length === 0 ? (
          <EmptyState
            title="No API keys yet"
            hint="Create one above, then send it as the KC-APIKey header on any /v1 endpoint. Nothing can call the API until you do."
          />
        ) : (
          <div className="tableWrap stackTableWrap">
            {/* Seven columns — the widest table a customer sees. `stackTable`
                cards it below 720px; every `td` carries `data-label`. */}
            <table className="admin-table stackTable">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Label</th>
                  <th>Type / site URLs</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const editing = editingId === k.id;
                  return (
                    <Fragment key={k.id}>
                      <tr>
                        <td className="mono" data-label="Key">
                          {k.prefix}…
                        </td>
                        <td data-label="Label">{k.label || '—'}</td>
                        {/* origins can be long — this is the one cell allowed to wrap */}
                        <td style={{ whiteSpace: 'normal', maxWidth: 260 }} data-label="Type / site URLs">
                          <span className="admin-pill">{k.keyType}</span>{' '}
                          <span className="admin-note">
                            {k.keyType === 'browser' ? (k.allowedOrigins ?? []).join(', ') || '—' : 'backend-only'}
                          </span>
                        </td>
                        <td data-label="Status">
                          <span className={k.status === 'revoked' ? 'admin-pill revoked' : 'admin-pill'}>
                            {k.status}
                          </span>
                        </td>
                        <td data-label="Created">
                          {k.createdAt ? new Date(k.createdAt).toLocaleDateString() : '—'}
                        </td>
                        <td data-label="Last used">
                          {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'never'}
                        </td>
                        <td>
                          {/* nowrap: the cell is narrow, and wrapped buttons stretch the row */}
                          <div className="admin-row" style={{ flexWrap: 'nowrap' }}>
                            {k.status === 'active' && (
                              <>
                                {/* Adding an origin converts a server key into
                                    a browser key, which the API refuses on a
                                    plan without them — so don't offer it. */}
                                <button
                                  className="admin-btn ghost sm"
                                  disabled={!browserAllowed}
                                  title={
                                    browserAllowed
                                      ? undefined
                                      : "Your plan doesn't include browser keys, so a key can't be bound to site URLs."
                                  }
                                  onClick={() => {
                                    if (!browserAllowed) return;
                                    setEditingId(editing ? null : k.id);
                                    setEditList(k.allowedOrigins ?? []);
                                  }}
                                >
                                  {editing ? 'Close' : 'Site URLs'}
                                </button>
                                <button className="admin-btn danger sm" onClick={() => revoke(k.id)}>
                                  Revoke
                                </button>
                              </>
                            )}
                            <button className="admin-btn ghost sm" onClick={() => remove(k.id)}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                      {editing && browserAllowed && (
                        <tr>
                          <td colSpan={7}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
                              <span className="admin-note">
                                Sites allowed to call the API with this key. Clearing the list turns it back into a
                                server-only key.
                              </span>
                              <OriginsInput value={editList} onChange={setEditList} />
                              <div className="admin-row">
                                <button className="admin-btn sm" onClick={() => saveOrigins(k.id)}>
                                  Save
                                </button>
                                <button
                                  className="admin-btn ghost sm"
                                  onClick={() => {
                                    setEditingId(null);
                                    setEditList([]);
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {issued && <KeyReveal issued={issued} onDismiss={() => setIssued(null)} />}
    </div>
  );
}
