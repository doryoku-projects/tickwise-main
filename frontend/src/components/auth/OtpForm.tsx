'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { portalApi } from '../../lib/portal-api';

/** Digits in the code the backend issues. */
const CODE_LENGTH = 6;

/**
 * The email verification step: one 6-digit code, typed.
 *
 * Used in four places — the standalone /verify-email page, the verify gate, the
 * overview banner and the settings card — so the input and the auto-submit rule
 * are defined once.
 *
 * IT DOES NOT ISSUE CODES. It used to carry its own resend button behind an
 * `allowResend` prop, with a cooldown that started when that button was
 * PRESSED — so it opened live beside a code that already existed and knew
 * nothing about codes minted by signup, by a staged claim, or in another tab.
 * Asking for a code now belongs to `ResendCodeControl` (portal/EmailControls),
 * one control whose wait is derived from `lib/otp-cooldown.ts`'s record of when
 * the last code for that address actually went out. Do not add a second one
 * back in here: two resend controls carry two independent cooldowns, which is
 * the same as having none.
 *
 * Every failure message is the SERVER'S, rendered verbatim. This component
 * cannot know whether a rejected code was wrong, expired, already used or
 * rate-limited, and inventing "invalid code" would sooner or later contradict
 * the real reason. The only strings written here are for a rejection that
 * arrives with no message at all.
 */
export function OtpForm({
  email,
  onVerified,
}: {
  /** Shown so people know which inbox to open. Omit when it isn't known. */
  email?: string | null;
  onVerified?: () => void | Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  // Generated, not hard-coded: the settings card can end up on a page with
  // another copy of this form, and two elements sharing an id break the label.
  const inputId = useId();
  /**
   * The last code this form actually sent. The input auto-submits when it fills
   * up, and without this a re-render (or a stray change event) would replay the
   * same code against a single-use endpoint.
   */
  const attempted = useRef('');

  const submit = useCallback(
    async (value: string) => {
      if (busy || value.length !== CODE_LENGTH) return;
      attempted.current = value;
      setError('');
      setBusy(true);
      try {
        await portalApi.verifyEmail(value);
        setDone(true);
        await onVerified?.();
      } catch (err) {
        setError(
          (err instanceof Error && err.message) || 'That code could not be verified. Try again.',
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, onVerified],
  );

  function onCodeChange(raw: string) {
    // Digits only, and never more than the code holds. Paste of "123 456" or
    // "code: 123456" lands as 123456 rather than being rejected.
    const next = raw.replace(/\D+/g, '').slice(0, CODE_LENGTH);
    setCode(next);
    if (next.length < CODE_LENGTH) return;
    // Filling the last box IS the submit — no reason to make people reach for a
    // button they can also press.
    if (next !== attempted.current) void submit(next);
  }

  if (done) {
    return <div className="admin-ok">Your email address is verified.</div>;
  }

  return (
    <form
      className="otpForm"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(code);
      }}
    >
      <label className="otpLabel" htmlFor={inputId}>
        {email ? `Enter the ${CODE_LENGTH}-digit code sent to ${email}` : `Enter your ${CODE_LENGTH}-digit code`}
      </label>
      <div className="otpRow">
        <input
          id={inputId}
          className="admin-input otpInput"
          // Numeric keypad on mobile, and the OS/browser offers the code from
          // the message itself where it can read one.
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={CODE_LENGTH}
          placeholder="000000"
          aria-label={`${CODE_LENGTH}-digit verification code`}
          value={code}
          disabled={busy}
          onChange={(e) => onCodeChange(e.target.value)}
        />
        <button className="admin-btn" type="submit" disabled={busy || code.length !== CODE_LENGTH}>
          {busy ? 'Checking…' : 'Verify'}
        </button>
      </div>

      {error && <div className="admin-error">{error}</div>}
    </form>
  );
}
