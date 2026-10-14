import { Prop, raw, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** Billing cadence of a `Plan.prices[]` entry. */
export const PLAN_PRICE_INTERVALS = ['month', 'year'] as const;

export type PlanPriceInterval = (typeof PLAN_PRICE_INTERVALS)[number];

/** ISO-4217 code every price defaults to. USDC is treated as exactly $1. */
export const DEFAULT_PRICE_CURRENCY = 'USD';

/**
 * Months actually charged on an annual price ("2 months free"). Applied ONCE,
 * when the price is derived, and then STORED as a literal amount — never as a
 * read-time multiplier, or editing the monthly price would silently reprice
 * every existing annual subscriber.
 */
const ANNUAL_MONTHS_CHARGED = 10;
const ANNUAL_DISPLAY_NOTE = '2 months free';

/**
 * One purchasable price on a plan.
 *
 * Annual is a PRICE, not a plan row: a second `pro_annual` plan key would fork
 * entitlement identity, because `Customer.planKey` is exactly what
 * `MeteringService` memoizes its limiters on and what `MeteringGuard` resolves
 * per request.
 */
export type PlanPrice = {
  /** Stable id (`pro_monthly`, `pro_annual`) — the merge key in `PlansService.update`. */
  id: string;
  interval: PlanPriceInterval;
  intervalCount: number;
  /** Money. ALWAYS an integer in MINOR units (cents) — never a float. */
  unitAmountMinor: number;
  currency: string;
  /** `false` hides it from checkout without deleting the historical amount. */
  active: boolean;
  /** Marketing line rendered next to the amount, e.g. `2 months free`. */
  displayNote?: string;
  /** The payment provider's own id for this price, once one exists. */
  providerPriceId?: string;
};

/** A `prices[]` entry as it arrives from an admin PATCH — partial except its identity. */
export type PlanPriceInput = {
  id: string;
  interval: PlanPriceInterval;
  unitAmountMinor: number;
} & Partial<PlanPrice>;

const PlanPriceDef = raw({
  id: { type: String, required: true },
  interval: { type: String, enum: PLAN_PRICE_INTERVALS, required: true },
  intervalCount: { type: Number, required: true, default: 1 },
  /** Money. ALWAYS an integer in MINOR units (cents) — never a float. */
  unitAmountMinor: { type: Number, required: true },
  currency: { type: String, required: true, default: DEFAULT_PRICE_CURRENCY },
  active: { type: Boolean, required: true, default: true },
  displayNote: { type: String },
  providerPriceId: { type: String },
});

@Schema({
  collection: 'plans',
  timestamps: true,
})
export class Plan {
  /** Stable lookup key referenced by `Customer.planKey` (e.g. `free`, `pro`). */
  @Prop({ type: String, required: true, unique: true, trim: true })
  key!: string;

  @Prop({ type: String, required: true })
  name!: string;

  /** Monthly unit budget. `0` = unlimited (quota check skipped). */
  @Prop({ type: Number, required: true, default: 0 })
  monthlyUnits!: number;

  /** Burst rate-limit, requests per minute, per API key. */
  @Prop({ type: Number, required: true, default: 60 })
  rateLimitPerMin!: number;

  /**
   * USD/month as a float. A MAINTAINED DENORMALISATION of the active monthly
   * `prices[]` amount, not an independent field: the admin table renders it and
   * `PlansService.list()` sorts on it, so `PlansService` recomputes whichever
   * side a write did not touch. `prices[].unitAmountMinor` is the money of
   * record; this is the display/sort mirror.
   */
  @Prop({ type: Number, default: 0 })
  price!: number;

  /** Purchasable prices (monthly + annual). See `PlanPrice`. */
  @Prop({ type: [PlanPriceDef], default: [] })
  prices!: PlanPrice[];

  /**
   * Whether the plan may be bought without an admin: it gates the public
   * pricing page and checkout ONLY. Defaults `false` so a newly-created plan
   * never appears on a public page until someone says so.
   */
  @Prop({ type: Boolean, default: false })
  selfServe!: boolean;

  /**
   * Abuse bound for open signup: how many ACTIVE keys a customer on this plan
   * may hold. `0` = unlimited. Enforced by the portal (`countActiveKeys`), NOT
   * by the admin key-issuing path. Defaults to the tightest real limit.
   */
  @Prop({ type: Number, default: 1 })
  maxApiKeys!: number;

  /** Whether the portal may mint origin-bound `browser` keys on this plan. */
  @Prop({ type: Boolean, default: false })
  allowBrowserKeys!: boolean;

  /** Pricing-page blurb. Public. */
  @Prop({ type: String, default: '' })
  description!: string;

  /** Pricing-page bullet list. Public. */
  @Prop({ type: [String], default: [] })
  features!: string[];

  /**
   * Retired plans stay `enabled: false` but KEEP WORKING for the customers on
   * them — metering never gates on this (see `MeteringGuard`). It only hides
   * the plan from the public list.
   */
  @Prop({ type: Boolean, default: true })
  enabled!: boolean;
}

export type PlanDocument = HydratedDocument<Plan>;
export const PlanSchema = SchemaFactory.createForClass(Plan);
// The unique index on `key` comes from `@Prop({ unique: true })` above. Declaring it a
// second time here made Mongoose warn "Duplicate schema index" at every boot (same index).

// ─── Pure money / price helpers (shared by PlansService + SettingsCache) ─────

/** Minor units (cents) → the float USD the `price` denormalisation carries. */
export function majorFromMinor(minor: number): number {
  return Math.round(minor) / 100;
}

/** Float USD → integer minor units. The only place a float becomes money. */
export function minorFromMajor(major: number): number {
  return Math.round(major * 100);
}

export function monthlyPriceId(planKey: string): string {
  return `${planKey}_monthly`;
}

export function annualPriceId(planKey: string): string {
  return `${planKey}_annual`;
}

/**
 * Fill a price entry's optionals, taking anything the caller omitted from
 * `base` (the stored entry being edited) before falling back to defaults. This
 * is what makes a partial PATCH of one field non-destructive.
 */
export function normalizePlanPrice(input: PlanPriceInput, base?: PlanPrice): PlanPrice {
  const price: PlanPrice = {
    id: input.id ?? base?.id ?? '',
    interval: input.interval ?? base?.interval ?? 'month',
    intervalCount: Math.max(1, Math.round(input.intervalCount ?? base?.intervalCount ?? 1)),
    unitAmountMinor: Math.round(input.unitAmountMinor ?? base?.unitAmountMinor ?? 0),
    currency: input.currency ?? base?.currency ?? DEFAULT_PRICE_CURRENCY,
    active: input.active ?? base?.active ?? true,
  };
  const displayNote = input.displayNote ?? base?.displayNote;
  if (displayNote !== undefined) price.displayNote = displayNote;
  const providerPriceId = input.providerPriceId ?? base?.providerPriceId;
  if (providerPriceId !== undefined) price.providerPriceId = providerPriceId;
  return price;
}

/**
 * Merge an incoming `prices[]` payload into the stored array BY `id`. Entries
 * the payload does not mention are PRESERVED — assigning the incoming array
 * wholesale (what `update` used to do) drops the annual price whenever the
 * admin form posts only the monthly one.
 */
export function mergePlanPrices(current: PlanPrice[], incoming: PlanPriceInput[]): PlanPrice[] {
  const merged = current.map((p) => normalizePlanPrice(p));
  for (const input of incoming) {
    const idx = merged.findIndex((p) => p.id === input.id);
    if (idx === -1) merged.push(normalizePlanPrice(input));
    else merged[idx] = normalizePlanPrice(input, merged[idx]);
  }
  return merged;
}

/**
 * A stored row's EFFECTIVE cadence. Mongoose applies `default: 1` only on a
 * write that goes through a model — a row written by the raw driver (the
 * backfill migration, a hand edit) or read back through `.lean()` (what
 * `SettingsCacheService.refresh` and `PlansService` both use) simply has NO
 * `intervalCount`. Matching strictly on `=== 1` classified those rows as
 * "not monthly", which is what let one plan carry two monthly prices.
 */
function effectiveIntervalCount(price: Partial<PlanPrice>): number {
  const raw = price.intervalCount;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
}

/** Same missing-default story for `active`, whose schema default is `true`. */
export function isActivePrice(price: Partial<PlanPrice>): boolean {
  return price.active !== false;
}

/** The one cadence the float `price` denormalisation mirrors: 1 month. */
export function isMonthlyPrice(price: Partial<PlanPrice>): boolean {
  return price.interval === 'month' && effectiveIntervalCount(price) === 1;
}

/**
 * How many ACTIVE 1-month prices a `prices[]` array carries. More than one is
 * always a defect.
 *
 * `activeMonthlyAmountMinor` resolves the float `price` denormalisation — and the
 * public pricing page — with `.find()`, so a second active monthly row means the
 * amount published is whichever one happens to sit earlier in the array. The
 * customer sees one price and checkout may charge the other, with nothing
 * anywhere reporting a conflict.
 *
 * Exported as a COUNT rather than a boolean so a caller can say how many it
 * found, which is the difference between an actionable error and "invalid".
 */
export function countActiveMonthlyPrices(prices: Array<Partial<PlanPrice>> | undefined): number {
  return (prices ?? []).filter((price) => isActivePrice(price) && isMonthlyPrice(price)).length;
}

/** Amount the float `price` mirrors: the active, 1-month price entry. */
export function activeMonthlyAmountMinor(prices: PlanPrice[] | undefined): number | undefined {
  const monthly = (prices ?? []).find((p) => isActivePrice(p) && isMonthlyPrice(p));
  return monthly?.unitAmountMinor;
}

/**
 * Mirror a newly-written float `price` onto the monthly `prices[]` entry,
 * creating it when the plan has none. The ANNUAL entry is deliberately left
 * alone: repricing it is an explicit `prices[]` edit, never a side effect.
 *
 * Repricing must never FORK the monthly price. The row it repriced is the row
 * `activeMonthlyAmountMinor` reads, and any other active monthly row is
 * deactivated on the way out — two active monthly prices cannot coexist,
 * however the data got that way (raw-driver backfill, hand edit, half-run
 * migration). Otherwise the public pricing page keeps publishing whichever of
 * the two it happens to find first, i.e. the stale amount.
 */
export function syncMonthlyAmount(planKey: string, prices: PlanPrice[], monthlyMajor: number): PlanPrice[] {
  const minor = minorFromMajor(monthlyMajor);
  const next = prices.map((p) => ({ ...p }));
  const monthlyIdxs = next.reduce<number[]>((acc, p, i) => (isMonthlyPrice(p) ? [...acc, i] : acc), []);
  const activeIdxs = monthlyIdxs.filter((i) => isActivePrice(next[i]));
  // Prefer the ACTIVE row — that is the one the pricing page reads. Falling
  // back to a deactivated one keeps the historical amount consistent with the
  // float `price` without silently putting a retired price back on sale.
  const targetIdx = activeIdxs.length > 0 ? activeIdxs[0] : (monthlyIdxs[0] ?? -1);
  if (targetIdx !== -1) {
    // Normalized, not spread: repricing is the moment to fill in the defaults a
    // raw-driver write never applied, so the row can never fork again.
    next[targetIdx] = { ...normalizePlanPrice(next[targetIdx]), unitAmountMinor: minor };
    for (const idx of activeIdxs) {
      if (idx !== targetIdx) next[idx] = { ...normalizePlanPrice(next[idx]), active: false };
    }
    return next;
  }
  // A $0 plan has nothing to sell — Free is granted at signup, not checked out.
  if (minor <= 0) return next;
  next.push({
    id: monthlyPriceId(planKey),
    interval: 'month',
    intervalCount: 1,
    unitAmountMinor: minor,
    currency: DEFAULT_PRICE_CURRENCY,
    active: true,
  });
  return next;
}

/**
 * The monthly + annual pair implied by a monthly dollar figure, used when a
 * plan is created from the float-only admin form. The annual amount is the
 * LITERAL `monthlyMinor * 10` — see `ANNUAL_MONTHS_CHARGED`.
 */
export function derivePlanPrices(planKey: string, monthlyMajor: number): PlanPrice[] {
  const monthlyMinor = minorFromMajor(monthlyMajor);
  if (monthlyMinor <= 0) return [];
  return [
    {
      id: monthlyPriceId(planKey),
      interval: 'month',
      intervalCount: 1,
      unitAmountMinor: monthlyMinor,
      currency: DEFAULT_PRICE_CURRENCY,
      active: true,
    },
    {
      id: annualPriceId(planKey),
      interval: 'year',
      intervalCount: 1,
      unitAmountMinor: monthlyMinor * ANNUAL_MONTHS_CHARGED,
      currency: DEFAULT_PRICE_CURRENCY,
      active: true,
      displayNote: ANNUAL_DISPLAY_NOTE,
    },
  ];
}
