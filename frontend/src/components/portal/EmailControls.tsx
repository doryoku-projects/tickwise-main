'use client';

import { useEffect, useState } from 'react';
import { markOtpIssued, useOtpCooldown } from '../../lib/otp-cooldown';
import { portalApi, type AccountOverview, type Customer } from '../../lib/portal-api';
import { OtpForm } from '../auth/OtpForm';

/**
 * Where the code actually is, in development.
 *
 * There is NO mail transport. In a dev build the backend prints the code
 * instead, so a tester staring at an empty inbox needs to be pointed at the
 * server console rather than left to conclude the flow is broken. Stripped from
 * production builds — `process.env.NODE_ENV` is inlined at build time, so the
 * branch and its copy both disappear there. It must never render in production:
 * it would be advertising a delivery channel real customers cannot read.
 */
export function DevCodeHint() {
  if (process.env.NODE_ENV === 'production') return null;
  return (
    <p className="admin-note" style={{ margin: 0 }}>
      Development build — no mail is sent. The backend logs the code to its console:{' '}
      <span className="mono">[dev] Email verification code for you@example.com: 424242</span>
    </p>
  );
}

/**
 * Claim an address for the account (PATCH /account/profile).
 *
 * This is the ONLY way a wallet-only account gets an email, so it has to be a
 * real form and not a "contact support" line.
 *
 * Submitting does NOT set the address — the server stages it as `pendingEmail`
 * and mints a code, and it becomes the account address only once that code is
 * entered. Nothing here may say "saved" or "updated", because nothing was: the
 * honest report is the pending notice the caller renders from `onStaged`.
 */
export function EmailAddressForm({
  currentEmail,
  pendingEmail,
  onStaged,
}: {
  currentEmail?: string | null;
  /** A claim already outstanding, which changes what the form should promise. */
  pendingEmail?: string | null;
  /** Receives the address the SERVER staged (normalised), not what was typed. */
  onStaged: (pending: string) => void | Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setError('');
    setBusy(true);
    try {
      const { customer } = await portalApi.updateProfile({ email: value });
      // The server's normalisation (trim + lowercase) is what got stored and
      // what the code was issued against, so echo THAT back, not the raw input.
      // The fallback only covers a server that stopped returning the field.
      const staged = customer.pendingEmail ?? value.toLowerCase();
      // Staging IS a mint — the PATCH issued a code and spent from the same
      // 5-per-hour budget the resend draws on. Arm the cooldown here, against
      // the address the server stored, so the pending notice about to appear
      // comes up already counting down instead of offering a button that would
      // re-mint a code the person is already holding. Only on success: a
      // rejected claim produced no code and must not lock anyone out of asking.
      markOtpIssued(staged);
      setEmail('');
      await onStaged(staged);
    } catch (err) {
      // Verbatim. A 409 here means another customer holds the address, and the
      // server says so in its own words — paraphrasing it would be guesswork
      // about a conflict only the server can see.
      setError((err instanceof Error && err.message) || 'A code could not be issued for that address.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="emailForm" onSubmit={submit}>
      <div className="emailFormRow">
        <input
          className="admin-input"
          type="email"
          required
          autoComplete="email"
          placeholder={currentEmail ? 'New email address' : 'Email address'}
          aria-label={currentEmail ? 'New email address' : 'Email address'}
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="admin-btn" type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Requesting…' : currentEmail ? 'Change email' : 'Add email'}
        </button>
      </div>
      {error && <div className="admin-error">{error}</div>}
      <p className="admin-note" style={{ margin: 0 }}>
        {pendingEmail
          ? 'Mistyped it? Submit the address you meant and we will issue a code for that one instead — the old claim is dropped.'
          : 'This does not set the address yet. We issue a 6-digit code for it, and it becomes your account email only once you enter that code.'}
      </p>
    </form>
  );
}

/**
 * The one control that asks for a code, wherever a code can be asked for.
 *
 * Every button that mints a code shares a single server budget, so they share a
 * single cooldown: `useOtpCooldown` derives it from WHEN the last code for this
 * address was issued, which means this renders mid-countdown when it mounts
 * after a mint that happened somewhere else — a signup, a staged claim, another
 * tab — and enabled when the last one has aged out. Three hand-rolled timers is
 * how the previous version ended up with a button that was live the instant a
 * code landed.
 *
 * `issue` is passed in because "mint a code" is two different endpoints: a
 * pending claim is re-minted by re-staging it (`PATCH /account/profile`), while
 * an unproved SIGNUP address goes through `resend-verification`, which no-ops
 * on a claim. Wording differs with it, so the caller owns both.
 */
export function ResendCodeControl({
  /** The address the code goes to — the cooldown bucket. Omit when unknown. */
  address,
  issue,
  idleLabel,
  successNotice,
  undeliveredNotice,
  errorFallback,
  className = 'admin-btn ghost sm',
}: {
  address?: string | null;
  /**
   * Must RESOLVE only when a code was really issued — see the catch below.
   *
   * Resolving with `{ delivered: false }` means issued but NOT sent: the mail
   * provider refused it. That is not an exception (the code is valid and stored)
   * and it is not a success either, so it gets its own message.
   */
  issue: () => Promise<{ delivered?: boolean } | unknown>;
  idleLabel: string;
  successNotice: string;
  /** Shown when the code was issued but the mail provider would not take it. */
  undeliveredNotice: string;
  errorFallback: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { remaining, startNow } = useOtpCooldown(address);

  async function request() {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const result = (await issue()) as { delivered?: boolean } | undefined;
      // Only an EXPLICIT false is a delivery failure; undefined means the server
      // does not report delivery on this path, and claiming a problem then would
      // be worse than saying nothing.
      if (result?.delivered === false) {
        setError(undeliveredNotice);
      } else {
        setNotice(successNotice);
      }
      // AFTER the await, never before: a failed request minted nothing, and
      // starting the clock on it would leave someone with no code and no way to
      // ask for one for a minute.
      startNow();
    } catch (err) {
      // Verbatim. This shares the server's resend budget, so a 429 is its
      // sentence to write — we cannot know how much of the hour is left.
      setError((err instanceof Error && err.message) || errorFallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="admin-error">{error}</div>}
      {notice && <div className="admin-ok">{notice}</div>}
      <div className="admin-row">
        <button
          className={className}
          type="button"
          onClick={() => void request()}
          disabled={busy || remaining > 0}
        >
          {remaining > 0 ? `New code in ${remaining}s` : busy ? 'Requesting…' : idleLabel}
        </button>
        <span className="admin-note" style={{ margin: 0 }}>
          Codes expire — request a fresh one if yours stops working.
        </span>
      </div>
    </>
  );
}

/**
 * The same control, wired to the SIGNUP address's endpoint.
 *
 * `resend-verification` re-mints the code for the address already on the
 * account. It is the wrong call for a pending claim — it no-ops there — so a
 * claim gets `PendingEmailNotice` and its re-stage instead.
 *
 * Notice text is "issued", never "sent": there is no mail transport in this
 * deployment, and promising delivery is what leaves a tester watching an empty
 * inbox instead of reading `DevCodeHint`.
 */
export function SignupCodeResend({
  address,
  idleLabel = 'Send a new code',
  className,
}: {
  /** The account address the code goes to — the cooldown bucket. */
  address?: string | null;
  idleLabel?: string;
  className?: string;
}) {
  return (
    <ResendCodeControl
      address={address}
      issue={() => portalApi.resendVerification()}
      idleLabel={idleLabel}
      successNotice="A fresh code was issued. The previous one no longer works."
      undeliveredNotice={"The code was issued but our mail provider would not send it, so it has not reached your inbox. This is a fault on our side — contact support and we will sort it."}
      errorFallback="A code could not be issued."
      className={className}
    />
  );
}

/**
 * An address claimed but not yet proved: which one, where the code is, and the
 * input that finishes the job.
 *
 * Rendered from `customer.pendingEmail`, so it survives a reload and a fresh
 * sign-in — a claim someone walked away from must still be findable, and it is
 * also the state of an account half-way through CHANGING a verified address.
 *
 * The resend goes back through PATCH /account/profile rather than
 * `resend-verification`: re-staging the same address re-mints the code, whereas
 * `resend-verification` is the SIGNUP path — it no-ops when this deployment
 * does not require verification and again once `emailVerifiedAt` is set, so for
 * a pending claim it would be a button that silently does nothing.
 */
export function PendingEmailNotice({
  email,
  onVerified,
}: {
  email: string;
  onVerified: () => void | Promise<void>;
}) {
  return (
    <div className="emailPrompt">
      <div className="infoBanner">
        Waiting on the code for {email}
        <span>— it is not your account address until you enter it.</span>
      </div>
      {/* The form only SPENDS a code. Asking for another one is the control
          below, which re-stages the claim — the only thing that re-mints a code
          for a PENDING address. */}
      <OtpForm email={email} onVerified={onVerified} />
      <DevCodeHint />
      {/* Reaching this component MEANS a code exists for `email` — staging one
          mints it — so the control below opens mid-countdown off the timestamp
          `markOtpIssued` wrote, and reads 0 only once that code has aged. */}
      <ResendCodeControl
        address={email}
        issue={() => portalApi.updateProfile({ email })}
        idleLabel="Get a new code"
        // Only one code hash is stored, so a new one really does retire the old.
        successNotice="A new code was issued — the previous one no longer works."
        undeliveredNotice={"The code was issued but our mail provider would not send it, so it has not reached your inbox. This is a fault on our side — contact support and we will sort it."}
        errorFallback="A new code could not be issued."
      />
    </div>
  );
}

/**
 * The whole address story for one account: claim a new one, and finish whatever
 * step is outstanding.
 *
 * ONE code entry is rendered, ever. A pending claim wins over the signup
 * prompt because a single verification code is stored per customer — the code
 * in someone's hand belongs to the most recent mint, which is the claim — so
 * showing two inputs would be showing the same code two contradictory jobs.
 */
export function EmailClaim({
  customer,
  emailVerificationRequired,
  onChanged,
}: {
  customer: Customer;
  emailVerificationRequired: boolean;
  onChanged: () => void | Promise<void>;
}) {
  /**
   * The address THIS session just staged. `customer.pendingEmail` is the
   * authority; this only covers the moment between the PATCH returning and the
   * caller's reloaded overview arriving, so the code input can appear in place
   * instead of after a round trip.
   */
  const [staged, setStaged] = useState('');
  const pending = customer.pendingEmail || staged;
  const needsSignupCode =
    !pending && Boolean(customer.email) && emailVerificationRequired && !customer.emailVerifiedAt;

  // Promotion clears the echo: once the server reports the claim as `email`,
  // this session's copy is stale and would keep a dead prompt on screen.
  useEffect(() => {
    if (staged && customer.email && customer.email.toLowerCase() === staged) setStaged('');
  }, [customer.email, staged]);

  async function verified() {
    setStaged('');
    await onChanged();
  }

  return (
    <>
      <EmailAddressForm
        currentEmail={customer.email}
        pendingEmail={pending}
        onStaged={async (address) => {
          setStaged(address);
          await onChanged();
        }}
      />

      {pending ? (
        <div style={{ marginTop: 16 }}>
          <PendingEmailNotice email={pending} onVerified={verified} />
        </div>
      ) : needsSignupCode ? (
        <div style={{ marginTop: 16 }} className="emailPrompt">
          {/* Spend above, request below. The request is the shared control so
              its wait comes from when the last code was ISSUED — a form-owned
              button would come up live beside a code that already exists. */}
          <OtpForm email={customer.email} onVerified={verified} />
          <DevCodeHint />
          <SignupCodeResend address={customer.email} />
        </div>
      ) : null}
    </>
  );
}

/**
 * The unverified-SIGNUP prompt, with the code entry inline. Deliberately does
 * NOT tell anyone to "click the link in your inbox": there is no link any more,
 * and the code is typed here.
 *
 * This is the address someone signed up with — their login identifier, already
 * written to `email` — not a claim. A claim gets `PendingEmailNotice` instead.
 */
export function VerifyEmailPrompt({
  email,
  onVerified,
}: {
  email?: string | null;
  onVerified: () => void | Promise<void>;
}) {
  return (
    <div className="emailPrompt">
      <div className="infoBanner">
        Verify your email <span>— your keys work in the meantime.</span>
      </div>
      {/* Resend hoisted out of the form for the shared, timestamp-derived
          cooldown — see the note in `EmailClaim`. */}
      <OtpForm email={email} onVerified={onVerified} />
      <DevCodeHint />
      <SignupCodeResend address={email} />
    </div>
  );
}

/**
 * The settings surface for the account address: what it is, whether it is
 * confirmed, what has been claimed but not proved, and how to change it, all in
 * one card. The overview banner is a prompt; this is where someone goes looking
 * on purpose.
 */
export function EmailCard({
  overview,
  onChanged,
}: {
  overview: AccountOverview;
  onChanged: () => void | Promise<void>;
}) {
  const { customer, emailVerificationRequired } = overview;

  return (
    <div className="admin-card">
      <h2 className="admin-h">Email address</h2>
      <div className="statGrid">
        {/* `wide` = full row on a phone: an address is far wider than a
            half-width tile and was wrapping mid-domain. See `.statTile.wide`
            in site.css. */}
        <div className="statTile wide">
          <span>Email</span>
          <strong>{customer.email || 'None'}</strong>
        </div>
        <div className="statTile">
          <span>Verified</span>
          <strong>
            {!customer.email
              ? '—'
              : customer.emailVerifiedAt
                ? new Date(customer.emailVerifiedAt).toLocaleDateString()
                : 'Not yet'}
          </strong>
        </div>
        {/* Shown as its own tile, never merged into "Email": a claim is not the
            account address and must not read like one. */}
        {customer.pendingEmail && (
          <div className="statTile wide">
            <span>Awaiting code</span>
            <strong>{customer.pendingEmail}</strong>
          </div>
        )}
      </div>

      {!customer.email && (
        <p className="admin-note">
          Your account has no email address. Renewal notices and password reset both need one.
        </p>
      )}

      <div style={{ marginTop: 14 }}>
        <EmailClaim
          customer={customer}
          emailVerificationRequired={emailVerificationRequired}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}
