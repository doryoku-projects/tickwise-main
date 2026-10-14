/**
 * First-boot plan tiers, and the reconciliation source of truth.
 *
 * `SettingsCacheService.seedIfEmpty` inserts these ONLY when the `plans`
 * collection is empty — thereafter the admin panel owns the VALUES, and editing
 * an amount or a limit here has no effect on an already-seeded database.
 *
 * What this list still governs on an existing install is the FIELD SET. A
 * database seeded before `maxApiKeys` / `allowBrowserKeys` / `description` /
 * `features` existed has plan rows with those fields simply absent, and
 * `SettingsCacheService.refresh` normalizes an absent value FAIL-CLOSED (1 key,
 * no browser keys, no copy) — so every tier, paid ones included, silently
 * collapses to the Free entitlement. `scripts/billing-subscriptions-migration.mjs`
 * reconciles that: for each key below it fills any field that is absent or
 * empty and leaves every value an operator actually chose alone. ADDING a field
 * here therefore means: add it to `Plan`, add it to the field-by-field copy in
 * `SettingsCacheService.refresh`, and add it to `RECONCILED_PLAN_FIELDS` in the
 * migration — otherwise existing installs never get it.
 */
// Type-only import: erased at compile time, so this file stays runtime
// dependency-free (it sits on `customer.schema.ts`'s import path).
import type { PlanPrice } from './plan.schema.js';

export interface SeedPlan {
  key: string;
  name: string;
  monthlyUnits: number;
  rateLimitPerMin: number;
  /** Float USD/month — the maintained denormalisation of the monthly price. */
  price: number;
  enabled: boolean;
  /** Gates the public pricing page + checkout ONLY, never metering. */
  selfServe: boolean;
  /** Active-key ceiling for the portal. `0` = unlimited. */
  maxApiKeys: number;
  allowBrowserKeys: boolean;
  description: string;
  features: string[];
  /** Purchasable prices. Empty = nothing to check out (granted, or sales-led). */
  prices: PlanPrice[];
}

const COVERAGE = 'Uniswap v4 on Ethereum, Arbitrum and Avalanche';

export const PLAN_SEEDS: SeedPlan[] = [
  {
    key: 'free',
    name: 'Free',
    monthlyUnits: 50_000,
    rateLimitPerMin: 60,
    price: 0,
    enabled: true,
    // On the pricing page, but granted at signup rather than bought — hence no
    // price row. One server-only key bounds abuse on open signup.
    selfServe: true,
    maxApiKeys: 1,
    allowBrowserKeys: false,
    description: `Evaluate the API on ${COVERAGE}.`,
    features: ['50,000 units / month', '60 requests / minute', '1 server key'],
    prices: [],
  },
  {
    key: 'standard',
    name: 'Standard',
    monthlyUnits: 5_000_000,
    rateLimitPerMin: 300,
    price: 99,
    enabled: true,
    selfServe: true,
    maxApiKeys: 5,
    allowBrowserKeys: true,
    description: `Production access to ${COVERAGE}.`,
    features: ['5,000,000 units / month', '300 requests / minute', '5 keys', 'Browser keys with origin binding'],
    prices: [
      { id: 'standard_monthly', interval: 'month', intervalCount: 1, unitAmountMinor: 9_900, currency: 'USD', active: true },
      // Literal 10 × the monthly amount, stored — never a read-time multiplier.
      { id: 'standard_annual', interval: 'year', intervalCount: 1, unitAmountMinor: 99_000, currency: 'USD', active: true, displayNote: '2 months free' },
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    monthlyUnits: 50_000_000,
    rateLimitPerMin: 600,
    price: 790,
    enabled: true,
    selfServe: true,
    maxApiKeys: 20,
    allowBrowserKeys: true,
    description: `High-volume access to ${COVERAGE}.`,
    features: ['50,000,000 units / month', '600 requests / minute', '20 keys', 'Browser keys with origin binding'],
    prices: [
      { id: 'pro_monthly', interval: 'month', intervalCount: 1, unitAmountMinor: 79_000, currency: 'USD', active: true },
      { id: 'pro_annual', interval: 'year', intervalCount: 1, unitAmountMinor: 790_000, currency: 'USD', active: true, displayNote: '2 months free' },
    ],
  },
  {
    // monthlyUnits 0 = unlimited quota; maxApiKeys 0 = unlimited keys.
    // selfServe FALSE — sales-led, so it never appears on the public pricing
    // page and cannot be checked out.
    key: 'enterprise',
    name: 'Enterprise',
    monthlyUnits: 0,
    rateLimitPerMin: 1200,
    price: 0,
    enabled: true,
    selfServe: false,
    maxApiKeys: 0,
    allowBrowserKeys: true,
    description: `Custom limits and terms across ${COVERAGE}.`,
    features: ['Unlimited units', '1,200 requests / minute', 'Unlimited keys'],
    prices: [],
  },
];

export const DEFAULT_PLAN_KEY = 'free';
