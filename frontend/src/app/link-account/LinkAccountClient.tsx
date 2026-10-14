'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthShell } from '../../components/AuthShell';
import { PasswordSignInFields, usePasswordSignIn } from '../../components/auth/PasswordSignIn';
import { SsoPanel } from '../../components/auth/SsoPanel';
import { useWallet } from '../../components/providers/WalletProvider';
import {
  clearPortalToken,
  getPortalToken,
  httpStatus,
  portalApi,
  type PendingLinkDescription,
} from '../../lib/portal-api';
import {
  clearPendingLink,
  readOpaqueToken,
  readPendingLink,
  readSlug,
  rememberPendingLink,
  safeReturnTo,
} from '../../lib/sso';

/**
 * "Sign in to connect" — the fork a colliding SSO address opens instead of the
 * dead end it used to be.
 *
 * The backend refuses to attach a provider to an existing account on the
 * provider's word alone, and that refusal is not negotiable: signup is open and
 * unauthenticated, so anyone can register victim@corp.com, and a silent merge
 * would pull the victim's genuine Google sign-in into the attacker's account.
 * This page does not soften that rule — it satisfies the SECOND half of it. The
 * provider proved the address; here a human proves they hold the account that
 * already uses it, by signing into it. Only then is the identity attached, and
 * only ever to the account the server itself picked out when the collision
 * happened.
 *
 * Three things follow from that, and all three are load-bearing:
 *  - the masked address is rendered ONLY from the server's description of the
 *    token, never from a query param — a crafted link carrying an arbitrary
 *    address would be a phishing lure hosted on our own domain;
 *  - the link is never made on page load, only behind an explicit press. A
 *    one-click silent merge from a link someone was sent is precisely the
 *    forced-linking shape the binder cookie exists to prevent;
 *  - a session that is not the target account is refused by the server. This
 *    page pre-empts the obvious case, but it never decides — it only avoids
 *    spending a single-use token on an attempt that cannot succeed.
 */

type Phase = 'loading' | 'ready' | 'linked' | 'dead';

interface Failure {
  /** 'missing' no token at all · 'expired' the server disowned it · 'denied'
   *  wrong account · 'failed' anything else, with the server's own words. */
  reason: 'missing' | 'expired' | 'denied' | 'failed';
  message?: string;
  /**
   * Only ever true for a failure that has NOT spent the token — a request that
   * never reached the service. It drives the copy as well as the button: telling
   * someone the link "is no longer valid" when it is, in fact, still valid sends
   * them off to redo a round trip they did not need.
   */
  retryable?: boolean;
}

type Session =
  | { kind: 'checking' }
  | { kind: 'out' }
  /**
   * `address` is the signed-in account's own email; `known` is false when the
   * profile read failed with a session still in place — a suspended account
   * answers 403 there. Unknown must never be read as "somebody else": telling a
   * suspended customer to go and sign in as themselves is a loop.
   */
  | { kind: 'in'; address: string | null; known: boolean };

async function readSession(): Promise<Session> {
  if (!getPortalToken()) return { kind: 'out' };
  try {
    const customer = await portalApi.me();
    return { kind: 'in', address: customer.email ?? null, known: true };
  } catch {
    // A 401 CLEARED the token on the way through, so re-read rather than assume:
    // no token left means there is genuinely no session to connect anything to.
    return getPortalToken() ? { kind: 'in', address: null, known: false } : { kind: 'out' };
  }
}

/**
 * Could the signed-in account be the one holding the masked address?
 *
 * ADVISORY ONLY. The server owns this decision and re-makes it against the
 * target id inside the token; this exists so that an obviously-wrong session is
 * told so while the token is still LIVE, instead of burning it on a 403 the
 * ceremony cannot recover from. It therefore fails towards "yes" — an
 * unparseable mask, an unreadable profile, a one-character local part that
 * masks away to nothing — and only says no on positive evidence: a different
 * domain, a different initial, or an account with no address at all.
 *
 * Only the domain and the leading character are compared, never the whole
 * string: the filler between them is the server's own presentation choice and
 * nothing here should break when it changes.
 */
function couldOwn(maskedEmail: string, session: Session): boolean {
  if (session.kind !== 'in') return false;
  if (!session.known) return true;
  if (!session.address) return false;

  const maskedAt = maskedEmail.lastIndexOf('@');
  const mineAt = session.address.lastIndexOf('@');
  if (maskedAt < 1 || mineAt < 1) return true;
  if (maskedEmail.slice(maskedAt + 1).toLowerCase() !== session.address.slice(mineAt + 1).toLowerCase()) {
    return false;
  }
  const mine = session.address.slice(0, mineAt).toLowerCase();
  const initial = maskedEmail.slice(0, 1).toLowerCase();
  // A one-character local part must not round-trip to the whole address, so the
  // server masks it away entirely and there is no initial left to compare.
  if (!/^[a-z0-9]$/.test(initial)) return true;
  if (initial !== mine.slice(0, 1)) return false;

  // The LAST character too, which is the difference between advice and
  // decoration: two accounts at the same provider routinely share an initial
  // and a domain. `kbrown@example.com` and `kyle.green222@example.com` both
  // passed the initial-and-domain test, so this screen cheerfully offered a
  // confirm button that could only ever 403 — and did, repeatedly, to somebody
  // who had signed in with a provider belonging to the OTHER account. The
  // server's mask now carries a final character precisely so this can be read.
  const final = maskedEmail.slice(maskedAt - 1, maskedAt).toLowerCase();
  if (!/^[a-z0-9]$/.test(final) || mine.length < 2) return true;
  return final === mine.slice(-1);
}

/**
 * NAME THE METHOD. The single most useful sentence on this page.
 *
 * "Sign in to connect your Google account" does not say sign in HOW, and the
 * buttons above it used to include providers that cannot work — so the honest
 * reading of the old page was "press something and hope". Account-linking
 * conventions (Auth0, Okta, every major identity product) all resolve this the
 * same way: state which method the EXISTING account uses, before offering it.
 *
 * Four cases, and the fourth is the one worth being blunt about: an account whose
 * only identity is the provider now colliding has no other way in at all, and
 * saying so beats leaving somebody to discover it one dead button at a time.
 */
function SignInMethodNotice({
  methods,
  label,
}: {
  methods?: PendingLinkDescription['signInMethods'];
  label: string;
}) {
  // Still loading the descriptor — say nothing rather than guess.
  if (!methods) return null;

  const names = methods.providers.map((p) => p.label);
  const provider = label || 'this provider';
  const how = methods.password
    ? names.length > 0
      ? `your password or ${listOf(names)}`
      : 'your email and password'
    : names.length > 0
      ? listOf(names)
      : null;

  if (!how) {
    return (
      <p className="authCallout authCalloutStuck">
        <strong>This account has no other way to sign in.</strong> It was created with{' '}
        {provider}, so there is nothing here to prove you own it. Contact support and we will
        connect it for you.
      </p>
    );
  }

  return (
    <p className="authCallout">
      <strong>Sign in with {how}</strong> — that is what this account uses. Once you are in, we
      will connect {provider} to it.
    </p>
  );
}

/** `A`, `A or B`, `A, B or C`. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

export function LinkAccountClient() {
  const router = useRouter();
  const params = useSearchParams();
  const urlToken = readOpaqueToken(params?.get('token'));
  const urlProvider = readSlug(params?.get('provider'));
  const { disconnect: disconnectWallet } = useWallet();

  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [link, setLink] = useState<PendingLinkDescription | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session>({ kind: 'checking' });

  // Sequence guard: a manual refresh can overlap the one on mount, and the
  // slower answer must not overwrite the newer one.
  const sessionRun = useRef(0);
  const refreshSession = useCallback(async () => {
    const id = ++sessionRun.current;
    const next = await readSession();
    if (sessionRun.current === id) setSession(next);
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // The URL wins over the mirror: a freshly issued ceremony must beat the copy
  // an abandoned one left in this tab.
  useEffect(() => {
    const carried = urlToken || readPendingLink();
    if (!carried) {
      setFailure({ reason: 'missing' });
      setPhase('dead');
      return;
    }
    if (urlToken) rememberPendingLink(urlToken);
    setToken(carried);
  }, [urlToken]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    // A PEEK — this call does not consume the token, so a reload, StrictMode's
    // double invoke and the sign-in that lands back here are all free.
    portalApi
      .describePendingLink(token)
      .then((described) => {
        if (!live) return;
        setLink(described);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (!live) return;
        // Unknown, expired and binder-mismatch are ONE 404 by design — there is
        // nothing to tell apart, so there is nothing to say beyond "gone".
        if (httpStatus(err) === 404) {
          clearPendingLink();
          setFailure({ reason: 'expired' });
        } else {
          // A blip, not a verdict: the token is untouched, so keep the mirror.
          setFailure({
            reason: 'failed',
            message: err instanceof Error ? err.message : 'We could not check that link.',
            retryable: true,
          });
        }
        setPhase('dead');
      });
    return () => {
      live = false;
    };
  }, [token, attempt]);

  const signIn = usePasswordSignIn(() => void refreshSession());

  async function confirmLink() {
    setBusy(true);
    try {
      await portalApi.completePendingLink(token);
      clearPendingLink();
      setPhase('linked');
      router.replace('/portal');
    } catch (err) {
      const status = httpStatus(err);
      // WHICH REJECTIONS LEFT THE TOKEN ALIVE. The service spends it atomically
      // immediately before the write, so only a rejection from at-or-after that
      // point is terminal — 404 (already gone) and 409 (the provider account got
      // attached elsewhere first). Everything else leaves a completable ceremony,
      // and discarding it would cost a whole fresh provider round trip:
      //  - no status at all — the request never left the browser (a dropped
      //    connection, a backend restart, an abort);
      //  - 401 — `CustomerJwtGuard` refusing before the handler runs, i.e. the
      //    session expired while the page sat open;
      //  - 403 — signed in to the WRONG account. This is the ordinary mistake
      //    the whole screen exists to walk somebody out of: the ownership check
      //    now runs BEFORE the token is spent, so switching accounts and coming
      //    back completes this same link. Burning it here was the old behaviour
      //    and it stranded the one person entitled to finish.
      const untouched = status === null || status === 401 || status === 403;
      if (!untouched) clearPendingLink();
      setBusy(false);
      setFailure({
        reason: status === 403 ? 'denied' : 'failed',
        message: err instanceof Error ? err.message : 'That connection could not be completed.',
        retryable: untouched,
      });
      setPhase('dead');
    }
  }

  /**
   * Ends the session without leaving the ceremony. The token is still live, so
   * the page simply falls back to its signed-out step and offers the ways in
   * again.
   *
   * The wallet teardown matters for the same reason it does in the portal's own
   * sign-out (see app/portal/PortalShell.tsx): Web3-Onboard keeps the connected
   * wallet attached, and without detaching it the next wallet press goes
   * straight to a signature for the account we just left.
   */
  async function signOutHere() {
    setBusy(true);
    try {
      await disconnectWallet();
    } catch {
      /* a wallet that misbehaves on teardown must not trap anyone in a session */
    }
    clearPortalToken();
    setSession({ kind: 'out' });
    setBusy(false);
  }

  async function signOutAndLeave() {
    setBusy(true);
    try {
      await disconnectWallet();
    } catch {
      /* as above */
    }
    clearPortalToken();
    router.replace('/login');
  }

  function abandon() {
    // An explicit decline: drop the carrier so a later visit to this route is
    // not offered a ceremony nobody asked for again.
    clearPendingLink();
    router.replace('/portal');
  }

  // The server's label, with the URL slug as a last resort only — caller-supplied
  // text has no place in a sentence asking someone to trust this page.
  const label = link ? link.providerLabel || link.provider || urlProvider : '';
  const masked = link?.maskedEmail ?? '';
  const owns = link ? couldOwn(masked, session) : false;

  const view =
    phase === 'loading' || (phase === 'ready' && session.kind === 'checking')
      ? 'loading'
      : phase === 'dead'
        ? 'dead'
        : phase === 'linked'
          ? 'linked'
          : session.kind === 'out'
            ? 'signin'
            : owns
              ? 'confirm'
              : 'wrong';

  // Back here after a provider round trip. The token is not in the URL by then
  // — the mirror is what carries it — so it is pinned to the returnTo as well,
  // which restores the address bar for anyone who reloads or bookmarks.
  //
  // Built here rather than taken from a caller, and `token` is already through
  // `readOpaqueToken` (base64url, <=256 chars), so this string cannot be hostile.
  // It still goes through `safeReturnTo`: EVERY value handed to SsoPanel meets
  // the sanitiser, with no "this one is fine" exceptions to audit later.
  const returnTo = safeReturnTo(`/link-account?token=${encodeURIComponent(token)}`);

  const HEADINGS: Record<typeof view, { title: string; subtitle: React.ReactNode }> = {
    loading: { title: 'One moment', subtitle: 'Checking that connection link.' },
    signin: {
      title: label ? `Connect your ${label} account` : 'Connect your account',
      subtitle: (
        <>
          You already have an account for <span className="mono">{masked}</span>. Sign in to connect
          your {label || 'provider'} account to it.
        </>
      ),
    },
    confirm: {
      title: label ? `Connect ${label}?` : 'Connect this provider?',
      subtitle:
        session.kind === 'in' && session.address
          ? `Signed in as ${session.address}.`
          : 'You are signed in.',
    },
    wrong: {
      title: 'This is a different account',
      // BOTH sides, always. Naming only the target left somebody who had signed
      // in with a provider belonging to their OTHER account reading "sign in to
      // the account that uses that address" while believing they already had —
      // the missing half was WHICH account they were actually in. The signed-in
      // address is theirs and they just authenticated as it, so there is nothing
      // to withhold; the target stays masked, as everywhere else on this page.
      subtitle:
        session.kind === 'in' && session.address ? (
          <>
            You are signed in as <span className="mono">{session.address}</span>, but this connection
            is waiting for <span className="mono">{masked}</span>.
          </>
        ) : (
          <>
            The connection is waiting for the account that uses <span className="mono">{masked}</span>
            .
          </>
        ),
    },
    linked: { title: 'Connected', subtitle: 'Taking you to your dashboard.' },
    dead: {
      // `retryable` is checked FIRST: the link is still live in that case, and
      // calling it invalid is both untrue and an instruction to go and repeat a
      // provider round trip for nothing.
      title: failure?.retryable
        ? "That didn't go through"
        : failure?.reason === 'denied'
          ? "That connection didn't go through"
          : failure?.reason === 'missing'
            ? 'Nothing to finish here'
            : 'That connection link is no longer valid',
      subtitle:
        failure?.reason === 'missing'
          ? 'This page is the last step of connecting a provider to an account you already have.'
          : failure?.retryable
            ? 'Nothing was changed, and the link is still good.'
            : 'Nothing was changed on either account.',
    },
  };

  return (
    <AuthShell
      title={HEADINGS[view].title}
      subtitle={HEADINGS[view].subtitle}
      // Only the signed-out step submits anything; AuthShell makes the card the
      // <form> so the password fields lay out with the card's own gap.
      onSubmit={view === 'signin' ? signIn.submit : undefined}
      footer={
        <>
          Trouble connecting? <Link href="/pricing">Read about plans</Link>
        </>
      }
    >
      <>
        {view === 'loading' && (
          <div className="skeletonRows" aria-busy="true">
            <div className="skeletonRow" />
          </div>
        )}

        {view === 'signin' && (
          <>
            {/* Every way in, not just the one we happen to prefer — the account
                on the other side of this collision may have no password at all,
                and an already-connected provider is the commonest way back into
                it. `returnTo` comes back here because a provider sign-in leaves
                the origin entirely; a password sign-in never leaves the page.

                That round trip used to destroy the ceremony: it overwrites the
                OAuth binder cookie on the way out and the handoff exchange
                deletes it on the way back. The pending link now has a binder
                cookie of its own (`sso_link_binder`, planted by the callback),
                so these buttons finish the ceremony instead of ending it — see
                LINK_BINDER_COOKIE in the backend's oauth-state.service.ts.

                An ALLOW-LIST, not a hide-one. Hiding only the colliding provider
                still offered every other configured one, and on this page each of
                those collides on the same address and mints a FRESH ceremony — so
                the buttons flipped the heading between providers forever with no
                error anywhere. `signInMethods.providers` holds only identities
                already attached to the target, i.e. the ones that reach rule (a)
                and actually sign the customer in. */}
            <SignInMethodNotice methods={link?.signInMethods} label={label} />
            <SsoPanel
              mode="signin"
              returnTo={returnTo}
              onlyProviders={link ? link.signInMethods.providers.map((p) => p.id) : null}
              hideProvider={link?.provider ?? urlProvider}
              // No form below when the account has no password, so no divider
              // introducing one — see `emailFormBelow`.
              emailFormBelow={link ? link.signInMethods.password : true}
              onSignedIn={() => void refreshSession()}
            />
            {/* The password form is offered only when the account HAS a password.
                Rendering it regardless invited an attempt that can only fail, and
                its "Forgot your password?" link is worse than useless here: the
                ceremony's target is by definition unverified (that is what sent it
                down this path), and `requestPasswordReset` refuses an account with
                no `emailVerifiedAt` — silently, with a 202 that reads as sent. */}
            {link && !link.signInMethods.password ? null : (
              <PasswordSignInFields state={signIn} />
            )}
          </>
        )}

        {view === 'confirm' && (
          <>
            <span className="admin-note" style={{ margin: 0 }}>
              {label ? `Connecting ${label}` : 'Connecting this provider'} adds it as another way to
              sign in. Your plan, keys and usage are untouched.
            </span>
            {/* Explicit press, never on load: this page can be reached from a
                link somebody else sent, and a merge that happens just because a
                URL was opened is the forced-linking shape the binder exists to
                stop. */}
            <button className="admin-btn" type="button" disabled={busy} onClick={() => void confirmLink()}>
              {busy ? 'Connecting…' : label ? `Connect ${label}` : 'Connect'}
            </button>
            <button className="admin-btn ghost" type="button" disabled={busy} onClick={abandon}>
              Not now
            </button>
          </>
        )}

        {view === 'wrong' && (
          <>
            <span className="admin-note" style={{ margin: 0 }}>
              {session.kind === 'in' && session.address
                ? `You are signed in as ${session.address}, which is not that account. `
                : 'The session in this browser is a different account. '}
              Sign out and sign in as the one that uses that address to finish connecting
              {label ? ` ${label}` : ''}.
            </span>
            <button className="admin-btn" type="button" disabled={busy} onClick={() => void signOutHere()}>
              {busy ? 'Signing out…' : 'Sign out and come back here'}
            </button>
            <Link className="admin-btn ghost" href="/portal" style={{ textAlign: 'center' }}>
              Go to your dashboard
            </Link>
          </>
        )}

        {view === 'linked' && (
          <div className="admin-ok">
            {label ? `${label} is now connected to your account.` : 'That provider is now connected.'}
          </div>
        )}

        {view === 'dead' && (
          <>
            {failure?.message && <div className="admin-error">{failure.message}</div>}

            {failure?.reason === 'denied' && (
              <span className="admin-note" style={{ margin: 0 }}>
                {session.kind === 'in' && session.address ? (
                  <>
                    You are signed in as <span className="mono">{session.address}</span>, and a
                    provider can only be connected by the account that already uses its address.{' '}
                  </>
                ) : (
                  'A provider can only be connected by the account that already uses its address. '
                )}
                {/* Naming the email form specifically, because the buttons above it are the
                    trap: another provider or a wallet signs you in as whichever account IT
                    is attached to, which may be a different one entirely — exactly how this
                    screen gets reached. */}
                Sign out below and sign back in as{' '}
                <span className="mono">{masked || 'that account'}</span> — with its email and
                password if its other sign-in methods belong elsewhere. This same step then
                finishes; {label ? `the ${label} ` : 'the provider '}sign-in does not have to be
                repeated.
              </span>
            )}

            {failure?.reason === 'expired' && (
              <span className="admin-note" style={{ margin: 0 }}>
                These links last ten minutes and work once, in the browser that started them. Start the
                sign-in again and a fresh one is offered.
              </span>
            )}

            {failure?.reason === 'missing' && (
              <span className="admin-note" style={{ margin: 0 }}>
                Start from the sign-in page and pick a provider there.
              </span>
            )}

            {failure?.retryable && (
              <button
                className="admin-btn"
                type="button"
                onClick={() => {
                  setFailure(null);
                  setPhase('loading');
                  setAttempt((n) => n + 1);
                  // The session may be what expired — a 401 from the completion
                  // route is the guard, not the ceremony — so re-read it rather
                  // than dropping back onto a confirm step that will 401 again.
                  void refreshSession();
                }}
              >
                Try again
              </button>
            )}

            {/* The way out has to suit the session that is actually here: a
                signed-in visitor sent to /login is bounced straight back to the
                dashboard by the signed-out guard, which reads as the page
                ignoring the press. */}
            {failure?.reason === 'denied' && session.kind === 'in' ? (
              <button
                className="admin-btn"
                type="button"
                disabled={busy}
                onClick={() => void signOutAndLeave()}
              >
                {busy ? 'Signing out…' : 'Sign out and sign in again'}
              </button>
            ) : session.kind === 'in' ? (
              <Link className="admin-btn ghost" href="/portal" style={{ textAlign: 'center' }}>
                Go to your dashboard
              </Link>
            ) : (
              <Link className="admin-btn ghost" href="/login" style={{ textAlign: 'center' }}>
                Back to sign in
              </Link>
            )}
          </>
        )}
      </>
    </AuthShell>
  );
}
