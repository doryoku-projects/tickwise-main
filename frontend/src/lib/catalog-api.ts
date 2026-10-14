import { createHttpClient } from './http';

/**
 * Public product catalogue — plans and per-endpoint unit costs. Unmetered `/v1`
 * routes that take no key and never 401, so this client carries no token: a
 * customer JWT must never leak onto a public route (a stray 401 there would
 * sign them out).
 */
const http = createHttpClient({ tokenKey: null });

export interface PlanPrice {
  /** Opaque price id — what checkout is started with. */
  id: string;
  /** 'month' | 'year' today; treated as an open string so a new interval renders. */
  interval: string;
  /** Price in minor units (cents). 0 = free. */
  unitAmountMinor: number;
  currency: string;
  /** e.g. "2 months free" — shown under the amount when present. */
  displayNote?: string | null;
}

/**
 * A plan as served by `GET /v1/plans`. Everything past `key`/`name` is optional
 * because `GET /account/overview` embeds a leaner copy of the same shape.
 */
export interface ApiPlan {
  key: string;
  name: string;
  description?: string | null;
  features?: string[];
  /** 0 = unlimited (matches the admin plan editor's convention). */
  monthlyUnits: number;
  rateLimitPerMin: number;
  maxApiKeys?: number;
  allowBrowserKeys?: boolean;
  /** false = "talk to us" rather than a self-serve checkout. */
  selfServe?: boolean;
  prices?: PlanPrice[];
}

export interface UnitCost {
  routeKey: string;
  cost: number;
  description?: string | null;
}

export const catalogApi = {
  listPlans: () => http.request<{ plans: ApiPlan[] }>('/v1/plans'),
  listUnitCosts: () => http.request<{ units: UnitCost[] }>('/v1/pricing/units'),
};
