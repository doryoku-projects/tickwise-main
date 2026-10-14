import { useCallback, useEffect, useState } from 'react';

/**
 * One cooldown for every "issue me a code" control in the app.
 *
 * WHY IT IS SHARED, AND WHY IT IS A TIMESTAMP
 *
 * A code is minted in more places than the resend button: signing up mints one,
 * and so does `PATCH /account/profile` when it stages an address. Every one of
 * those spends from the SAME server budget — `resendLimiter`, 5 per hour per
 * customer, consumed by `resend-verification` and by a profile edit alike. A
 * cooldown that only started when someone pressed *resend* therefore lied on
 * arrival: the code entry appeared with a live button beside it, and the very
 * first thing anyone could do was re-mint a code they were already holding.
 *
 * The fix cannot be "start at 60 on mount" either. These components remount on
 * every navigation and every refresh, so a seeded timer would punish someone
 * returning an hour later and would re-arm itself for anyone who reloads. What
 * is durable is WHEN THE CODE WAS ISSUED, so that is what gets stored; the
 * remaining time is derived from it, decays in real time, survives a refresh
 * mid-countdown and is already zero on a late return.
 *
 * THIS IS A HINT, NOT A SECURITY CONTROL. localStorage belongs to the visitor:
 * it can be cleared, edited, or skipped entirely with a second browser. The
 * real budget is the server's rate limiter in `customer-auth.service.ts`
 * (`throttleResend`), and that limiter must never be relaxed or removed on the
 * strength of anything in this file. All this buys is an honest UI — a button
 * that does not invite someone to burn a request they already spent.
 */

/** Seconds a freshly issued code holds every resend control shut. Visible, so nobody guesses. */
export const OTP_RESEND_COOLDOWN = 60;

const COOLDOWN_MS = OTP_RESEND_COOLDOWN * 1000;

/** Namespaced with the other `tk-*` keys so it is obvious whose it is. */
const STORAGE_PREFIX = 'tk-otp-issued:';

/**
 * The bucket an address's codes are counted in.
 *
 * Per ADDRESS, because two claims are two different codes: staging
 * `new@example.com` says nothing about how long ago the code for
 * `old@example.com` went out, and sharing one timer between them would either
 * block a fresh claim or free an old one.
 *
 * `null`/empty collapses to a single shared bucket for the signed-in resend on
 * a page that does not know the address (see VerifyEmailClient) — it is the
 * account's own address either way, so one bucket is right, not a compromise.
 *
 * The address is stored in the clear. It is the visitor's own, already on the
 * screen that wrote it, and it sits in the same origin's localStorage as their
 * session token — nothing is revealed here that was not already there.
 */
export function otpCooldownKey(address?: string | null): string {
  // Lowercased to match the server's normalisation, so the code the PATCH
  // issued for `Me@Example.com` and the notice rendered from the server's
  // `me@example.com` land in the same bucket.
  return (address ?? '').trim().toLowerCase() || 'account';
}

function storageKey(address?: string | null): string {
  return STORAGE_PREFIX + otpCooldownKey(address);
}

/** Every mounted hook, so a code issued in THIS tab reaches the controls in it. */
const listeners = new Set<(key: string) => void>();

function readIssuedAt(key: string): number | null {
  // Client components still get a server pass, and Safari's private mode throws
  // on storage access outright — neither may take the page down.
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const at = Number(raw);
    if (!Number.isFinite(at) || at <= 0) return null;
    // A stamp in the future (clock moved, value hand-edited) would otherwise
    // hold the button shut for longer than the cooldown. Clamped, the worst it
    // can cost anyone is the same 60 seconds a real code costs.
    return Math.min(at, Date.now());
  } catch {
    return null;
  }
}

function remainingFor(issuedAt: number | null): number {
  if (issuedAt === null) return 0;
  return Math.max(0, Math.ceil((issuedAt + COOLDOWN_MS - Date.now()) / 1000));
}

/** Drop stamps that can no longer hold anything shut, so typo'd addresses do not pile up. */
function prune(): void {
  try {
    const cutoff = Date.now() - COOLDOWN_MS;
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const at = Number(window.localStorage.getItem(key));
      if (!Number.isFinite(at) || at <= cutoff) stale.push(key);
    }
    stale.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    /* storage unavailable — nothing to prune */
  }
}

/**
 * Record that a code was just issued for `address`.
 *
 * Call this on SUCCESS ONLY. A rejected request minted nothing, and locking
 * someone out of asking again because the server said no is the one failure
 * this must never produce — the person is then holding no code at all.
 *
 * Usable outside React (`EmailAddressForm` learns the address only when the
 * PATCH returns, by which point the hook's key would be a render behind), and
 * any hook already mounted on that address picks it up immediately.
 */
export function markOtpIssued(address?: string | null): void {
  if (typeof window === 'undefined') return;
  const key = otpCooldownKey(address);
  try {
    prune();
    window.localStorage.setItem(STORAGE_PREFIX + key, String(Date.now()));
  } catch {
    // Storage refused (private mode, quota, disabled). The countdown then lives
    // only in memory for this mount — degraded, not broken, and the server's
    // limiter is still the thing that actually enforces the budget.
  }
  listeners.forEach((notify) => notify(key));
}

/**
 * Seconds left before another code may be requested for `address`, and the way
 * to arm it after issuing one.
 *
 * `remaining` starts at 0 on the server pass and on the first client render —
 * storage is read in an effect, so the two agree and hydration is quiet — then
 * settles to whatever the stored stamp says. It ticks once a second while
 * positive, recomputed from the timestamp each tick rather than decremented.
 *
 * Recomputing is necessary but NOT sufficient for a backgrounded tab. Browsers
 * throttle a hidden tab's intervals to roughly once a minute and can freeze
 * them altogether, so the value is right whenever a tick fires but a tick may
 * not fire for a long time: switch away mid-countdown, come back after it
 * expired, and the button sits there disabled reading a stale number — the same
 * lie this hook exists to remove, just in the other direction. Observed live at
 * `document.visibilityState === 'hidden'`: the label held "54s" while the real
 * remainder was 20s. Hence the visibility/focus listeners below, which resync
 * the moment the tab is looked at again.
 */
export function useOtpCooldown(address?: string | null): {
  remaining: number;
  startNow: () => void;
} {
  const key = otpCooldownKey(address);
  const [issuedAt, setIssuedAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  // Adopt the stored stamp for whichever address is being shown. Runs on mount
  // (so a refresh CONTINUES the countdown instead of restarting or skipping it)
  // and again whenever the address changes.
  useEffect(() => {
    setIssuedAt(readIssuedAt(key));

    const refresh = (changed: string) => {
      if (changed === key) setIssuedAt(readIssuedAt(key));
    };
    listeners.add(refresh);
    // `storage` fires only in OTHER tabs, which is exactly the gap the listener
    // set above cannot cover: a second portal tab must not offer a live button
    // for a code this one just spent.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === STORAGE_PREFIX + key) refresh(key);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [key]);

  useEffect(() => {
    const next = remainingFor(issuedAt);
    setRemaining(next);
    if (next <= 0) return;

    let timer = 0;
    const sync = () => {
      const left = remainingFor(issuedAt);
      setRemaining(left);
      if (left <= 0) window.clearInterval(timer);
    };
    timer = window.setInterval(sync, 1000);

    // The catch-up path for a tab that was hidden (or a machine that slept)
    // while the countdown ran out. Without it the interval alone decides when
    // the button un-disables, and a throttled or frozen timer can leave it shut
    // for up to a minute after the wait is genuinely over.
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, [issuedAt]);

  const startNow = useCallback(() => markOtpIssued(key), [key]);

  return { remaining, startNow };
}
