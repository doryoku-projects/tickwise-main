export function compactAddress(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return '$0.000';
  return USD_FORMATTER.format(value);
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0.000%';
  const abs = Math.abs(value);
  // Cap pathological values (e.g. tiny-age positions before APR floor lands) so a
  // single bad row doesn't blow out column width.
  if (abs >= 1_000_000_000) return value > 0 ? '>1B%' : '<-1B%';
  return `${value.toFixed(3)}%`;
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'new';
  const days = Math.floor(seconds / 86_400);
  if (days >= 365) return `${(days / 365).toFixed(1)}y`;
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

/**
 * A v4 dynamic-fee pool's PoolKey fee is the flag 0x800000 (8,388,608 pips), not a
 * rate — its hook sets the fee per swap. No real fee reaches it (v4 caps a fee at
 * 1,000,000 pips = 100%), so it reads "dynamic", never "838.86%". Positions carry
 * the PoolKey fee from the Ponder indexer; pools already send `isDynamicFee`.
 */
const DYNAMIC_FEE_FLAG = 0x800000;

export function formatFee(fee: number): string {
  if (Number.isFinite(fee) && fee >= DYNAMIC_FEE_FLAG) return 'dynamic';
  if (!Number.isFinite(fee) || fee <= 0) return '0%';
  return `${(fee / 10_000).toFixed(2)}%`;
}

/**
 * Plan/invoice money from minor units. Separate from `formatCurrency`, whose
 * fixed 3 decimals exist for sub-cent token values and would render "$49.000".
 * Falls back to a plain suffix for currencies Intl doesn't know (e.g. USDC).
 */
export function formatMoneyMinor(minor: number, currency = 'USD'): string {
  if (!Number.isFinite(minor)) return '—';
  const major = minor / 100;
  const digits = Number.isInteger(major) ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${currency}`;
  }
}

/**
 * An ISO timestamp → `1 September 2026`, in UTC.
 *
 * UTC and not the visitor's local zone, deliberately: every billing deadline on
 * the server — `currentPeriodEnd`, `graceEndsAt`, the quota rollover — is a UTC
 * instant, and rendering them locally puts a customer in UTC+13 a day ahead of
 * the date their access actually changes. The month is spelled out because a
 * bare `01/09/2026` reads as two different days on two sides of an ocean.
 */
export function formatUtcDate(iso: string | Date | undefined | null): string {
  if (!iso) return '—';
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * A billing period → `14 Aug – 14 Sep 2026`, in UTC.
 *
 * `formatUtcDate` twice with a dash between produced "14 August 2026 – 14
 * September 2026": 44 characters to say a month, repeating the year in the
 * middle of it, and on a phone it took a line of its own in every invoice. The
 * repeated parts are dropped instead — same month gives `1 – 30 September 2026`,
 * same year gives `14 Aug – 14 Sep 2026`, and a period that straddles new year
 * keeps both years.
 *
 * The month stays ALPHABETIC for the reason `formatUtcDate` spells it out: a
 * numeric `01/09` is two different days on two sides of an ocean. It is
 * abbreviated rather than shortened to digits, which keeps that property.
 */
export function formatUtcRange(
  start: string | Date | undefined | null,
  end: string | Date | undefined | null,
): string {
  const from = toUtcDate(start);
  const to = toUtcDate(end);
  if (!from || !to) return `${formatUtcDate(start)} – ${formatUtcDate(end)}`;

  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  const sameMonth = sameYear && from.getUTCMonth() === to.getUTCMonth();

  // A whole month inside one month has room for the full name: `1 – 30 September 2026`.
  if (sameMonth) {
    return `${from.getUTCDate()} – ${to.getUTCDate()} ${MONTHS[to.getUTCMonth()]} ${to.getUTCFullYear()}`;
  }
  const head = sameYear
    ? `${from.getUTCDate()} ${SHORT_MONTHS[from.getUTCMonth()]}`
    : `${from.getUTCDate()} ${SHORT_MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()}`;
  return `${head} – ${to.getUTCDate()} ${SHORT_MONTHS[to.getUTCMonth()]} ${to.getUTCFullYear()}`;
}

/**
 * Composed by hand rather than through `Intl`, for ONE reason: `en-GB` — which
 * `formatUtcDate` needs for its day-first order — abbreviates September to
 * "Sept", so a range rendered "14 Aug – 14 Sept 2026" with one month a letter
 * wider than the other eleven. These are display abbreviations in a mono column,
 * where the ragged one is the one you notice.
 */
const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function toUtcDate(value: string | Date | undefined | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 'YYYY-MM' (the usage period key) → 'July 2026'. Passthrough if unparseable. */
export function formatPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
