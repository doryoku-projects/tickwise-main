/**
 * What each metered response class MEANS for the bill.
 *
 * Shared rather than declared per surface: the admin panel and the customer's
 * own usage page render the same report from the same endpoint, and a support
 * conversation about a charge cannot turn into an argument about whose wording
 * is right. Looked up rather than switched on, with the raw class as the
 * fallback — the server owns the set, and a class it adds later must still
 * render as itself instead of as a blank row.
 *
 * `isRefundable(status)` in the backend's metering interceptor is
 * `status >= 400 && status !== 429`, so 4xx and 5xx are charged and then given
 * back, while a 429 is thrown by the guard BEFORE the charge — never billed at
 * all rather than refunded.
 */
export const STATUS_COPY: Record<string, { label: string; note: string }> = {
  '2xx': { label: 'Success', note: 'Billed' },
  '4xx': { label: 'Client error', note: 'Units refunded' },
  '5xx': { label: 'Server error', note: 'Units refunded' },
  '429': { label: 'Rate limited / over quota', note: 'Never charged' },
};

/**
 * The label the "requests that cost the customer something they did not want"
 * tile carries on BOTH surfaces, and the definition behind it.
 *
 * It counts 429s ONLY. Every other non-2xx class is refunded, so folding them
 * into an "error rate" presents a number the customer was not charged for as if
 * it were a failure they paid for — two refunded calls out of six read as a 33%
 * error rate. The refunded classes stay visible in the by-response-class
 * breakdown, which says outright that their units were given back.
 */
export const RATE_LIMITED_LABEL = 'Rate limited';

/** Requests in this window that the rate limiter or the quota turned away. */
export function rateLimitedRequests(
  byStatus: ReadonlyArray<{ statusClass: string; requests: number }>,
): number {
  return byStatus
    .filter((row) => row.statusClass === '429')
    .reduce((sum, row) => sum + row.requests, 0);
}
