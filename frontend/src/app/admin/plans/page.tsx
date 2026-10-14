'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  type CreatePlanBody,
  type Plan,
  type PlanPrice,
  type PlanPriceInput,
  type PlanWriteBody,
} from '../../../lib/admin-api';

/**
 * Defaults the SERVER applies when a stored plan doc simply has no such field.
 * Plans created before these columns existed carry none of them, and Mongoose
 * defaults only ever fire on a write — so `SettingsCacheService.refresh`
 * normalizes the read fail-closed. Mirror it exactly, or the panel would show
 * an entitlement the API does not actually grant.
 */
const FIELD_DEFAULTS = {
  selfServe: false,
  maxApiKeys: 1,
  allowBrowserKeys: false,
  description: '',
  features: [] as string[],
};

/** Months actually charged on a derived annual price — mirrors `plan.schema.ts`. */
const ANNUAL_MONTHS_CHARGED = 10;
const ANNUAL_DISPLAY_NOTE = '2 months free';
const DEFAULT_CURRENCY = 'USD';

/** Everything the editor owns for one plan. Never holds `_id`/`__v`/timestamps. */
interface Draft {
  name: string;
  monthlyUnits: number;
  rateLimitPerMin: number;
  enabled: boolean;
  selfServe: boolean;
  maxApiKeys: number;
  allowBrowserKeys: boolean;
  description: string;
  features: string[];
  prices: PlanPrice[];
}

const BLANK_CREATE = {
  key: '',
  name: '',
  monthlyUnits: 0,
  rateLimitPerMin: 60,
  price: 0,
  maxApiKeys: 1,
  selfServe: false,
  allowBrowserKeys: false,
};

// ─── pure helpers ───────────────────────────────────────────────────────────

/**
 * A stored row's EFFECTIVE cadence / active flag. Same story as the backend's
 * `effectiveIntervalCount`: a row written by the raw driver (a migration, a
 * hand edit) carries no `intervalCount`, and treating that as "not monthly"
 * is what lets a plan grow a second monthly price.
 */
function effectiveIntervalCount(price: PlanPrice): number {
  const raw = price.intervalCount;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
}

function isActivePrice(price: PlanPrice): boolean {
  return price.active !== false;
}

function isMonthlyPrice(price: PlanPrice): boolean {
  return price.interval === 'month' && effectiveIntervalCount(price) === 1;
}

/**
 * The one row the float `price` denormalisation mirrors, chosen exactly like
 * the backend's `syncMonthlyAmount`: the ACTIVE monthly row, falling back to a
 * deactivated one. Picking a different row here would fork the monthly price.
 */
function findMonthlyRow(prices: PlanPrice[]): PlanPrice | undefined {
  return prices.find((p) => isActivePrice(p) && isMonthlyPrice(p)) ?? prices.find((p) => isMonthlyPrice(p));
}

/** Minor units (cents) → a human amount. Display only; money stays integer. */
function formatMajor(minor: number, currency = DEFAULT_CURRENCY): string {
  const major = Math.round(minor) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

/** Parse a number input, clamped to an integer floor. Empty field → `min`. */
function intFrom(value: string, min = 0): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, n) : min;
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function samePrice(a: PlanPrice, b: PlanPrice): boolean {
  return (
    a.id === b.id &&
    a.interval === b.interval &&
    effectiveIntervalCount(a) === effectiveIntervalCount(b) &&
    Math.round(a.unitAmountMinor) === Math.round(b.unitAmountMinor) &&
    (a.currency ?? DEFAULT_CURRENCY) === (b.currency ?? DEFAULT_CURRENCY) &&
    isActivePrice(a) === isActivePrice(b) &&
    (a.displayNote ?? '') === (b.displayNote ?? '')
  );
}

/**
 * Build the wire form of one price entry FIELD BY FIELD.
 *
 * A fetched price also carries the Mongoose subdocument `_id`, and the backend
 * pipe is `forbidNonWhitelisted` — spreading a read straight back would 400 the
 * entire save on that one undeclared property.
 */
function toPriceInput(price: PlanPrice): PlanPriceInput {
  const input: PlanPriceInput = {
    id: price.id,
    interval: price.interval,
    intervalCount: effectiveIntervalCount(price),
    unitAmountMinor: Math.max(0, Math.round(price.unitAmountMinor)),
    currency: price.currency ?? DEFAULT_CURRENCY,
    active: isActivePrice(price),
  };
  if (price.displayNote !== undefined) input.displayNote = price.displayNote;
  if (price.providerPriceId !== undefined) input.providerPriceId = price.providerPriceId;
  return input;
}

function toDraft(plan: Plan): Draft {
  return {
    name: plan.name,
    monthlyUnits: plan.monthlyUnits,
    rateLimitPerMin: plan.rateLimitPerMin,
    enabled: plan.enabled,
    selfServe: plan.selfServe ?? FIELD_DEFAULTS.selfServe,
    maxApiKeys: plan.maxApiKeys ?? FIELD_DEFAULTS.maxApiKeys,
    allowBrowserKeys: plan.allowBrowserKeys ?? FIELD_DEFAULTS.allowBrowserKeys,
    description: plan.description ?? FIELD_DEFAULTS.description,
    features: [...(plan.features ?? FIELD_DEFAULTS.features)],
    prices: (plan.prices ?? []).map((p) => ({ ...p })),
  };
}

/**
 * The PATCH body for one plan: only what actually changed.
 *
 * `prices` carries just the touched entries — the server merges them into the
 * stored array BY `id`, so untouched rows (the annual price) survive and keep
 * their subdocument ids. A wholesale array would replace both.
 *
 * The float `price` is deliberately NOT sent: it is a denormalisation of the
 * active monthly amount, and `PlansService.update` recomputes it from the
 * merged `prices[]`. Sending both would let the two disagree.
 */
function buildPatch(base: Draft, next: Draft): PlanWriteBody {
  const body: PlanWriteBody = {};
  if (next.name !== base.name) body.name = next.name;
  if (next.monthlyUnits !== base.monthlyUnits) body.monthlyUnits = next.monthlyUnits;
  if (next.rateLimitPerMin !== base.rateLimitPerMin) body.rateLimitPerMin = next.rateLimitPerMin;
  if (next.enabled !== base.enabled) body.enabled = next.enabled;
  if (next.selfServe !== base.selfServe) body.selfServe = next.selfServe;
  if (next.maxApiKeys !== base.maxApiKeys) body.maxApiKeys = next.maxApiKeys;
  if (next.allowBrowserKeys !== base.allowBrowserKeys) body.allowBrowserKeys = next.allowBrowserKeys;
  if (next.description !== base.description) body.description = next.description;
  if (!sameStrings(next.features, base.features)) body.features = next.features;

  const touched = next.prices.filter((price) => {
    const stored = base.prices.find((p) => p.id === price.id);
    // A brand-new row at $0 is not a price — the backend likewise refuses to
    // mint a monthly row for a plan that costs nothing.
    if (!stored) return Math.round(price.unitAmountMinor) > 0;
    return !samePrice(stored, price);
  });
  if (touched.length > 0) body.prices = touched.map(toPriceInput);
  return body;
}

// ─── chip editor (same pattern as OriginsInput on the clients page) ─────────

function FeaturesInput({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');

  function add() {
    const entry = draft.trim();
    if (!entry || value.includes(entry)) {
      setDraft('');
      return;
    }
    onChange([...value, entry]);
    setDraft('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.length > 0 && (
        <div className="admin-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {value.map((feature) => (
            <span key={feature} className="admin-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {feature}
              <button
                type="button"
                aria-label={`Remove ${feature}`}
                onClick={() => onChange(value.filter((x) => x !== feature))}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 14 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="admin-row" style={{ gap: 6 }}>
        <input
          className="admin-input"
          placeholder="Pricing-page bullet, e.g. 5M units / month"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          style={{ minWidth: 240, flex: 1 }}
        />
        <button type="button" className="admin-btn ghost sm" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

// ─── per-plan detail panel ──────────────────────────────────────────────────

/**
 * The fields that do not fit a table row: entitlement flags, public copy, and
 * the full `prices[]` list.
 *
 * It renders BELOW the table rather than as an expanded `colSpan` row on
 * purpose. A cell's content sizes its table, so putting prose and a nested
 * table inside one stretched the whole grid far past the viewport and squashed
 * every column — the row stays narrow, the panel gets the full card width.
 */
function PlanDetails({
  planKey,
  plan,
  onEdit,
  onEditPrice,
  onAddAnnual,
  onClose,
}: {
  planKey: string;
  plan: Draft;
  onEdit: (patch: Partial<Draft>) => void;
  onEditPrice: (priceId: string, patch: Partial<PlanPrice>) => void;
  onAddAnnual: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-4 border-t border-border pt-3.5">
      <div className="admin-row" style={{ justifyContent: 'space-between' }}>
        <h3 className="admin-h" style={{ margin: 0 }}>
          {planKey} — details
        </h3>
        <button className="admin-btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22, paddingTop: 12 }}>
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 320px', minWidth: 0 }}>
          <h4 className="admin-h" style={{ margin: 0 }}>
            Entitlements &amp; visibility
          </h4>
          <label className="admin-row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={plan.selfServe} onChange={(e) => onEdit({ selfServe: e.target.checked })} />
            <span>Self-serve — buyable without an admin (public pricing page + checkout)</span>
          </label>
          <label className="admin-row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={plan.allowBrowserKeys}
              onChange={(e) => onEdit({ allowBrowserKeys: e.target.checked })}
            />
            <span>Allow browser keys — the portal may mint origin-bound frontend keys on this plan</span>
          </label>
          <p className="admin-note" style={{ margin: 0 }}>
            Max keys ({plan.maxApiKeys === 0 ? 'unlimited' : plan.maxApiKeys}) is edited in the row above and bounds the
            ACTIVE keys a customer on this plan may hold. Disabling a plan hides it from the public list but keeps the
            customers already on it working.
          </p>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 320px', minWidth: 0 }}>
          <h4 className="admin-h" style={{ margin: 0 }}>
            Pricing-page copy
          </h4>
          <textarea
            className="admin-input"
            rows={3}
            placeholder="Short blurb shown under the plan name (public)"
            value={plan.description}
            onChange={(e) => onEdit({ description: e.target.value })}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
          />
          <FeaturesInput value={plan.features} onChange={(features) => onEdit({ features })} />
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 100%', minWidth: 0 }}>
          <h4 className="admin-h" style={{ margin: 0 }}>
            Prices
          </h4>
          {plan.prices.length === 0 ? (
            <p className="admin-note" style={{ margin: 0 }}>
              No price rows — set a monthly amount in the row above to create one.
            </p>
          ) : (
            /* `stackTable`, not a scroller: six columns of price fields measure
               far wider than the details panel on a phone, and a sideways drag
               over EDITABLE cells means half the form is discoverable only by
               scrubbing. Each price becomes a card of labelled fields below
               720px; `stackTableWrap` turns the wrapper's own scroll off once
               they do, so there is no empty drag range left behind (a
               `display: block` table keeps reporting its column-sum
               `scrollWidth`). Above 720px this is byte-for-byte the same table
               it was, with the wrapper now supplying the 721–1024px scroll the
               bare `overflow-x: auto` div was doing by hand. */
            <div className="tableWrap stackTableWrap">
              <table className="admin-table stackTable">
                <thead>
                  <tr>
                    <th>Price id</th>
                    <th>Interval</th>
                    <th>Amount (minor)</th>
                    <th>Equivalent</th>
                    <th>Active</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.prices.map((price) => (
                    <tr key={price.id}>
                      <td data-label="Price id">{price.id}</td>
                      <td data-label="Interval">
                        {effectiveIntervalCount(price) === 1
                          ? price.interval
                          : `${effectiveIntervalCount(price)} × ${price.interval}`}
                      </td>
                      <td data-label="Amount (minor)">
                        <input
                          className="admin-input"
                          type="number"
                          min={0}
                          step={1}
                          style={{ width: 110 }}
                          value={price.unitAmountMinor}
                          onChange={(e) => onEditPrice(price.id, { unitAmountMinor: intFrom(e.target.value, 0) })}
                        />
                      </td>
                      <td data-label="Equivalent">{formatMajor(price.unitAmountMinor, price.currency)}</td>
                      <td data-label="Active">
                        <input
                          type="checkbox"
                          checked={isActivePrice(price)}
                          onChange={(e) => onEditPrice(price.id, { active: e.target.checked })}
                        />
                      </td>
                      <td data-label="Note">
                        <input
                          className="admin-input"
                          style={{ width: 170 }}
                          placeholder="e.g. 2 months free"
                          value={price.displayNote ?? ''}
                          onChange={(e) => onEditPrice(price.id, { displayNote: e.target.value })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!plan.prices.some((price) => price.interval === 'year') && (
            <div className="admin-row">
              <button className="admin-btn ghost sm" onClick={onAddAnnual}>
                Add annual price
              </button>
            </div>
          )}
          <p className="admin-note" style={{ margin: 0 }}>
            Ids and intervals are fixed: the id is the MERGE KEY, so a save sends only the rows you touched and every
            other price — with its stored id — survives. The plan&apos;s dollar <code>price</code> field is a
            denormalisation the server recomputes from the active monthly row, so it is never sent from here.
          </p>
        </section>
      </div>
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [base, setBase] = useState<Record<string, Draft>>({});
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(BLANK_CREATE);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    try {
      const p = await adminApi.listPlans();
      setPlans(p);
      const drafts = Object.fromEntries(p.map((x) => [x.key, toDraft(x)]));
      setBase(drafts);
      setDraft(Object.fromEntries(p.map((x) => [x.key, toDraft(x)])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(key: string, patch: Partial<Draft>) {
    setSaved('');
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  }

  /** Edit one `prices[]` entry in place, keyed by its merge id. */
  function editPrice(key: string, priceId: string, patch: Partial<PlanPrice>) {
    setSaved('');
    setDraft((d) => ({
      ...d,
      [key]: { ...d[key], prices: d[key].prices.map((p) => (p.id === priceId ? { ...p, ...patch } : p)) },
    }));
  }

  /**
   * Set the active monthly amount, materializing the row when the plan has
   * none. The id matches the backend's `monthlyPriceId()` so a row created here
   * is the same row `syncMonthlyAmount` would have created.
   */
  function setMonthlyMinor(key: string, minor: number) {
    setSaved('');
    setDraft((d) => {
      const current = d[key];
      // Reuse an existing row whenever one could collide — by cadence first,
      // then by the very id an append would use. Two rows sharing an id would
      // make the merge ambiguous and break React's keying.
      const monthly = findMonthlyRow(current.prices) ?? current.prices.find((p) => p.id === `${key}_monthly`);
      if (monthly) {
        return {
          ...d,
          [key]: {
            ...current,
            prices: current.prices.map((p) => (p.id === monthly.id ? { ...p, unitAmountMinor: minor } : p)),
          },
        };
      }
      return {
        ...d,
        [key]: {
          ...current,
          prices: [
            ...current.prices,
            {
              id: `${key}_monthly`,
              interval: 'month' as const,
              intervalCount: 1,
              unitAmountMinor: minor,
              currency: DEFAULT_CURRENCY,
              active: true,
            },
          ],
        },
      };
    });
  }

  /** Offer the monthly + annual pair the create path derives, when it is missing. */
  function addAnnual(key: string) {
    setSaved('');
    setDraft((d) => {
      const current = d[key];
      if (current.prices.some((p) => p.interval === 'year' || p.id === `${key}_annual`)) return d;
      const monthlyMinor = findMonthlyRow(current.prices)?.unitAmountMinor ?? 0;
      return {
        ...d,
        [key]: {
          ...current,
          prices: [
            ...current.prices,
            {
              id: `${key}_annual`,
              interval: 'year' as const,
              intervalCount: 1,
              unitAmountMinor: monthlyMinor * ANNUAL_MONTHS_CHARGED,
              currency: DEFAULT_CURRENCY,
              active: true,
              displayNote: ANNUAL_DISPLAY_NOTE,
            },
          ],
        },
      };
    });
  }

  async function save(key: string) {
    setError('');
    setSaved('');
    const body = buildPatch(base[key], draft[key]);
    if (Object.keys(body).length === 0) {
      setSaved(`No changes to save on '${key}'.`);
      return;
    }
    try {
      await adminApi.updatePlan(key, body);
      await load();
      setSaved(`Saved ${Object.keys(body).join(', ')} on '${key}'.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  function reset(key: string) {
    setSaved('');
    setError('');
    setDraft((d) => ({ ...d, [key]: { ...base[key], features: [...base[key].features], prices: base[key].prices.map((p) => ({ ...p })) } }));
  }

  async function remove(key: string) {
    if (!confirm(`Delete plan '${key}'?`)) return;
    setError('');
    setSaved('');
    try {
      await adminApi.deletePlan(key);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaved('');
    const body: CreatePlanBody = {
      key: creating.key.trim(),
      name: creating.name.trim(),
      monthlyUnits: creating.monthlyUnits,
      rateLimitPerMin: creating.rateLimitPerMin,
      price: creating.price,
      maxApiKeys: creating.maxApiKeys,
      selfServe: creating.selfServe,
      allowBrowserKeys: creating.allowBrowserKeys,
      enabled: true,
    };
    try {
      await adminApi.createPlan(body);
      setCreating(BLANK_CREATE);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  }

  return (
    <div>
      {/* The page title is Tickwise markup; the editor below it is still the
          `.admin-*` table, re-painted by the `tw-bridge` layer. */}
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Plans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The catalog behind metering, the pricing page and self-serve checkout.
        </p>
      </div>

      <div className="admin-card">
        <p className="admin-note">
          <strong>0 = unlimited</strong> for both monthly units and max API keys. Money is stored in MINOR units (cents);
          the amount beside each field is the same figure in dollars. Changes apply to live metering immediately.
        </p>
        {error && <div className="admin-error">{error}</div>}
        {saved && <div className="admin-ok">{saved}</div>}
        {/* THE TABLE `.stackTable` WAS MEASURED ON. panel.css records it: at
            375px this rendered 944px wide inside a 293px wrapper, so five of
            six columns — the price among them — were off-screen, and every one
            of them holds an INPUT. A scroller is the right answer for a
            read-only ops grid; it is the wrong one for a form, where a field
            you cannot see is a field you do not know exists.

            `cardTable plansCards`, NOT `stackTable`, and the difference is the
            geometry only — see the `plansCards` block in panel.css. Stacking
            gave each of the eight fields a full-width row, so 70–130px boxes
            sat at the left of a 293px line and one plan ran 624px tall. The
            grid pairs the short numerics, spans the two cells that carry prose,
            keeps the labels (this is the one card that does — they are field
            names, not captions) and lets every input fill its cell.

            `stackTableWrap` alongside `tableWrap`: the pair supplies the
            721–1024px sideways scroll that the bare `overflow-x: auto` div did
            by hand, and switches it OFF below 720px where the cards make it a
            drag over nothing. */}
        <div className="tableWrap stackTableWrap">
          <table className="admin-table cardTable plansCards">
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th>Monthly units</th>
                <th>Rate / min</th>
                <th>Monthly price (cents)</th>
                <th>Max keys</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const d = draft[p.key];
                if (!d) return null;
                const open = expanded === p.key;
                const monthly = findMonthlyRow(d.prices);
                const monthlyMinor = monthly?.unitAmountMinor ?? 0;
                const dirty = Object.keys(buildPatch(base[p.key], d)).length > 0;
                return (
                  <tr key={p.key} className={open ? 'bg-surface-2/60' : undefined}>
                    <td data-cell="identity" data-label="Key">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span>{p.key}</span>
                        <div className="admin-row" style={{ gap: 4 }}>
                          {d.selfServe && <span className="admin-pill">self-serve</span>}
                          {d.allowBrowserKeys && <span className="admin-pill">browser keys</span>}
                          {d.features.length > 0 && <span className="admin-pill">{d.features.length} features</span>}
                        </div>
                      </div>
                    </td>
                    <td data-cell="name" data-label="Name">
                      <input
                        className="admin-input"
                        style={{ width: 130 }}
                        value={d.name}
                        onChange={(e) => edit(p.key, { name: e.target.value })}
                      />
                    </td>
                    <td data-cell="units" data-label="Monthly units">
                      <input
                        className="admin-input"
                        type="number"
                        min={0}
                        style={{ width: 120 }}
                        value={d.monthlyUnits}
                        onChange={(e) => edit(p.key, { monthlyUnits: intFrom(e.target.value, 0) })}
                      />
                    </td>
                    <td data-cell="rate" data-label="Rate / min">
                      <input
                        className="admin-input"
                        type="number"
                        min={1}
                        style={{ width: 80 }}
                        value={d.rateLimitPerMin}
                        onChange={(e) => edit(p.key, { rateLimitPerMin: intFrom(e.target.value, 1) })}
                      />
                    </td>
                    <td data-cell="price" data-label="Monthly price (cents)">
                      <div className="admin-row" style={{ gap: 8 }}>
                        <input
                          className="admin-input"
                          type="number"
                          min={0}
                          step={1}
                          style={{ width: 100 }}
                          value={monthlyMinor}
                          onChange={(e) => setMonthlyMinor(p.key, intFrom(e.target.value, 0))}
                        />
                        <span className="admin-note" style={{ margin: 0 }}>
                          {formatMajor(monthlyMinor, monthly?.currency)}
                        </span>
                      </div>
                      {!monthly && (
                        <div className="admin-note" style={{ margin: 0 }}>
                          no monthly price row yet
                        </div>
                      )}
                      {monthly && !isActivePrice(monthly) && (
                        <div className="admin-note" style={{ margin: 0 }}>
                          monthly row is inactive — not on sale
                        </div>
                      )}
                    </td>
                    <td data-cell="keys" data-label="Max keys">
                      <input
                        className="admin-input"
                        type="number"
                        min={0}
                        style={{ width: 70 }}
                        value={d.maxApiKeys}
                        onChange={(e) => edit(p.key, { maxApiKeys: intFrom(e.target.value, 0) })}
                      />
                    </td>
                    <td data-cell="enabled" data-label="Enabled">
                      <input type="checkbox" checked={d.enabled} onChange={(e) => edit(p.key, { enabled: e.target.checked })} />
                    </td>
                    {/* No `data-label`: an actions cell has no value to name. */}
                    <td data-cell="actions">
                      {/* A FIXED width, not a max: it both reserves the column
                          (a `max-width` lets the table squeeze it to one
                          button per line) and caps how wide the row can push
                          the table. Two buttons per line, two lines. */}
                      <div className="admin-row" style={{ gap: 6, width: 182 }}>
                        <button className="admin-btn ghost sm" onClick={() => setExpanded(open ? null : p.key)}>
                          {open ? 'Close' : 'Details'}
                        </button>
                        <button className="admin-btn sm" onClick={() => save(p.key)} disabled={!dirty}>
                          Save
                        </button>
                        <button className="admin-btn ghost sm" onClick={() => reset(p.key)} disabled={!dirty}>
                          Reset
                        </button>
                        <button className="admin-btn danger sm" onClick={() => remove(p.key)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {expanded && draft[expanded] && (
          <PlanDetails
            planKey={expanded}
            plan={draft[expanded]}
            onEdit={(patch) => edit(expanded, patch)}
            onEditPrice={(priceId, patch) => editPrice(expanded, priceId, patch)}
            onAddAnnual={() => addAnnual(expanded)}
            onClose={() => setExpanded(null)}
          />
        )}
      </div>

      <div className="admin-card">
        <h2 className="admin-h">New plan</h2>
        <form className="admin-row" onSubmit={create}>
          <input className="admin-input" placeholder="key" value={creating.key} onChange={(e) => setCreating({ ...creating, key: e.target.value })} />
          <input className="admin-input" placeholder="name" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
          <input
            className="admin-input"
            type="number"
            min={0}
            style={{ width: 130 }}
            placeholder="units"
            value={creating.monthlyUnits}
            onChange={(e) => setCreating({ ...creating, monthlyUnits: intFrom(e.target.value, 0) })}
          />
          <input
            className="admin-input"
            type="number"
            min={1}
            style={{ width: 90 }}
            placeholder="rpm"
            value={creating.rateLimitPerMin}
            onChange={(e) => setCreating({ ...creating, rateLimitPerMin: intFrom(e.target.value, 1) })}
          />
          <input
            className="admin-input"
            type="number"
            min={0}
            step="0.01"
            style={{ width: 90 }}
            placeholder="$ / month"
            value={creating.price}
            onChange={(e) => setCreating({ ...creating, price: Number(e.target.value) || 0 })}
          />
          <input
            className="admin-input"
            type="number"
            min={0}
            style={{ width: 90 }}
            placeholder="max keys"
            value={creating.maxApiKeys}
            onChange={(e) => setCreating({ ...creating, maxApiKeys: intFrom(e.target.value, 0) })}
          />
          <label className="admin-row" style={{ gap: 6 }}>
            <input type="checkbox" checked={creating.selfServe} onChange={(e) => setCreating({ ...creating, selfServe: e.target.checked })} />
            <span className="admin-note" style={{ margin: 0 }}>self-serve</span>
          </label>
          <label className="admin-row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={creating.allowBrowserKeys}
              onChange={(e) => setCreating({ ...creating, allowBrowserKeys: e.target.checked })}
            />
            <span className="admin-note" style={{ margin: 0 }}>browser keys</span>
          </label>
          <button className="admin-btn" type="submit" disabled={!creating.key.trim() || !creating.name.trim()}>
            Create
          </button>
        </form>
        <p className="admin-note">
          A non-zero monthly dollar price derives the monthly + annual pair ({ANNUAL_MONTHS_CHARGED} months charged on the
          annual one). Description and features are edited from the row&apos;s Details panel once the plan exists.
        </p>
      </div>
    </div>
  );
}
