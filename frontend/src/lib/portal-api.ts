import type { ApiPlan } from './catalog-api';
import { createHttpClient, HttpError, httpStatus } from './http';

export { HttpError, httpStatus } from './http';

/** Auth routes a signed-out visitor is allowed to sit on — never 401-redirect these. */
export const PORTAL_PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  // The emailed reset link lands SIGNED OUT on the page holding the new-password
  // form, and it lands there carrying a SINGLE-USE token in the URL. A browser
  // that still has a stale `tk-portal-token` in localStorage would be bounced to
  // /login by the first session-client 401 on that page, throwing the token away
  // mid-ceremony — and the customer cannot simply come back, because asking for
  // a second link is the only recovery.
  //
  // The page EXISTS now (app/reset-password/), so this is a real route rather
  // than a placeholder — but be precise about what the entry buys today: that
  // page is deliberately built so nothing on it can trigger the bounce. The
  // reset call goes over `publicHttp`, and the only other thing it touches is
  // `clearPortalToken`, which makes no request at all. So this does not rescue
  // any call the page makes right now; it is what keeps the page safe the day
  // someone adds one — a plan lookup, a branding read, an `me()` to greet the
  // customer by name — which is precisely the sort of thing added later without
  // thinking about the bounce. Deleting it because "nothing here 401s" re-arms
  // exactly that.
  '/reset-password',
  '/auth/callback',
  // /link-account is reached SIGNED OUT (that is the whole point of it: prove
  // you hold the existing account). It reads `GET /account/auth/me` to work out
  // whose session is present, and without this entry an expired token there
  // would bounce the visitor to /login in the middle of the ceremony.
  '/link-account',
  /**
   * The checkout return page is reached FROM THE PAYMENT RAIL, and for a crypto
   * rail that very often means a wallet's in-app browser — a separate browsing
   * context with no `tk-portal-token` at all. It authenticates on the invoice's
   * `returnToken` instead (see `checkoutStatus` below), so a 401-bounce to
   * /login here would show a login form to somebody who has just paid, which
   * reads as the payment having failed.
   */
  '/portal/checkout/return',
];
export const PORTAL_LOGIN_PATH = '/login';

// Customer realm. Separate token key from the admin panel ('tk-admin-token')
// so an operator can hold both sessions in one browser, and a 401 here clears
// ONLY the portal token and lands on the CUSTOMER login.
const http = createHttpClient({
  tokenKey: 'tk-portal-token',
  loginPath: PORTAL_LOGIN_PATH,
  publicPaths: PORTAL_PUBLIC_PATHS,
});

// The SSO handshake (provider list, OAuth start/exchange, wallet nonce/verify)
// runs SIGNED OUT and must not carry the portal token: sending it would let a
// 401 from a public route sign out a visitor who still has a valid session, and
// these routes have no use for it. Same reasoning as lib/catalog-api.ts.
const publicHttp = createHttpClient({ tokenKey: null });

export function getPortalToken(): string | null {
  return http.getToken();
}

export function setPortalToken(token: string): void {
  http.setToken(token);
}

export function clearPortalToken(): void {
  http.clearToken();
}

export interface Customer {
  id: string;
  /**
   * The account's PROVED address. Absent on a wallet-only account: SSO never
   * invents an address, and the schema allows a customer with no email. Every
   * render site must cope.
   */
  email?: string | null;
  planKey: string;
  /** ISO timestamp, or null/undefined while the address is unverified. */
  emailVerifiedAt?: string | null;
  /**
   * An address CLAIMED but not yet proved, or null. It is NOT the account's
   * address: `updateProfile` stages it here and it is promoted to `email` only
   * when the 6-digit code verifies, so a claim that is never proved never
   * occupies the unique-indexed `email` and can never lock its rightful owner
   * out of registering.
   *
   * Present on an account that already has a verified `email` too — that is
   * someone half-way through CHANGING address, and the UI must show both.
   */
  pendingEmail: string | null;
  status?: string;
}

export interface AuthResult {
  token: string;
  customer: Customer;
}

/**
 * The lifecycle state the billing banner renders. FIVE, and deliberately not
 * the raw subscription status — that vocabulary is Stripe's and is about
 * billing machinery, while these are about what the customer can do next.
 */
export type BillingState = 'free' | 'pending' | 'active' | 'past_due' | 'ended';

export interface BillingInvoice {
  id: string;
  number: number;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  planKey: string;
  /** Display name of the plan this invoice buys (e.g. "Standard"). */
  planName: string;
  periodStart: string;
  periodEnd: string;
  /** Money. Integer MINOR units (cents) — never a float, anywhere. */
  subtotalMinor: number;
  creditAppliedMinor: number;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  /** Hosted-redirect rails: the live pay link. Absent once settled or voided. */
  hostedUrl?: string;
  /** Native on-chain rail: deposit address + exact amount. */
  instructions?: OnChainInstructions;
  createdAt?: string;
}

export interface BillingOverview {
  state: BillingState;
  /**
   * A payment for the open invoice is already on its way and cannot be
   * recalled. When true the portal must NOT offer to pay again — see the note
   * in the backend's `BillingViewService`.
   */
  paymentInFlight?: boolean;
  /** Confirmation progress for a broadcast payment. Absent = cannot say. */
  paymentProgress?: {
    confirmations: number;
    minConfirmations: number;
    remaining: number;
    txHash: string;
    explorerUrl?: string;
  };
  planKey: string;
  planName: string;
  /** Money. Stored credit, applied automatically to the next invoice. */
  creditBalanceMinor: number;
  subscription: {
    id: string;
    status: string;
    planKey: string;
    interval: 'month' | 'year';
    unitAmountMinor: number;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    graceEndsAt?: string;
    pendingPlanKey?: string;
    pendingEffectiveAt?: string;
  } | null;
  openInvoice: BillingInvoice | null;
}

/**
 * How the customer pays a no-middleman rail. EXACTLY ONE of `hostedUrl` /
 * `instructions` is present on a checkout, decided by the rail's shape.
 *
 * TWO SHAPES on the backend (`payment-provider.interface.ts`):
 *  - `deposit` — send a plain transfer to `payToAddress`. What `PayInstructions`
 *    renders.
 *  - `authorization` — SIGN an EIP-3009 message; the token moves the money into a
 *    single treasury. It has NO `payToAddress`, and its signing panel does not
 *    exist yet.
 *
 * `kind` is OPTIONAL and ABSENT MEANS `deposit`, because invoices stored before
 * the union existed carry no `kind` at all. The optional fields below are what
 * force a caller to narrow before rendering an address — `PayInstructions`
 * returns null for anything that is not a deposit rather than printing an empty
 * "Send to" on a money screen.
 */
export interface OnChainInstructions {
  kind?: 'deposit' | 'authorization';
  chainId: number;
  chainName: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Deposit shape only. Absent on an `authorization`. */
  payToAddress?: string;
  /** Authorization shape only: where the signed transfer pays. */
  treasuryAddress?: string;
  /** Authorization shape only: the 32-byte nonce that references this invoice. */
  nonce?: string;
  /** DECIMAL STRING in the token's base units — never rendered; used to verify. */
  amountBaseUnits: string;
  /** Human amount, e.g. `19 USDC`. */
  amountDisplay: string;
  minConfirmations: number;
}

/**
 * The EIP-712 payload to sign, as the server composed it.
 *
 * `typedData` is passed to the wallet VERBATIM — not rebuilt, not reordered. Its
 * `message.value` and the two timestamps are DECIMAL STRINGS because they are
 * `uint256`s that cannot survive JSON as numbers, and `eth_signTypedData_v4`
 * accepts them in that form.
 */
export interface AuthorizationPayload {
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, string>;
  };
  chainId: number;
  chainName: string;
  tokenSymbol: string;
  amountDisplay: string;
  treasuryAddress: string;
  /** Unix SECONDS — when the signature stops being spendable. */
  validBefore: number;
  /** `false` means the customer's own wallet must send the transaction. */
  relayed: boolean;
  /** The wallet's current token balance, e.g. `7.99 USDC`. Empty if unreadable. */
  balanceDisplay: string;
  /** Explorer base for this chain. Empty when unknown — do not render a dead link. */
  explorerUrl: string;
}

/** One network the customer may pay on. */
export interface PaymentNetworkOption {
  chainId: number;
  chainName: string;
  tokenSymbol: string;
  /** Whether the invoice is quoted on this network right now. */
  current: boolean;
}

export interface AuthorizationResult {
  status: 'settled' | 'submitted' | 'authorized';
  txHash?: string;
  /** Only when the server has no relayer: the transaction the wallet must send. */
  selfSubmit?: { to: string; data: string; chainId: number };
}

export interface CheckoutResult {
  /** `checkout` — go pay. `scheduled` — nothing to pay now. `granted` — credit covered it. */
  outcome: 'checkout' | 'scheduled' | 'granted';
  planKey: string;
  invoiceId?: string;
  /** Hosted-redirect rails: send the browser here. */
  hostedUrl?: string;
  /** Direct on-chain rails: render an address and an exact amount. */
  instructions?: OnChainInstructions;
  amountDueMinor?: number;
  currency?: string;
  effectiveAt?: string;
}

/**
 * The five states the return page must tell apart.
 *
 * `pending` IS THE IMPORTANT ONE and must NEVER be rendered as success. A crypto
 * transfer is broadcast long before it confirms and the rail bounces the browser
 * back the moment it is sent, so this is the commonest state on arrival. Showing
 * a tick for it means the customer closes the tab believing they are on Pro, the
 * transfer then underpays or fails, and they discover it when their keys 429.
 */
export type CheckoutState = 'awaiting' | 'pending' | 'short' | 'paid' | 'closed';

export interface CheckoutStatus {
  state: CheckoutState;
  planName: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  shortfallMinor: number;
}

/**
 * Read the pay link off a 409 from `startCheckout`.
 *
 * The server answers a repeat purchase with a 409 CARRYING the existing
 * invoice's link, precisely so the portal can send the customer to the payment
 * they already started instead of raising a second one. Treating that 409 as a
 * plain error is how a customer ends up with two invoices for one month.
 */
export function checkoutConflict(err: unknown): {
  hostedUrl?: string;
  invoiceId?: string;
  instructions?: OnChainInstructions;
} | null {
  if (httpStatus(err) !== 409) return null;
  const body = err instanceof HttpError ? err.body : null;
  if (!body || typeof body !== 'object') return {};
  const row = body as Record<string, unknown>;
  return {
    hostedUrl: typeof row.hostedUrl === 'string' ? row.hostedUrl : undefined,
    invoiceId: typeof row.invoiceId === 'string' ? row.invoiceId : undefined,
    /**
     * THE PAYMENT THEY ALREADY STARTED. The backend has always sent this — its
     * own comment says the portal "must be able to ACT on this 409 by showing the
     * customer the payment they already started" — and this reader dropped it, so
     * a crypto-rail customer got the bare sentence "You already have a payment in
     * progress for this plan." beside a "Try again" button that could only 409
     * again. On a redirect rail `hostedUrl` covered the same case, which is why it
     * went unnoticed.
     *
     * Structurally checked rather than cast: this is a 409 BODY, and a shape
     * change upstream must degrade to the plain error rather than render a pay
     * panel from a half-object.
     */
    instructions: isOnChainInstructions(row.instructions) ? row.instructions : undefined,
  };
}

/** Narrow a 409's `instructions` to something the pay dialog can render. */
function isOnChainInstructions(value: unknown): value is OnChainInstructions {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  // `kind` absent means the legacy `deposit` shape — rows predating the union are
  // still in Mongo, so absent must stay readable (same rule as the backend's).
  const kind = row.kind === undefined ? 'deposit' : row.kind;
  if (kind !== 'deposit' && kind !== 'authorization') return false;
  return typeof row.chainId === 'number' && typeof row.amountDisplay === 'string';
}

/** A sign-in method the server actually has configured — never render a button
 *  for anything absent from this list, it would 404 on click. */
export interface AuthProvider {
  id: string;
  label: string;
  /** 'oauth' = browser redirect handshake; 'wallet' = local signature. */
  kind: 'oauth' | 'wallet';
  enabled: boolean;
}

/** A sign-in method already attached to this account. */
export interface LinkedIdentity {
  id: string;
  provider: string;
  /** Provider-side account id — the wallet address when the provider is a wallet. */
  subject: string;
  email?: string | null;
  emailVerified?: boolean;
  linkedAt?: string | null;
  lastLoginAt?: string | null;
}

export interface IdentityList {
  identities: LinkedIdentity[];
  /** false = SSO is the only way in, so the last identity must not be unlinked. */
  hasPassword: boolean;
}

/**
 * What a pending "sign in to connect" ceremony is about, described by the
 * server from an opaque token.
 *
 * `maskedEmail` is the ONLY place the colliding address may come from. It is
 * deliberately absent from the /link-account URL: a crafted link carrying an
 * arbitrary address would render a convincing "you already have an account for
 * <you>@<their bank>" lure on our own domain. Render this field, never a query
 * param.
 */
export interface PendingLinkDescription {
  provider: string;
  providerLabel: string;
  /** Already masked server-side, e.g. `k•••@gmail.com`. */
  maskedEmail: string;
  /**
   * What the TARGET account can actually be signed in with — the allow-list the
   * ceremony page renders.
   *
   * `providers` holds ONLY identities already attached to that account. Anything
   * else re-collides on the same address and mints a fresh ceremony, so offering
   * it sends the customer round the loop that made this field necessary. Both can
   * be empty; the page must then say so rather than render nothing.
   */
  signInMethods: {
    password: boolean;
    providers: Array<{ id: string; label: string }>;
  };
}

/** Units burned in one calendar month. `limit` 0 = unlimited. */
export interface UsageSnapshot {
  /** 'YYYY-MM' — a calendar month in UTC, NOT a billing period. */
  period: string;
  units: number;
  limit: number;
}

export interface UsagePeriod {
  period: string;
  units: number;
  /**
   * Requests in that month, from the same monthly snapshot. GROSS: a refund
   * credits `units` and deliberately never decrements the request count, so
   * "100 requests, 60 units" is the honest record of a month with errors in it.
   */
  requests: number;
}

export interface AccountUsage {
  current: UsageSnapshot;
  history: UsagePeriod[];
}

// ─── usage detail (the per-day / per-route / per-key / per-status read model) ─

/** One UTC day of the detail `series`. */
export interface UsageDetailDay {
  /** 'YYYY-MM-DD', UTC — the bucket key, not a local calendar day. */
  day: string;
  units: number;
  requests: number;
}

export interface UsageDetailRoute {
  routeKey: string;
  /** Operator-editable display name from the endpoint-cost ladder. */
  label: string;
  /** Units the route cost per call, as charged over this window. */
  unitCost: number;
  units: number;
  requests: number;
}

export interface UsageDetailKey {
  apiKeyId: string;
  /**
   * Prefix and label as the key carried them MOST RECENTLY in the window. Both
   * are snapshotted per bucket because key deletion is a hard delete, so these
   * are the only way a deleted key still names itself here.
   */
  keyPrefix: string;
  keyLabel: string;
  units: number;
  requests: number;
}

export interface UsageDetailStatus {
  /** '2xx' | '4xx' | '5xx' | '429' — a string, not a union: the server owns the set. */
  statusClass: string;
  requests: number;
  units: number;
}

/**
 * ONE shape for both realms — the admin panel reads the same body from
 * `/admin/clients/:id/usage/detail`, so what support sees and what the customer
 * sees cannot differ by a rendering decision.
 *
 * `groupBy` narrows which breakdown is POPULATED, not which keys exist: the
 * other three come back as empty arrays, so no render site needs to test for a
 * missing field.
 */
export interface UsageDetail {
  /** The window the server actually used, after its own defaults and caps. */
  range: { from: string; to: string };
  /** `limit` is the plan's monthly unit allowance; `0` = unlimited. */
  totals: { units: number; requests: number; limit: number };
  series: UsageDetailDay[];
  byRoute: UsageDetailRoute[];
  byKey: UsageDetailKey[];
  byStatus: UsageDetailStatus[];
}

export type UsageDetailGroup = 'day' | 'routeKey' | 'apiKey' | 'status';

/**
 * Everything optional: no window at all is the common call, and the server
 * answers it with the current calendar month to date.
 */
export interface UsageDetailParams {
  /** Inclusive lower bound, 'YYYY-MM-DD' UTC. */
  from?: string;
  /** Inclusive upper bound, 'YYYY-MM-DD' UTC. */
  to?: string;
  /** Omitted = all four breakdowns; named = only that one is populated. */
  groupBy?: UsageDetailGroup;
}

export interface AccountOverview {
  customer: Customer;
  plan: ApiPlan;
  usage: UsageSnapshot;
  keys: { active: number; max: number };
  /** Whether this deployment verifies emails at all — gates the verify banner. */
  emailVerificationRequired: boolean;
}

export interface ApiKeySummary {
  id: string;
  label: string;
  /** Leading, non-secret slice of the key — all we can ever show after issuance. */
  prefix: string;
  keyType: 'server' | 'browser';
  allowedOrigins: string[];
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt?: string | null;
}

export interface IssuedApiKey extends ApiKeySummary {
  /** The raw secret. Returned EXACTLY ONCE — only its hash is stored. */
  key: string;
}

/**
 * `?from=…&to=…&groupBy=…`, dropping anything unset.
 *
 * Local and deliberately tiny — this is the only query string this file builds,
 * and every value in it is a server-validated bound. Empty rather than a bare
 * `?` so a default call requests the same URL a hand-written one would.
 */
function usageDetailQuery(params: UsageDetailParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const portalApi = {
  // auth
  signup: (body: { email: string; password: string; planKey?: string }) =>
    http.request<AuthResult>('/account/auth/signup', { method: 'POST', body: JSON.stringify(body) }),
  login: (email: string, password: string) =>
    http.request<AuthResult>('/account/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => http.request<Customer>('/account/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    http.request<{ ok: true }>('/account/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  /**
   * Consumes the 6-DIGIT code that was emailed to the address. Not a link and
   * not a long-lived token: `code` is the OTP the person typed in.
   *
   * Unguarded on the server, so it still works signed-out — the code is often
   * typed in a different browser from the one that asked for it. It goes over
   * the session client all the same: the token is harmless here, and a signed-in
   * verification should stay attributable.
   */
  verifyEmail: (code: string) =>
    http.request<{ ok: true; customer: Customer }>('/account/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  /**
   * Sends a fresh OTP to the address on the account. Signed in only.
   *
   * `delivered: false` means the code was minted and stored but the mail
   * provider refused it — an unverified sending domain, most often. The code is
   * valid; it just never left the building, so the caller must NOT be told to go
   * and check an inbox. Absent on the paths where nothing needed sending.
   */
  resendVerification: () =>
    http.request<{ ok: true; delivered?: boolean }>('/account/auth/resend-verification', {
      method: 'POST',
    }),

  /**
   * Asks for a password-reset link to be emailed. Runs SIGNED OUT, so it goes
   * over the token-less client for the reason already spelled out on the SSO
   * block at `publicHttp` above: a stale portal token here would let a 401 from a
   * public route sign out a visitor who still holds a valid session.
   *
   * The server answers IDENTICALLY — the same 202, the same `{ ok: true }` —
   * whether or not the address exists, whether or not it is verified, and whether
   * or not the account is suspended.
   *
   * THE BODY AND THE STATUS, and nothing beyond them. The TIMING is not uniform
   * and must not be written up as if it were: a hit awaits a Mongo write and a
   * live mail round trip while a miss returns straight after the read, so the two
   * remain separable by a patient observer with a stopwatch. The backend says so
   * itself, in the residual note on `requestPasswordReset` — closing it means
   * handing delivery to a queue and answering before it runs, which is an open
   * follow-up rather than something already done. Do not build a claim of timing
   * safety on top of this.
   *
   * So the UI must NOT branch on this response to tell the customer anything
   * about whether they have an account. Saying it plainly
   * because this is the thing a future UI change is most likely to break: there
   * is no failure shape to read here, and inventing one from a success would
   * re-open the account-enumeration oracle the login route was just closed
   * against. The only honest screen is "if that address has an account, a link is
   * on its way".
   */
  forgotPassword: (email: string) =>
    publicHttp.request<{ ok: true }>('/account/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  /**
   * Spends the emailed token and sets the new password. Token-less for the
   * plainest possible reason: the customer is signed out by definition — not
   * being able to get in is what the link is for.
   *
   * It returns NO session, and that is deliberate rather than an omission. The
   * change stamps `passwordChangedAt`, which `CustomerJwtGuard` compares against
   * every token's `iat`, so every signed-in PORTAL SESSION is evicted the moment
   * this succeeds. Send them to /login afterwards; do not try to manufacture a
   * session from this response, and do not treat the sign-in that follows as a bug.
   *
   * SCOPE, and do not restate this as "signs you out everywhere": that stamp is
   * read by the portal guard and by nothing else. `/v1` resolves a raw API key
   * against that key's OWN status and never consults `passwordChangedAt`, so a key
   * an attacker minted survives this reset untouched. Telling someone recovering
   * from a compromise that they are now safe everywhere is the one reassurance
   * this call cannot honour — point them at their API keys instead.
   *
   * The server CONSUMES the token before it validates anything else, exactly like
   * the SIWE nonce and the pending-link token, so any rejection the service
   * produced is final and the link is spent: expired, unknown and already-used all
   * answer with the SAME error and must not be told apart. Recovery is asking for
   * a fresh link, never retrying this call. A failure that never reached the
   * service (`httpStatus` null) is the one exception — that token is still live.
   */
  resetPassword: (token: string, newPassword: string) =>
    publicHttp.request<{ ok: true }>('/account/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),

  // sso — signed-out handshake, so all of it goes over the token-less client
  listAuthProviders: () => publicHttp.request<{ providers: AuthProvider[] }>('/account/auth/providers'),
  // `credentials: 'include'` on the three OAuth calls is LOAD-BEARING, not
  // defensive. `fetch` defaults to `same-origin`, and the portal (:3011) is a
  // different origin from the API (:3000), so without it the browser would
  // neither STORE the HttpOnly binder cookie the start call sets nor SEND it on
  // the exchange — and the backend, which now refuses a callback whose binder is
  // absent, would fail every single sign-in closed. The binder is what stops
  // login CSRF and forced account-linking, so it cannot simply be dropped.
  startOauth: (provider: string, returnTo?: string) =>
    publicHttp.request<{ authorizeUrl: string }>(
      `/account/auth/oauth/${encodeURIComponent(provider)}/start`,
      {
        method: 'POST',
        body: JSON.stringify(returnTo ? { returnTo } : {}),
        credentials: 'include',
      },
    ),
  /** Trades the single-use handoff code for a session. Never call twice — see
   *  app/auth/callback/AuthCallbackClient.tsx. */
  exchangeOauthCode: (code: string) =>
    publicHttp.request<AuthResult>('/account/auth/oauth/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
      credentials: 'include',
    }),
  walletNonce: (address: string) =>
    publicHttp.request<{ nonce: string; message: string }>('/account/auth/wallet/nonce', {
      method: 'POST',
      body: JSON.stringify({ address }),
    }),
  walletVerify: (nonce: string, signature: string) =>
    publicHttp.request<AuthResult>('/account/auth/wallet/verify', {
      method: 'POST',
      body: JSON.stringify({ nonce, signature }),
    }),

  /**
   * Describes a pending link WITHOUT consuming it — the ceremony page is
   * refreshable and is often reloaded by the sign-in it asks for.
   *
   * Signed-out capable, so it goes over the token-less client; the CEREMONY
   * binder cookie is what authorises it, hence `credentials: 'include'` for the
   * same load-bearing reason spelled out on `startOauth`. Unknown, expired and
   * binder-mismatched all answer with the same 404 — do not try to tell them
   * apart, the server refuses to.
   */
  describePendingLink: (token: string) =>
    publicHttp.request<PendingLinkDescription>(
      `/account/auth/oauth/pending-link?token=${encodeURIComponent(token)}`,
      { credentials: 'include' },
    ),

  // identities (signed in)
  listIdentities: () => http.request<IdentityList>('/account/identities'),
  /**
   * Finishes the ceremony: attaches the provider account behind `token` to the
   * SIGNED-IN customer. Carries both credentials at once — the session (which
   * proves who is asking) and the ceremony binder cookie (`sso_link_binder`,
   * which proves this is the browser the ceremony started in; it deliberately
   * outlives the `sso_binder` any sign-in round trip churns).
   *
   * The server CONSUMES the token before it checks anything else, exactly like
   * the SIWE nonce, so any rejection the SERVICE produced is final — a 403 or a
   * 404 means starting the provider sign-in again. A rejection that never
   * reached it does not: a network failure (`httpStatus` null) and a 401 from
   * the guard both leave the token live, and the caller should retry rather
   * than throw the ceremony away.
   */
  completePendingLink: (token: string) =>
    http.request<{ ok: true; provider: string }>('/account/identities/link-pending', {
      method: 'POST',
      body: JSON.stringify({ token }),
      credentials: 'include',
    }),
  startIdentityLink: (provider: string, returnTo?: string) =>
    http.request<{ authorizeUrl: string }>(`/account/identities/${encodeURIComponent(provider)}/link`, {
      method: 'POST',
      body: JSON.stringify(returnTo ? { returnTo } : {}),
      // Same binder cookie as the login handshake — see startOauth above.
      credentials: 'include',
    }),
  unlinkIdentity: (id: string) =>
    http.request<{ ok: true }>(`/account/identities/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // account
  overview: () => http.request<AccountOverview>('/account/overview'),
  usage: () => http.request<AccountUsage>('/account/usage'),
  /**
   * The per-day / per-route / per-key / per-status breakdown for the SIGNED-IN
   * customer. No customer id is accepted or sent — the tenant is the session's,
   * which is what makes this route structurally immune to IDOR.
   *
   * Omitting `params` entirely is the normal call and asks for the current
   * calendar month to date. A window wider than the server's cap (92 days) is a
   * 400, not a silent clamp, so the caller can never believe it is looking at
   * more than it is.
   */
  usageDetail: (params: UsageDetailParams = {}) =>
    http.request<UsageDetail>(`/account/usage/detail${usageDetailQuery(params)}`),
  /**
   * STAGES an address on the account — the only way a wallet-only account can
   * acquire one, and the only way to change one.
   *
   * It does NOT set the address. The server normalises it, writes it to
   * `pendingEmail`, mints a 6-digit code and leaves `email` and
   * `emailVerifiedAt` exactly as they were; the claim is promoted to `email`
   * only by `verifyEmail`. So in the response `email` is still the OLD address
   * (or empty) and `pendingEmail` is what was just claimed — never tell anyone
   * their address has been saved on the strength of this call, because it has
   * not been. A typo therefore cannot cost someone the address they already
   * proved, and an unproven claim cannot squat one nobody proved.
   *
   * Calling it AGAIN with the same pending address re-mints the code, which is
   * the resend path for a claim: `/account/auth/resend-verification` only
   * refreshes the signup code and never touches a pending claim.
   *
   * 409 when another customer already holds the address; that message is the
   * server's to write, not ours.
   */
  updateProfile: (body: { email: string }) =>
    http.request<{ customer: Customer }>('/account/profile', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // ─── billing ───────────────────────────────────────────────────────────────
  billing: () => http.request<BillingOverview>('/account/billing'),
  billingInvoices: () => http.request<BillingInvoice[]>('/account/billing/invoices'),
  /**
   * Buy, upgrade or schedule a downgrade. WHICH of the three happens is the
   * server's decision, taken from the plan's monthly-equivalent price — the
   * client does not get to ask for "immediate", or a cheaper plan could be
   * switched to early and for free.
   *
   * A 409 is not a plain failure here: it CARRIES the pay link for a purchase
   * already in flight, so the caller should read `hostedUrl` off the error body
   * and send the customer to the payment they already started rather than
   * raising a second invoice. See `checkoutConflict`.
   */
  startCheckout: (planKey: string, priceId?: string) =>
    http.request<CheckoutResult>('/account/billing/checkout', {
      method: 'POST',
      body: JSON.stringify(priceId ? { planKey, priceId } : { planKey }),
    }),
  /**
   * Ask the server for the EIP-712 payload this wallet should sign.
   *
   * The SERVER composes it and stores what it issued; we never build typed data
   * here. That is deliberate — a frontend that assembles its own payload can drift
   * from what the server verifies, which is exactly the class of bug the SIWE flow
   * avoids the same way.
   */
  authorizePayment: (from: string) =>
    http.request<AuthorizationPayload>('/account/billing/authorize', {
      method: 'POST',
      body: JSON.stringify({ from }),
    }),

  /**
   * Report the hash of a transaction the wallet sent itself.
   *
   * A breadcrumb for support and the explorer link — the server never treats it as
   * evidence of payment (settlement is the watcher finding our nonce on chain), so
   * a failure here is harmless and must not break the flow.
   */
  recordSubmittedTx: (txHash: string) =>
    http.request<{ recorded: boolean }>('/account/billing/authorize/submitted', {
      method: 'POST',
      body: JSON.stringify({ txHash }),
    }),

  /** The networks this customer can pay on — only ones we can actually sign for. */
  paymentNetworks: () => http.request<PaymentNetworkOption[]>('/account/billing/networks'),

  /** Re-quote the open invoice on another network. Returns the new instructions. */
  switchPaymentNetwork: (chainId: number) =>
    http.request<{ instructions: OnChainInstructions }>('/account/billing/network', {
      method: 'POST',
      body: JSON.stringify({ chainId }),
    }),

  /** Hand back the signature. The server verifies, preflights and relays. */
  confirmAuthorization: (signature: string) =>
    http.request<AuthorizationResult>('/account/billing/authorize/confirm', {
      method: 'POST',
      body: JSON.stringify({ signature }),
    }),

  cancelSubscription: (reason?: string) =>
    http.request<{ endsAt: string; immediate: boolean }>('/account/billing/cancel', {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  /**
   * Abandon a pending UPGRADE without ending the subscription. Distinct from
   * `cancelSubscription`, which stops the plan the customer is paying for — the
   * two were the same button once, and it cancelled the wrong thing.
   */
  cancelPendingChange: () =>
    http.request<{ planKey: string }>('/account/billing/cancel-change', { method: 'POST' }),
  resumeSubscription: () =>
    http.request<{ renewsAt: string }>('/account/billing/resume', { method: 'POST' }),
  /**
   * The return page's status poll. Goes over the TOKEN-LESS client on purpose:
   * the browser arriving here often has no session, and the capability in the
   * URL is the whole authority. Sending a stale token would only risk a 401
   * bouncing a customer who has just paid.
   */
  checkoutStatus: (invoiceId: string, token: string) =>
    publicHttp.request<CheckoutStatus>(
      `/billing/checkout-status?invoice=${encodeURIComponent(invoiceId)}&t=${encodeURIComponent(token)}`,
    ),

  // keys
  listKeys: () => http.request<{ keys: ApiKeySummary[] }>('/account/keys'),
  createKey: (body: { label: string; keyType: 'server' | 'browser'; origins: string[] }) =>
    http.request<IssuedApiKey>('/account/keys', { method: 'POST', body: JSON.stringify(body) }),
  setKeyOrigins: (id: string, origins: string[]) =>
    http.request<ApiKeySummary>(`/account/keys/${id}/origins`, { method: 'PATCH', body: JSON.stringify({ origins }) }),
  revokeKey: (id: string) => http.request<ApiKeySummary>(`/account/keys/${id}/revoke`, { method: 'POST' }),
  deleteKey: (id: string) => http.request<{ ok: true }>(`/account/keys/${id}`, { method: 'DELETE' }),
};

/**
 * Is this failure the "verify your email before the portal opens" lockout?
 *
 * The server's guard answers every `/account/*` route with the SAME 403 for two
 * different situations — a suspended account and an unverified address — and it
 * distinguishes them only in prose we must not pattern-match. So the answer is
 * derived structurally instead, from a fact we already hold:
 *
 *  - `GET /account/auth/me` is `@AllowUnverified`, but it is NOT allow-suspended
 *    — the guard rejects a suspended account BEFORE it looks at verification.
 *    So a `customer` in hand is proof the account is active.
 *  - Given an active account, the only remaining source of a 403 from a
 *    verification-GATED route is the verification gate itself.
 *  - And `emailVerifiedAt` must be absent, or that gate cannot have fired.
 *
 * All three have to hold. A 403 on a customer whose address IS verified is some
 * other failure and must be left alone — offering a code entry for it would be
 * a second dead end dressed as a fix.
 */
export function isVerificationLockout(err: unknown, customer: Customer | null): boolean {
  if (httpStatus(err) !== 403) return false;
  if (!customer) return false;
  // MUST mirror the server rule in `CustomerJwtGuard`: the gate is about an
  // UNPROVEN address, so an account with no address at all is not locked out —
  // it has nothing to prove. Without this a wallet customer (SSO never invents
  // an email) would be shown a verify-to-continue screen offering a code for an
  // address that does not exist. Adding one is optional and lives in the portal.
  if (!customer.email) return false;
  return !customer.emailVerifiedAt;
}
