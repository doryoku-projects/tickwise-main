'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AuthShell } from '../../components/AuthShell';
import { PasswordField } from '../../components/auth/PasswordField';
import { clearPortalToken, httpStatus, portalApi } from '../../lib/portal-api';
import { readOpaqueToken } from '../../lib/sso';

/**
 * The last step of a password reset: the page the emailed link opens.
 *
 * It is reached SIGNED OUT by definition — not being able to get in is what the
 * link is for — and the `?token=` it arrives with is a bearer credential that
 * outranks the password: spend it and you own the account. Three things follow,
 * and all three are load-bearing:
 *
 *  - the token is lifted into component state and struck out of the URL on
 *    mount, so the address bar stops being a place it can be read from;
 *  - a failure the SERVICE answered is terminal. The backend consumes the token
 *    atomically before it judges anything about it (see `resetPassword` in
 *    customer-auth.service.ts), so there is no "try that again" here — the only
 *    recovery is a fresh link;
 *  - expired, unknown and already-spent come back as ONE error on purpose, and
 *    this page must not invent a distinction the server refuses to draw. Telling
 *    a caller a token was real but expired confirms that the token they hold —
 *    out of a log, a `Referer`, a forwarded email — belongs to a live account,
 *    which is the fact the uniform 202 on /forgot-password exists to withhold.
 *
 * No session is minted here and none is faked. The reset proves control of a
 * mailbox; signing in afterwards is the design, not a missing step.
 */

type Phase = 'loading' | 'form' | 'saved' | 'dead';

interface Failure {
  /**
   * 'missing' — no token in the URL at all: somebody opened /reset-password
   *   directly, or reloaded after the token was struck out of the address bar.
   * 'spent'   — the service answered, so the token is gone whatever it said.
   * 'account' — the service refused the ACCOUNT rather than the link (403, a
   *   suspension). Distinguishable on purpose, and it needs its own way out.
   */
  reason: 'missing' | 'spent' | 'account';
  /** The server's own words, when they carry something this page cannot know. */
  message?: string;
}

export function ResetPasswordClient() {
  const params = useSearchParams();

  const [token, setToken] = useState('');
  const [phase, setPhase] = useState<Phase>('loading');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * ONE-SHOT, and it is a guard rather than an optimisation. The effect below
   * rewrites the URL, so a second run would read a query string it had already
   * emptied and conclude there was never a token — wiping a live one out of
   * state and dropping a customer mid-form onto "request a new link". React's
   * StrictMode double-invoke in development does exactly that.
   */
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;
    decided.current = true;

    // Shape-filtered before it is touched, the same way every other opaque
    // server-minted token off a query string is (`readOpaqueToken` is base64url,
    // 256 chars at most — which is what `randomBytes(32).toString('base64url')`
    // produces). This says nothing about whether the token is VALID; only the
    // server can say that. It keeps garbage from being sent and from being
    // rendered back into a URL.
    const carried = readOpaqueToken(params?.get('token'));
    if (!carried) {
      setFailure({ reason: 'missing' });
      setPhase('dead');
      return;
    }
    setToken(carried);
    setPhase('form');

    /**
     * STRIKE THE TOKEN OUT OF THE URL.
     *
     * `replaceState` OVERWRITES the current history entry instead of adding one,
     * so the token-bearing URL is not left behind for the back button, for a
     * screenshot or a shared screen, or for the `Referer` of anything this page
     * loads or navigates to from here on.
     *
     * What it deliberately does NOT do, so nobody builds on more than it gives:
     * it cannot reach the copies already made — the email itself, the `Referer`
     * the arriving navigation already sent, whatever the edge logged when it
     * served this page. Those are what the 30-minute TTL and the single use are
     * for. This only stops the URL accruing new ones.
     *
     * The existing `history.state` is passed through rather than nulled: the App
     * Router keeps its own routing data in there, and replacing it with null
     * breaks back navigation out of this page.
     *
     * The cost, stated rather than discovered: a RELOAD now lands on the
     * "missing" state instead of a live form, because state is the only copy.
     * Mirroring it into sessionStorage the way the pending-link ceremony does
     * would fix that, and is the wrong trade here — it would leave a second,
     * longer-lived copy of a full account credential readable by any same-origin
     * script, to save a round trip on a link that is single-use anyway.
     */
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    } catch {
      /* the token is already in state, so a browser that refuses replaceState
         still has a working form — this is hygiene, not a precondition */
    }
  }, [params]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');

    // Checked HERE, and it has to be checked BEFORE the call: the confirmation
    // field never leaves the browser, so nothing downstream can catch a typo —
    // and sending the request spends the token, so a mismatch discovered after
    // it would cost the customer the whole link for a slip they could see.
    if (password !== confirm) {
      setError('Those passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await portalApi.resetPassword(token, password);
      // Every session for this account was just evicted server-side — the reset
      // stamps `passwordChangedAt` and `CustomerJwtGuard` compares it against
      // every token's `iat` — so a `tk-portal-token` still sitting in this
      // browser is already a corpse. Dropping it here stops a stale one
      // rendering a signed-in dashboard for however long it takes the next
      // request to come back 401.
      clearPortalToken();
      setPhase('saved');
    } catch (err) {
      const status = httpStatus(err);
      if (status === null) {
        // No status at all: most likely the request never left the browser, in
        // which case the token is untouched and this form is still worth
        // submitting. Stated as a likelihood and not a fact — `httpStatus` null
        // is a PROXY for "never arrived", not proof of it, and a request that
        // did arrive with its response lost on the way back looks identical from
        // here. Keeping the form is still the right call: if the token was in
        // fact spent, the retry answers "invalid" and lands on the fresh-link
        // state below, which is where it would have landed anyway.
        setError(err instanceof Error ? err.message : 'That did not go through. Try again.');
        setBusy(false);
        return;
      }
      setBusy(false);
      // The service answered, so the token is GONE — it is consumed atomically
      // before expiry, account state or anything else about it is judged, which
      // means even a rejection is a spend. Never offer to resubmit this form
      // from here: the link behind it cannot be spent twice, and inviting a
      // retry is inviting a dead end.
      //
      // Every answered status is treated the same way, including a 500 and
      // including a 400 from the validation pipe (which fires BEFORE the token
      // is consumed, so it does leave one live). That is the safe direction:
      // sending someone for a fresh link always works, whereas telling them a
      // spent link still works strands them. The server's message is carried
      // through so a rejection this page cannot interpret — a password the
      // policy refuses, say — is still readable rather than swallowed.
      const message = err instanceof Error ? err.message : '';
      setFailure(status === 403 ? { reason: 'account', message } : { reason: 'spent', message });
      setPhase('dead');
    }
  }

  const HEADINGS: Record<Phase, { title: string; subtitle: React.ReactNode }> = {
    loading: { title: 'One moment', subtitle: 'Checking that reset link.' },
    form: {
      title: 'Choose a new password',
      subtitle: 'Setting it ends every signed-in session, including this one.',
    },
    saved: { title: 'Password changed', subtitle: 'Sign in with the new one.' },
    dead: {
      title:
        failure?.reason === 'missing'
          ? 'Nothing to reset here'
          : failure?.reason === 'account'
            ? 'This account cannot be reset'
            : 'Start the reset again',
      // Never a word about WHICH of expired, unknown or already-used it was —
      // the server refuses to say, and guessing on its behalf would rebuild the
      // oracle it is refusing to be. "Works once" is true of all three and
      // points at the only recovery there is.
      subtitle:
        failure?.reason === 'missing'
          ? 'This page is the last step of a password reset, and it needs the link from the email.'
          : failure?.reason === 'account'
            ? 'Your password has not been changed.'
            : 'A password reset link works once, so this one is finished with.',
    },
  };

  return (
    <AuthShell
      title={HEADINGS[phase].title}
      subtitle={HEADINGS[phase].subtitle}
      // Only the form step submits anything; AuthShell makes the card itself the
      // <form> so the password fields lay out with the card's own gap.
      onSubmit={phase === 'form' ? (e) => void run(e) : undefined}
      footer={
        phase === 'saved' ? undefined : (
          <>
            Remembered it? <Link href="/login">Sign in</Link>
          </>
        )
      }
    >
      <>
        {phase === 'loading' && (
          <div className="skeletonRows" aria-busy="true">
            <div className="skeletonRow" />
          </div>
        )}

        {phase === 'form' && (
          <>
            <PasswordField
              autoComplete="new-password"
              placeholder="New password"
              value={password}
              onChange={setPassword}
            />
            <PasswordField
              autoComplete="new-password"
              placeholder="Confirm new password"
              value={confirm}
              onChange={setConfirm}
            />
            {error && <div className="admin-error">{error}</div>}
            <button className="admin-btn" type="submit" disabled={busy || !password || !confirm}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
          </>
        )}

        {phase === 'saved' && (
          <>
            {/* "Every session", never "everywhere". The stamp this reset writes is
                read by the portal guard alone — API keys resolve against their own
                status and survive it. Someone recovering from a compromise must not
                read this as "the attacker is out". */}
            <div className="admin-ok">
              Your password was changed and every signed-in session has ended, so sign in again with
              the new one. API keys are not affected — if you did not expect this reset, review them
              once you are back in.
            </div>
            {/* A plain link, and no session manufactured from the reset: the API
                deliberately returns none, so signing in is the next step rather
                than a bug to paper over. */}
            <Link className="admin-btn" href="/login" style={{ textAlign: 'center' }}>
              Sign in
            </Link>
          </>
        )}

        {phase === 'dead' && (
          <>
            {failure?.message && <div className="admin-error">{failure.message}</div>}

            {failure?.reason === 'account' ? (
              <>
                {/* NO fresh-link button on this branch, deliberately. A
                    suspended account is refused by /forgot-password too — and
                    refused SILENTLY, because that route answers everything the
                    same way — so the button would send somebody off to wait for
                    an email that is never coming, over and over. This is the one
                    failure here that is genuinely about the account rather than
                    the link, and the only honest next step is a human. */}
                <span className="admin-note" style={{ margin: 0 }}>
                  A new link would not help — the block is on the account, not on the link you used.
                </span>
                <Link className="admin-btn ghost" href="/login" style={{ textAlign: 'center' }}>
                  Back to sign in
                </Link>
              </>
            ) : (
              <>
                {/* Deliberately does NOT promise an email will arrive. This copy
                    also serves the 'missing' case, where the visitor may have no
                    account at all — and /forgot-password answers identically
                    either way precisely so this page cannot become the oracle
                    that route refuses to be. Describe the ACTION, never the
                    outcome. */}
                <span className="admin-note" style={{ margin: 0 }}>
                  Ask for a fresh link from the forgot-password page. Requesting one also cancels any
                  earlier link, so use the newest email you receive.
                </span>
                <Link className="admin-btn" href="/forgot-password" style={{ textAlign: 'center' }}>
                  Email me a new link
                </Link>
                <Link className="admin-btn ghost" href="/login" style={{ textAlign: 'center' }}>
                  Back to sign in
                </Link>
              </>
            )}
          </>
        )}
      </>
    </AuthShell>
  );
}
