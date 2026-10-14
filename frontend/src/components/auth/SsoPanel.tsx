'use client';

import { Github, Wallet } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { portalApi, setPortalToken, type AuthProvider } from '../../lib/portal-api';
import { rememberReturnTo } from '../../lib/sso';
import { isUserRejection } from '../../lib/wallet';
import { useWallet } from '../providers/WalletProvider';

/** Which step of the wallet handshake the button is waiting on. */
type WalletStage = 'connect' | 'sign' | 'verify';

const WALLET_LABEL: Record<WalletStage, string> = {
  connect: 'Connecting…',
  sign: 'Check your wallet…',
  verify: 'Signing in…',
};

/**
 * The provider buttons shared by /login and /signup. Both routes offer the same
 * methods — signing in with a provider that has no account yet creates one on
 * the Free plan, so there is nothing to branch on but the copy.
 *
 * The list comes from the server: a provider without credentials configured is
 * simply absent, so this never renders a button that can't work.
 */
export function SsoPanel({
  mode,
  returnTo,
  onSignedIn,
  hideProvider,
  onlyProviders,
  emailFormBelow,
}: {
  mode: 'signin' | 'signup';
  returnTo: string;
  /**
   * A provider id to leave OUT of the list.
   *
   * Exists for exactly one caller, /link-account, and for a reason worth stating
   * plainly: the provider being CONNECTED can never be a way in there. Signing in
   * with it is what produced the collision, so pressing it re-collides, mints a
   * brand-new ceremony and lands back on this same page — a loop with no exit
   * that looks like a working button. Observed live with two Google accounts.
   *
   * The rare legitimate case (a DIFFERENT account at the same provider that is
   * already attached to the target) is not lost, only moved: sign in with it at
   * /login, come back, and the ceremony resumes from its sessionStorage carrier.
   */
  hideProvider?: string | null;
  /**
   * ALLOW-LIST: render only these provider ids, in this order.
   *
   * The strictly stronger form of `hideProvider`, and the ceremony page needs it
   * rather than the other way round. Hiding ONE provider still offers every other
   * configured one — and on /link-account every one of those collides on the same
   * address, mints a fresh ceremony, and flips the page to naming ITSELF. Google →
   * GitHub → Google, forever, with no error to see. Only the providers already
   * attached to the target account can actually sign the customer in, and this is
   * how the page says so.
   *
   * An EMPTY array means "offer none", which is a real state (an account whose
   * only identity is the one now colliding) and must not be confused with
   * `undefined` = "no restriction".
   */
  onlyProviders?: string[] | null;
  /**
   * Whether the CALLER renders an email + password form after this panel.
   *
   * Defaults to true because every other caller does. `false` suppresses the
   * "or use your email" divider, which exists only to introduce that form — see
   * where it renders.
   */
  emailFormBelow?: boolean;
  /**
   * Called INSTEAD of navigating to `returnTo`, for a caller whose next step is
   * on the page it is already on. Only the wallet path can reach it — an OAuth
   * sign-in leaves the origin and comes back through /auth/callback, which does
   * its own navigating.
   *
   * /link-account needs this: its `returnTo` is itself, and replacing the route
   * with the one already rendered leaves the page holding a session it never
   * noticed arriving.
   */
  onSignedIn?: () => void;
}) {
  const router = useRouter();
  const [providers, setProviders] = useState<AuthProvider[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState<WalletStage>('connect');
  const [error, setError] = useState('');
  // Web3-Onboard brings its own picker (browser extensions, Coinbase, and — once
  // a WalletConnect project id is configured — mobile and Ledger), so there is no
  // browser-wallet sniffing left to do and nothing that can switch the button
  // off: it needs no key of any kind to work.
  const { prepare: prepareWallet, connect: connectWallet } = useWallet();

  const offersWallet = providers?.some((p) => p.kind === 'wallet') ?? false;

  // Load the wallet stack only once the SERVER says there is a wallet button to
  // press. Anywhere else it would be a chunk (and a wallet handshake) on a page
  // that never shows one.
  useEffect(() => {
    if (offersWallet) prepareWallet();
  }, [offersWallet, prepareWallet]);

  useEffect(() => {
    let cancelled = false;
    portalApi
      .listAuthProviders()
      .then((res) => {
        if (cancelled) return;
        const enabled = (res.providers ?? []).filter((p) => p.enabled !== false);
        // The allow-list wins when present — including when EMPTY, which means
        // "this account has no provider that can sign it in". `?? undefined` is
        // deliberate: `null` and `undefined` both mean unrestricted, `[]` does not.
        const allowed = onlyProviders ?? undefined;
        setProviders(
          allowed
            ? // Ordered by the allow-list, not by the server's list, so the page
              // can lead with whatever the account most likely uses.
              allowed
                .map((id) => enabled.find((p) => p.id === id))
                .filter((p): p is AuthProvider => Boolean(p))
            : enabled.filter((p) => p.id !== hideProvider),
        );
      })
      .catch(() => {
        if (cancelled) return;
        // Password sign-in still works, so this is a note and not an error page.
        setProviders([]);
        setListFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the JOINED allow-list, not the array: the caller builds it inline
    // from a fetched descriptor, so a fresh identity every render would refetch
    // the provider list on every render.
  }, [hideProvider, onlyProviders?.join(',')]);

  async function startOauth(provider: AuthProvider) {
    setError('');
    setBusy(provider.id);
    try {
      // The provider redirect only carries `provider` and the handoff code back,
      // so stash where we're going before leaving the origin.
      rememberReturnTo(returnTo);
      const { authorizeUrl } = await portalApi.startOauth(provider.id, returnTo);
      // Full navigation, not router.push — authorizeUrl is another origin.
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not start ${provider.label || provider.id} sign-in`);
      setBusy(null);
    }
  }

  /**
   * Connecting a wallet proves nothing — the session is minted by the server
   * after it recovers the signature, so the nonce → sign → verify sequence below
   * is byte-for-byte what it has always been, whatever the picker of the day is.
   * Web3-Onboard only supplies the account and the provider to sign on.
   */
  async function signInWithWallet(provider: AuthProvider) {
    setError('');
    setStage('connect');
    setBusy(provider.id);
    try {
      // Reuses a wallet that is already connected; otherwise opens the picker.
      const wallet = await connectWallet();
      if (!wallet) {
        // The picker was dismissed. A cancel, so no banner — same as a 4001.
        setBusy(null);
        return;
      }
      const { nonce, message } = await portalApi.walletNonce(wallet.address);
      setStage('sign');
      // `message` is signed exactly as received — the server checks the
      // signature against its own copy, so any edit here fails verification.
      const signature = await wallet.provider.request({
        method: 'personal_sign',
        params: [message, wallet.address],
      });
      setStage('verify');
      const { token } = await portalApi.walletVerify(nonce, signature);
      setPortalToken(token);
      if (onSignedIn) onSignedIn();
      else router.replace(returnTo);
    } catch (err) {
      // Dismissing the wallet prompt is a cancel; a banner would be noise.
      if (!isUserRejection(err)) {
        setError(err instanceof Error ? err.message : 'Wallet sign-in failed');
      }
      setBusy(null);
    }
  }

  // Reserve the row while the list loads so the form below doesn't jump.
  if (providers === null) {
    return (
      <div className="skeletonRows" aria-busy="true">
        <div className="skeletonRow" style={{ height: 34 }} />
      </div>
    );
  }

  if (providers.length === 0) {
    return listFailed ? (
      <span className="admin-note" style={{ margin: 0 }}>
        Sign-in providers couldn&apos;t be loaded. Use your email and password below.
      </span>
    ) : null;
  }

  return (
    <>
      <div className="ssoGrid">
        {providers.map((p) => {
          const isWallet = p.kind === 'wallet';
          const pending = busy === p.id;
          const label = p.label || p.id;
          return (
            <button
              // type="button": this sits inside the password <form>, and a bare
              // button would submit it instead of starting the handshake.
              type="button"
              key={p.id}
              className="admin-btn ghost"
              disabled={busy !== null}
              onClick={() => void (isWallet ? signInWithWallet(p) : startOauth(p))}
            >
              <ProviderMark provider={p} />
              <span className="ssoLabel">
                {pending ? (isWallet ? WALLET_LABEL[stage] : 'Redirecting…') : label}
              </span>
            </button>
          );
        })}
      </div>

      {error && <div className="admin-error">{error}</div>}

      {/* The divider introduces a form this component does NOT render — the caller
          supplies it. So a caller that omits the password fields must be able to
          omit the divider too, or the card ends on "or use your email" with
          nothing beneath it. /link-account hides the form for an account that has
          no password. */}
      {emailFormBelow === false ? null : (
        <div className="authDivider">
          {mode === 'signup' ? 'or sign up with email' : 'or use your email'}
        </div>
      )}
    </>
  );
}

/**
 * A glyph where we genuinely have the mark, a plain monogram otherwise. We do
 * not dress a provider up in a look-alike logo it doesn't own.
 */
function ProviderMark({ provider }: { provider: AuthProvider }) {
  if (provider.kind === 'wallet') return <Wallet size={15} />;
  if (provider.id === 'github') return <Github size={15} />;
  return <span className="ssoMark">{(provider.label || provider.id).slice(0, 1).toUpperCase()}</span>;
}
