'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  portalApi,
  type AuthProvider,
  type IdentityList,
  type LinkedIdentity,
} from '../../lib/portal-api';
import { rememberReturnTo } from '../../lib/sso';
import { EmptyState, ErrorNotice, SkeletonRows } from '../StateViews';

const RETURN_TO = '/portal/settings';

/**
 * Every way into this account: the providers already linked, plus the ones that
 * could be. Linking runs the same OAuth round-trip as signing in and comes back
 * through /auth/callback, which returns here.
 */
export function SignInMethods({ onHasPassword }: { onHasPassword?: (value: boolean) => void }) {
  const [data, setData] = useState<IdentityList | null>(null);
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  /** Failure to LOAD the list (shown in place of the table). */
  const [loadError, setLoadError] = useState('');
  /** Failure of a link/unlink ACTION. */
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      // The provider list supplies the display label and kind for both halves of
      // this card — the identity rows and the "not linked yet" buttons.
      const [identities, catalogue] = await Promise.all([
        portalApi.listIdentities(),
        portalApi.listAuthProviders(),
      ]);
      setData(identities);
      setProviders((catalogue.providers ?? []).filter((p) => p.enabled !== false));
      // Whether a password exists also decides what the page above can offer —
      // pass a STABLE setter here, an inline arrow would re-create `load`.
      onHasPassword?.(identities.hasPassword);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load your sign-in methods');
    } finally {
      setLoading(false);
    }
  }, [onHasPassword]);

  useEffect(() => {
    void load();
  }, [load]);

  const identities = data?.identities ?? [];
  const linked = new Set(identities.map((i) => i.provider));
  const providerOf = (id: string) => providers.find((p) => p.id === id);
  const labelOf = (id: string) => providerOf(id)?.label ?? id;

  // No password and one identity = that identity is the ONLY way in. Unlinking
  // it locks the account out for good, so the button must not offer it. The
  // server refuses too; this keeps the UI from inviting a 400.
  const lastWayIn = data !== null && !data.hasPassword && identities.length === 1;

  // Wallets are linked by signing, not by an authorize redirect, and there is no
  // endpoint for that yet — so only OAuth providers get a Link button.
  const linkable = providers.filter((p) => p.kind === 'oauth' && !linked.has(p.id));
  const walletUnlinked = providers.filter((p) => p.kind === 'wallet' && !linked.has(p.id));

  async function link(provider: AuthProvider) {
    setError('');
    setBusy(provider.id);
    try {
      rememberReturnTo(RETURN_TO);
      const { authorizeUrl } = await portalApi.startIdentityLink(provider.id, RETURN_TO);
      // Full navigation — authorizeUrl is the provider's origin.
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not start linking ${provider.label}`);
      setBusy(null);
    }
  }

  async function unlink(identity: LinkedIdentity) {
    const label = labelOf(identity.provider);
    if (!confirm(`Stop using ${label} to sign in? You can link it again later.`)) return;
    setError('');
    setBusy(identity.id);
    try {
      await portalApi.unlinkIdentity(identity.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink that method');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="admin-card">
      <h2 className="admin-h">Sign-in methods</h2>

      {loading ? (
        <SkeletonRows rows={2} />
      ) : loadError ? (
        <ErrorNotice message={loadError} onRetry={() => void load()} />
      ) : (
        <>
          {identities.length === 0 ? (
            <EmptyState
              title="No providers linked"
              hint="You sign in with your email and password. Link a provider below to skip the password next time."
            />
          ) : (
            <div className="tableWrap stackTableWrap">
              <table className="admin-table stackTable">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Account</th>
                    <th>Linked</th>
                    <th>Last sign-in</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {identities.map((i) => (
                    <tr key={i.id}>
                      <td data-label="Method">{labelOf(i.provider)}</td>
                      {/* A wallet identity's subject IS the address — public, and
                          the only thing that identifies the method. */}
                      <td className="mono" style={{ whiteSpace: 'normal', maxWidth: 260 }} data-label="Account">
                        {i.email || i.subject || '—'}
                        {i.email && i.emailVerified === false && (
                          <span className="admin-pill" style={{ marginLeft: 8 }}>
                            unverified
                          </span>
                        )}
                      </td>
                      <td data-label="Linked">
                        {i.linkedAt ? new Date(i.linkedAt).toLocaleDateString() : '—'}
                      </td>
                      <td data-label="Last sign-in">
                        {i.lastLoginAt ? new Date(i.lastLoginAt).toLocaleDateString() : 'never'}
                      </td>
                      <td>
                        <button
                          className="admin-btn danger sm"
                          disabled={lastWayIn || busy === i.id}
                          title={
                            lastWayIn
                              ? 'This is the only way into your account — set a password or link a second method first.'
                              : undefined
                          }
                          onClick={() => void unlink(i)}
                        >
                          {busy === i.id ? 'Unlinking…' : 'Unlink'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {lastWayIn && (
            <p className="admin-note" style={{ marginTop: 12 }}>
              You have no password set, so this is the only way into your account — it can&apos;t be unlinked.
              Setting a password without knowing one isn&apos;t self-serve yet; email support if you need it.
            </p>
          )}

          {linkable.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <p className="admin-note">Link another provider and either one signs you in.</p>
              <div className="admin-row">
                {linkable.map((p) => (
                  <button
                    key={p.id}
                    className="admin-btn ghost sm"
                    disabled={busy !== null}
                    onClick={() => void link(p)}
                  >
                    {busy === p.id ? 'Redirecting…' : `Link ${p.label || p.id}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {walletUnlinked.length > 0 && (
            <p className="admin-note">
              Adding a wallet to an existing account isn&apos;t available yet — a wallet can only be used to sign in
              from the start.
            </p>
          )}

          {error && <div className="admin-error">{error}</div>}
        </>
      )}
    </div>
  );
}
