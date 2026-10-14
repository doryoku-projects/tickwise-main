import { createHttpClient } from './http';

// Admin realm. Its token key and login path are deliberately distinct from the
// customer portal's (see portal-api.ts) so both sessions can coexist in one
// browser and a 401 in one realm never signs the other one out.
const http = createHttpClient({
  tokenKey: 'tk-admin-token',
  loginPath: '/admin/login',
  publicPaths: ['/admin/login'],
});

export function getToken(): string | null {
  return http.getToken();
}

export function setToken(token: string): void {
  http.setToken(token);
}

export function clearToken(): void {
  http.clearToken();
}

/**
 * One entry of `Plan.prices[]` as the API RETURNS it. Mongoose stores these as
 * subdocuments, so a read also carries an `_id` that is deliberately absent
 * here — see `PlanPriceInput` for why it must never be echoed back.
 */
export interface PlanPrice {
  /** Stable id (`pro_monthly`, `pro_annual`) — the MERGE KEY on a PATCH. */
  id: string;
  interval: 'month' | 'year';
  intervalCount?: number;
  /** Money. ALWAYS an integer in MINOR units (cents) — never a float. */
  unitAmountMinor: number;
  currency?: string;
  /** `false` hides it from checkout without deleting the historical amount. */
  active?: boolean;
  displayNote?: string;
  providerPriceId?: string;
}

export interface Plan {
  key: string;
  name: string;
  /** `0` = unlimited. */
  monthlyUnits: number;
  rateLimitPerMin: number;
  /** Float USD/month — a DENORMALISATION of the active monthly `prices[]` amount. */
  price: number;
  enabled: boolean;
  /** Whether the plan may be bought without an admin (public pricing page + checkout). */
  selfServe?: boolean;
  /** Active keys a customer on this plan may hold. `0` = unlimited. */
  maxApiKeys?: number;
  /** Whether the portal may mint origin-bound `browser` keys on this plan. */
  allowBrowserKeys?: boolean;
  description?: string;
  features?: string[];
  prices?: PlanPrice[];
}

/**
 * A `prices[]` entry as the admin API ACCEPTS it.
 *
 * Structurally identical to what a read returns MINUS the Mongoose subdocument
 * `_id`: the backend pipe is `forbidNonWhitelisted`, so echoing a read straight
 * back 400s the whole save on that one undeclared property. Callers must build
 * this field by field rather than spreading a fetched price.
 */
export type PlanPriceInput = PlanPrice;

/**
 * Writable plan fields. `prices` is MERGED BY `id` server-side, so a payload may
 * carry only the entries it changes — the others are preserved. Sending a
 * wholesale array would drop the annual price and mint new subdocument ids.
 */
export interface PlanWriteBody {
  name?: string;
  monthlyUnits?: number;
  rateLimitPerMin?: number;
  price?: number;
  enabled?: boolean;
  selfServe?: boolean;
  maxApiKeys?: number;
  allowBrowserKeys?: boolean;
  description?: string;
  features?: string[];
  prices?: PlanPriceInput[];
}

export interface CreatePlanBody extends PlanWriteBody {
  key: string;
  name: string;
  monthlyUnits: number;
  rateLimitPerMin: number;
}

export interface Client {
  _id: string;
  name: string;
  email?: string;
  status: 'active' | 'suspended';
  planKey: string;
  createdAt?: string;
}

export interface ApiKeyRow {
  _id: string;
  keyPrefix: string;
  label: string;
  status: 'active' | 'revoked';
  /** 'server' (backend-only, rejects browsers) or 'browser' (origin-bound). */
  keyType?: 'server' | 'browser';
  /** Browser origins this key may be used from (set ⟺ keyType==='browser'). */
  allowedOrigins?: string[];
  lastUsedAt?: string;
  createdAt?: string;
}

export interface IssuedKey extends ApiKeyRow {
  apiKey: string; // raw, shown once
}

export interface UsageRow {
  period: string;
  unitsConsumed: number;
  requestCount: number;
}

// ─── Usage detail (`usage_buckets`) ──────────────────────────────────────────
//
// `GET /admin/clients/:id/usage/detail` and the portal's own
// `GET /account/usage/detail` are ONE backend implementation
// (`ClientsService.getUsageDetail`) serving one response shape, so support and
// the customer are always reading the same numbers.
//
// These types are DUPLICATED in `portal-api.ts` rather than shared. The two
// realms' clients are deliberately separate modules — different token key,
// different login path, different 401 behaviour — and a types-only module
// bridging them would be the first file edge between them. The contract is
// pinned server-side by the single implementation, so the copies cannot drift
// into disagreeing about what the API returns.

/** One UTC day of the `series`. Structurally the chart's `UsageDayPoint`. */
export interface UsageDetailDay {
  /** 'YYYY-MM-DD', UTC — the bucket key, not a local calendar day. */
  day: string;
  units: number;
  requests: number;
}

export interface UsageDetailRoute {
  routeKey: string;
  /** Operator-editable display name from the `endpoint_costs` ladder. */
  label: string;
  /** The price this route was CHARGED at, resolved the way the guard resolves it. */
  unitCost: number;
  units: number;
  requests: number;
}

export interface UsageDetailKey {
  apiKeyId: string;
  /**
   * Snapshotted per bucket, because a key delete is a hard delete: these rows
   * outlive the key and there would otherwise be nothing left to render.
   */
  keyPrefix: string;
  keyLabel: string;
  units: number;
  requests: number;
}

export interface UsageDetailStatus {
  /** '2xx' | '4xx' | '5xx' | '429' — `429` is broken out of `4xx`, not part of it. */
  statusClass: string;
  requests: number;
  units: number;
}

export interface UsageDetail {
  /** The window the server actually served — NOT necessarily the one asked for. */
  range: { from: string; to: string };
  /** `limit` is the plan's monthly unit allowance; `0` = unlimited. */
  totals: { units: number; requests: number; limit: number };
  series: UsageDetailDay[];
  byRoute: UsageDetailRoute[];
  byKey: UsageDetailKey[];
  byStatus: UsageDetailStatus[];
}

/**
 * `from`/`to` are inclusive `YYYY-MM-DD` UTC bounds; omitting both asks for the
 * server's default of the current calendar month to date. The window is capped
 * server-side at 92 days and a wider one is a 400, not a silent clamp.
 *
 * `groupBy` narrows the response to ONE breakdown — the other three come back as
 * empty arrays, so the shape never changes.
 */
export interface UsageDetailParams {
  from?: string;
  to?: string;
  groupBy?: 'day' | 'routeKey' | 'apiKey' | 'status';
}

export interface EndpointCost {
  routeKey: string;
  label: string;
  unitCost: number;
  enabled: boolean;
}

export interface ChainMeta {
  chainId: number;
  slug: string;
  name: string;
  /** Protocols with an ENABLED integration on this chain (empty = chain is dark). */
  protocols: string[];
}

// ─── Billing: subscriptions / invoices / payments / revenue ──────────────────
//
// These mirror `backend/src/payments/schemas/*.schema.ts` as the admin routes
// serve them: `GET /admin/{subscriptions,invoices,payments}` return the RAW
// `.lean()` documents, so every field below is the schema's own name.
//
// TWO RULES THAT MUST SURVIVE ANY EDIT HERE.
//
// 1. EVERY `*Minor` FIELD IS AN INTEGER IN MINOR UNITS (cents) and is NEVER a
//    float. It is divided by 100 exactly once, at the render site, by
//    `formatMoneyMinor` in `lib/format.ts` — which also labels the currency.
//    Nothing may add a minor-unit number to a major-unit one.
// 2. Dates arrive as ISO STRINGS, not `Date`s: these come off the wire as JSON.
//    Typing them `Date` would compile and then render "[object Object]".

/** Stripe's status vocabulary verbatim — see `subscription.schema.ts`. */
export type AdminSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled';

export interface AdminSubscription {
  _id: string;
  customerId: string;
  planKey: string;
  priceId: string;
  interval: 'month' | 'year';
  /** Money. Integer MINOR units. LOCKED at subscribe time — not the plan's current price. */
  unitAmountMinor: number;
  status: AdminSubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  graceDays: number;
  graceEndsAt?: string;
  cancelAtPeriodEnd: boolean;
  canceledAt?: string;
  cancellationReason?: string;
  endedAt?: string;
  pendingPlanKey?: string;
  pendingPriceId?: string;
  pendingEffectiveAt?: string;
  latestInvoiceId?: string;
  /** Payment rail that owns this subscription (`x402`, `radom`, `manual`, `fake`). */
  provider: string;
  providerSubscriptionId?: string;
  startedAt: string;
  trialEndsAt?: string;
  /** Days past `currentPeriodEnd` with the renewal invoice still unpaid. */
  lateByDays: number;
  createdAt?: string;
  updatedAt?: string;
}

export type AdminInvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export interface AdminInvoice {
  _id: string;
  /** Monotonic human-facing invoice number — NOT the `_id`. */
  number: number;
  subscriptionId: string;
  customerId: string;
  /** WHAT THIS INVOICE BUYS — entitlement comes from here, not the subscription. */
  planKey: string;
  priceId: string;
  interval: 'month' | 'year';
  periodStart: string;
  periodEnd: string;
  /** Money. Integer MINOR units. List price before credit. */
  subtotalMinor: number;
  /** Money. Integer MINOR units. */
  creditAppliedMinor: number;
  /** Money. Integer MINOR units. `subtotalMinor - creditAppliedMinor`, frozen. */
  amountDueMinor: number;
  /** Money. Integer MINOR units. Accumulates across attempts. */
  amountPaidMinor: number;
  currency: string;
  status: AdminInvoiceStatus;
  /** Present while payable. `returnToken` is `select: false` and never served here. */
  checkout?: { provider: string; ref: string; hostedUrl?: string; expiresAt?: string };
  createdAt?: string;
  updatedAt?: string;
}

export type AdminPaymentStatus = 'pending' | 'succeeded' | 'failed';

export interface AdminPayment {
  _id: string;
  invoiceId: string;
  subscriptionId: string;
  customerId: string;
  provider: string;
  /** The rail's own charge id — the idempotency key. */
  providerPaymentId: string;
  status: AdminPaymentStatus;
  /** Money. Integer MINOR units, in `currency`. */
  amountMinor: number;
  currency: string;
  asset?: string;
  /** On-chain amount as a DECIMAL STRING (token amounts exceed 2^53). */
  assetAmount?: string;
  chainId?: number;
  txHash?: string;
  /** Money. Integer MINOR units received beyond the invoice's amount due. */
  overpaidMinor: number;
  reconciledBy?: string;
  note?: string;
  receivedAt: string;
  /**
   * ABSENT IS THE WORK QUEUE. A `succeeded` payment with no `appliedAt` is
   * money taken and not yet honoured — which is what `unappliedPayments`
   * counts and why the admin views surface it rather than footnote it.
   */
  appliedAt?: string;
  creditedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** `GET /admin/subscriptions/:id` — the subscription plus its whole money trail. */
export interface AdminSubscriptionDetail {
  subscription: AdminSubscription;
  invoices: AdminInvoice[];
  payments: AdminPayment[];
}

/** One live payment rail, from `PaymentProviderRegistry.list()`. Never a secret. */
export interface AdminPaymentRail {
  key: string;
  capabilities: {
    hostedCheckout: boolean;
    onChainDirect: boolean;
    recurring: boolean;
    webhooks: boolean;
    bodySignature: boolean;
    variableSettlement: boolean;
  };
}

/**
 * `GET /admin/revenue`.
 *
 * NOTE WHAT IS NOT HERE: no monthly time series and no period-over-period
 * deltas. `last30Days` is a ROLLING 30-day window (deliberately not a calendar
 * month — that version reads as a collapse on the 1st). Any "+12%" or bar chart
 * on this data would be invented, so the revenue view renders neither.
 */
export interface AdminRevenue {
  /** Money. Integer MINOR units. Live subscriptions' own locked amounts, annuals /12. */
  mrrMinor: number;
  /** Money. Integer MINOR units. Exactly `mrrMinor * 12` — not a separate measurement. */
  arrMinor: number;
  liveSubscriptions: number;
  last30Days: {
    newSubscriptions: number;
    churnedSubscriptions: number;
    /** Money. Integer MINOR units. Succeeded AND applied payments in the window. */
    collectedMinor: number;
  };
  byPlan: Array<{
    planKey: string;
    planName: string;
    subscriptions: number;
    /** Money. Integer MINOR units. */
    mrrMinor: number;
  }>;
  /** Payments taken and not yet honoured. The number an operator must act on. */
  unappliedPayments: number;
  rails: AdminPaymentRail[];
}

/**
 * `GET /admin/clients/:id` — the raw customer document.
 *
 * `passwordHash` and the token hashes are `select: false` server-side, so they
 * are structurally absent here rather than merely omitted from this type.
 */
export interface ClientDetail extends Client {
  emailVerifiedAt?: string;
  /** A STAGED address: claimed, not yet proved. Never the account's identity. */
  pendingEmail?: string;
  lastLoginAt?: string;
  passwordChangedAt?: string;
  origin?: 'admin' | 'self_serve';
  currentSubscriptionId?: string;
  /** Money. Integer MINOR units held on the account. */
  creditBalanceMinor: number;
  /** `admin` means an operator chose this plan and the sweep must not revert it. */
  planSource?: 'subscription' | 'admin';
  intendedPlanKey?: string;
  updatedAt?: string;
}

/**
 * Build `?a=1&b=2`, dropping anything unset.
 *
 * `false` is dropped too, on purpose: `unapplied` is read server-side as the
 * literal string `'true'`, so sending `unapplied=false` would be a no-op query
 * parameter that merely looks like it filters.
 */
function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

const request = http.request;

export const adminApi = {
  login: (email: string, password: string) =>
    request<{ token: string; email: string; role: string }>('/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<{ email: string; role: string }>('/admin/auth/me'),

  // clients
  listClients: () => request<Client[]>('/admin/clients'),
  createClient: (body: { name: string; email?: string; planKey?: string }) =>
    request<Client>('/admin/clients', { method: 'POST', body: JSON.stringify(body) }),
  assignPlan: (id: string, planKey: string) =>
    request<Client>(`/admin/clients/${id}/plan`, { method: 'PATCH', body: JSON.stringify({ planKey }) }),
  getUsage: (id: string) => request<UsageRow[]>(`/admin/clients/${id}/usage`),

  /**
   * Per-day / per-endpoint / per-key / per-status detail for one client.
   *
   * A malformed `id` 404s server-side rather than degrading into a list, so an
   * error here is never another customer's data.
   */
  usageDetail: (id: string, params: UsageDetailParams = {}) =>
    request<UsageDetail>(
      // Spread field by field rather than handing `queryString` the interface:
      // it takes an index-signature record, which a declared interface does not
      // satisfy, and widening its parameter would let any object through.
      `/admin/clients/${encodeURIComponent(id)}/usage/detail${queryString({
        from: params.from,
        to: params.to,
        groupBy: params.groupBy,
      })}`,
    ),

  /** The whole customer document. `listClients` returns the same shape, trimmed. */
  getClient: (id: string) => request<ClientDetail>(`/admin/clients/${encodeURIComponent(id)}`),

  // keys
  listKeys: (id: string) => request<ApiKeyRow[]>(`/admin/clients/${id}/keys`),
  issueKey: (id: string, body: { label?: string; keyType?: 'server' | 'browser'; origins?: string[] } = {}) =>
    request<IssuedKey>(`/admin/clients/${id}/keys`, { method: 'POST', body: JSON.stringify(body) }),
  revokeKey: (keyId: string) => request<ApiKeyRow>(`/admin/keys/${keyId}/revoke`, { method: 'POST' }),
  // Replace a key's allowed browser origins (CORS + per-key origin binding).
  setKeyOrigins: (keyId: string, origins: string[]) =>
    request<ApiKeyRow>(`/admin/keys/${keyId}/origins`, { method: 'PATCH', body: JSON.stringify({ origins }) }),
  deleteKey: (keyId: string) => request<{ deleted: string }>(`/admin/keys/${keyId}`, { method: 'DELETE' }),

  // plans
  listPlans: () => request<Plan[]>('/admin/plans'),
  createPlan: (body: CreatePlanBody) => request<Plan>('/admin/plans', { method: 'POST', body: JSON.stringify(body) }),
  updatePlan: (key: string, body: PlanWriteBody) =>
    request<Plan>(`/admin/plans/${key}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePlan: (key: string) => request<{ deleted: string }>(`/admin/plans/${key}`, { method: 'DELETE' }),

  // endpoint costs
  listEndpointCosts: () => request<EndpointCost[]>('/admin/endpoint-costs'),
  updateEndpointCost: (routeKey: string, body: Partial<EndpointCost>) =>
    request<EndpointCost>(`/admin/endpoint-costs/${encodeURIComponent(routeKey)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // chains with an enabled integration (free /v1 metadata) — feeds the ops chain selector
  listChains: () => request<ChainMeta[]>('/v1/chains'),

  // ops — JWT-gated sync trigger (moved out of the public dashboard)
  runSync: (body: { chainId?: number; protocol?: string; all?: boolean; fromStart?: boolean } = {}) =>
    request<unknown>('/admin/ops/sync', { method: 'POST', body: JSON.stringify(body) }),

  // ops — JWT-gated pool sync trigger (walks subgraph pools, re-values TVL)
  runPoolsSync: (body: { chainId?: number; protocol?: string; all?: boolean } = {}) =>
    request<unknown>('/admin/ops/sync-pools', { method: 'POST', body: JSON.stringify(body) }),

  // ops — JWT-gated token-security sweep (GoPlus honeypot/blacklist check)
  runTokenSecuritySync: (body: { chainId?: number; protocol?: string; all?: boolean } = {}) =>
    request<unknown>('/admin/ops/sync-token-security', { method: 'POST', body: JSON.stringify(body) }),

  // ─── Billing (READ-ONLY) ──────────────────────────────────────────────────
  //
  // Deliberately no `mark-paid`, `mark-status`, `resync` or `sweep` wrapper.
  // Those are irreversible financial writes: `mark-paid` runs the same
  // entitlement fold a webhook does and `mark-status` is the documented escape
  // hatch. They are out of scope for this pass, and a method sitting here
  // unused is how one gets called by accident.

  /** `status` accepts a literal status OR `live` (the non-terminal set). Server caps `limit` at 200. */
  listSubscriptions: (params: { status?: string; customerId?: string; limit?: number } = {}) =>
    request<AdminSubscription[]>(`/admin/subscriptions${queryString(params)}`),
  getSubscription: (id: string) =>
    request<AdminSubscriptionDetail>(`/admin/subscriptions/${encodeURIComponent(id)}`),

  /** `unapplied: true` narrows to money taken and not yet honoured. */
  listPayments: (params: { customerId?: string; unapplied?: boolean; limit?: number } = {}) =>
    request<AdminPayment[]>(`/admin/payments${queryString(params)}`),

  listInvoices: (params: { status?: string; customerId?: string; limit?: number } = {}) =>
    request<AdminInvoice[]>(`/admin/invoices${queryString(params)}`),

  getRevenue: () => request<AdminRevenue>('/admin/revenue'),
};
