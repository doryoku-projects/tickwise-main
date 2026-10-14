import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  ClientsService,
  type ApiKeyType,
  type UsageDetail,
  type UsageDetailQuery,
} from '../billing/clients.service.js';
import { currentPeriod } from '../billing/metering.service.js';
import { SettingsCacheService, type CachedPlan } from '../billing/settings-cache.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { CustomerAuthService, toPublicCustomer, type PublicCustomer } from './customer-auth.service.js';
import type { CustomerPrincipal } from './customer-jwt.guard.js';

/** A key as the portal shows it — no `keyHash`, no `customerId`, no `__v`. */
export interface PortalApiKey {
  id: string;
  label: string;
  prefix: string;
  keyType: ApiKeyType;
  allowedOrigins: string[];
  status: string;
  createdAt?: Date;
  lastUsedAt: Date | null;
}

/** `PortalApiKey` plus the raw secret, returned exactly once at issuance. */
export interface IssuedPortalApiKey extends PortalApiKey {
  key: string;
}

/** The plan as the portal renders it. Narrower than `CachedPlan` by design. */
export interface PortalPlan {
  key: string;
  name: string;
  description: string;
  features: string[];
  monthlyUnits: number;
  rateLimitPerMin: number;
  maxApiKeys: number;
  allowBrowserKeys: boolean;
  selfServe: boolean;
}

/** Units burned in one calendar month. `limit` 0 = unlimited. */
export interface PortalUsageSnapshot {
  period: string;
  units: number;
  limit: number;
}

export interface PortalOverview {
  customer: PublicCustomer;
  plan: PortalPlan;
  usage: PortalUsageSnapshot;
  keys: { active: number; max: number };
  /**
   * Whether this deployment actually verifies email addresses.
   *
   * The portal needs it to decide whether an unverified address is ACTIONABLE.
   * Signup deliberately no longer stamps `emailVerifiedAt` (an address nobody
   * proved must read as unproven — see the takeover note in
   * `IdentityService.resolveLogin`), so without this flag every account looks
   * unverified and the portal told people to "check your inbox" for a mail that
   * cannot be sent: there is no mail transport.
   */
  emailVerificationRequired: boolean;
}

export interface PortalUsage {
  current: PortalUsageSnapshot;
  /**
   * `requests` rides alongside `units` because the snapshot already STORES it
   * (`Usage.requestCount`) and the admin panel already shows it — dropping it
   * on the way to the portal left a customer able to see what they had spent
   * but not how many calls it took, for no reason but the mapping.
   */
  history: Array<{ period: string; units: number; requests: number }>;
}

// Self-serve input bounds. `IssueKeyDto`/`SetKeyOriginsDto` declare no array or
// string caps (they were admin-only), and the global ValidationPipe is inert
// under `tsx` dev anyway — so the ceilings live here, on the path that actually
// writes, rather than on a decorator that may not run.
const MAX_ORIGINS_PER_KEY = 20;
const MAX_ORIGIN_LENGTH = 200;
const MAX_LABEL_LENGTH = 120;

/**
 * The ownership facade — the ONLY service `PortalController` injects.
 *
 * Every method takes the caller's `customerId` FIRST, and there is no method
 * that accepts a bare resource id. Internally the key mutations go through
 * `ClientsService.*Owned`, whose Mongo filter carries the owner, never the
 * unscoped admin variants. Reading this file's signatures should be enough to
 * conclude that cross-tenant access is unreachable from the portal.
 */
@Injectable()
export class CustomerSelfService {
  constructor(
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(SettingsCacheService) private readonly settings: SettingsCacheService,
    // Appended, never inserted — specs construct this service positionally.
    @Inject(AppConfigService) private readonly config: AppConfigService,
    // Also appended. The email write lives in `CustomerAuthService` because
    // that is where the customer model, the code minting and the mail budget
    // already are; this facade keeps its "no method takes an unscoped id"
    // property by passing the principal's own id and nothing else.
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService,
  ) {}

  async overview(principal: CustomerPrincipal): Promise<PortalOverview> {
    const plan = this.planFor(principal.planKey);
    const [active, usage] = await Promise.all([
      this.clients.countActiveKeys(principal.id),
      this.currentUsage(principal.id, plan.monthlyUnits),
    ]);
    return {
      customer: this.profile(principal),
      plan,
      usage,
      keys: { active, max: plan.maxApiKeys },
      emailVerificationRequired: this.config.customerEmailVerificationRequired,
    };
  }

  profile(principal: CustomerPrincipal): PublicCustomer {
    return toPublicCustomer(principal);
  }

  /**
   * Set or change the caller's own email address.
   *
   * Takes the whole PRINCIPAL, not an id: this facade's invariant is that no
   * method here accepts an id the caller could have chosen, and the principal
   * is only ever written by `CustomerJwtGuard`. The returned customer always
   * comes back with `emailVerifiedAt: null` — see `CustomerAuthService.setEmail`
   * for why writing an address must never assert ownership of it.
   */
  async updateEmail(
    principal: CustomerPrincipal,
    email: string,
  ): Promise<{ customer: PublicCustomer }> {
    return { customer: await this.auth.setEmail(principal.id, email) };
  }

  async listKeys(customerId: string): Promise<{ keys: PortalApiKey[] }> {
    const keys = await this.clients.listKeys(customerId);
    return { keys: keys.map((key) => toPortalKey(key)) };
  }

  /**
   * Issue a key for the caller, enforcing the two plan ceilings the portal owns:
   * `maxApiKeys` (active keys) and `allowBrowserKeys`.
   *
   * The count-then-create is not atomic, so two simultaneous requests can land
   * one key over the ceiling. Accepted: the ceiling is a product limit, not a
   * security boundary, and the alternative is a transaction on a hot collection.
   */
  async createKey(
    customerId: string,
    planKey: string,
    input: { label?: string; keyType?: ApiKeyType; origins?: string[] },
  ): Promise<IssuedPortalApiKey> {
    const plan = this.planFor(planKey);
    const keyType: ApiKeyType = input.keyType ?? 'server';
    if (keyType === 'browser') assertBrowserKeysAllowed(plan);
    if (plan.maxApiKeys > 0) {
      const active = await this.clients.countActiveKeys(customerId);
      if (active >= plan.maxApiKeys) {
        throw new ForbiddenException({
          error: `Your plan allows ${plan.maxApiKeys} active key${plan.maxApiKeys === 1 ? '' : 's'} — revoke one first, or move to a bigger plan.`,
        });
      }
    }
    // `issueKey` is what enforces the origin RULES (a browser key needs ≥1, a
    // server key must carry none); the caps here only bound the input size.
    const issued = await this.clients.issueKey(customerId, {
      label: assertLabel(input.label),
      keyType,
      origins: assertOrigins(input.origins ?? []),
    });
    return {
      id: issued.id,
      key: issued.apiKey, // shown once — never stored, never re-served
      label: issued.label,
      prefix: issued.keyPrefix,
      keyType: issued.keyType ?? keyType,
      allowedOrigins: issued.allowedOrigins ?? [],
      status: issued.status,
      createdAt: issued.createdAt,
      lastUsedAt: null,
    };
  }

  // The `*Owned` calls below take `(keyId, customerId)`; this facade takes the
  // owner FIRST so a call site physically cannot forget it.

  /**
   * Rebind — or clear — a key's browser origins.
   *
   * `setKeyOriginsOwned` is the SINGLE type knob: a non-empty list rewrites the
   * row to `keyType: 'browser'`. So this path can mint exactly the thing
   * `createKey` refuses, and it has to enforce the identical ceiling — issue a
   * `server` key on a plan without browser keys, then re-origin it, and the
   * plan limit would be worth nothing. Hence `planKey`, from the same place
   * `createKey` gets it (the customer record the guard read), never the body.
   *
   * CLEARING back to a server key stays allowed on every plan: dropping the
   * origins only ever REMOVES the entitlement, so a customer who downgrades is
   * never stuck holding a browser key they can't turn off.
   */
  async setKeyOrigins(
    customerId: string,
    planKey: string,
    keyId: string,
    origins: string[],
  ): Promise<PortalApiKey> {
    const bounded = assertOrigins(origins);
    // Checked BEFORE the write, on the pre-normalization list: anything that
    // could become a browser binding is gated, and a rejected call leaves the
    // stored key untouched.
    if (bounded.length > 0) assertBrowserKeysAllowed(this.planFor(planKey));
    const updated = await this.clients.setKeyOriginsOwned(keyId, customerId, bounded);
    return toPortalKey(updated);
  }

  async revokeKey(customerId: string, keyId: string): Promise<PortalApiKey> {
    return toPortalKey(await this.clients.revokeKeyOwned(keyId, customerId));
  }

  async deleteKey(customerId: string, keyId: string): Promise<{ ok: true }> {
    await this.clients.deleteKeyOwned(keyId, customerId);
    return { ok: true };
  }

  async usage(principal: CustomerPrincipal): Promise<PortalUsage> {
    const plan = this.planFor(principal.planKey);
    const rows = await this.clients.getUsage(principal.id);
    const period = currentPeriod();
    const current = rows.find((row) => row.period === period);
    return {
      current: { period, units: current?.unitsConsumed ?? 0, limit: plan.monthlyUnits },
      history: rows.map((row) => ({
        period: row.period,
        units: row.unitsConsumed ?? 0,
        requests: row.requestCount ?? 0,
      })),
    };
  }

  /**
   * The per-day / per-route / per-key / per-status breakdown behind
   * `GET /account/usage/detail`.
   *
   * Takes the PRINCIPAL, like `usage` above and for the same reason: this
   * facade has no method that accepts an id the caller could have chosen, so
   * the tenant is `req.customerUser` and can be nothing else. The window and
   * row caps live in `ClientsService.getUsageDetail`, which is the one place
   * both realms go through — the admin panel must not be able to ask for a
   * wider window than a customer can.
   */
  async usageDetail(principal: CustomerPrincipal, query: UsageDetailQuery): Promise<UsageDetail> {
    return this.clients.getUsageDetail(principal.id, query);
  }

  /** Current-period consumption from the Mongo snapshot (Redis is the enforcer). */
  private async currentUsage(customerId: string, limit: number): Promise<PortalUsageSnapshot> {
    const period = currentPeriod();
    const rows = await this.clients.getUsage(customerId);
    const current = rows.find((row) => row.period === period);
    return { period, units: current?.unitsConsumed ?? 0, limit };
  }

  /**
   * The caller's plan, normalized. A plan that no longer exists FAILS CLOSED —
   * one server key, no browser keys — rather than throwing: a deleted plan must
   * not make the portal unreachable for the customers still pointed at it.
   */
  private planFor(planKey: string): PortalPlan {
    const plan: CachedPlan | undefined = this.settings.getPlan(planKey);
    return {
      key: planKey,
      name: plan?.name ?? planKey,
      description: plan?.description ?? '',
      features: plan ? [...plan.features] : [],
      monthlyUnits: plan?.monthlyUnits ?? 0,
      rateLimitPerMin: plan?.rateLimitPerMin ?? 0,
      maxApiKeys: plan?.maxApiKeys ?? 1,
      allowBrowserKeys: plan?.allowBrowserKeys ?? false,
      selfServe: plan?.selfServe ?? false,
    };
  }
}

/** The stored shape both `listKeys` and the `*Owned` writers hand back. */
interface StoredKey {
  _id: unknown;
  keyPrefix?: string;
  label?: string;
  status?: string;
  keyType?: ApiKeyType;
  allowedOrigins?: string[];
  lastUsedAt?: Date | null;
  createdAt?: Date;
}

/**
 * The single key projection for every portal response. `ClientsService` returns
 * lean documents that still carry `customerId`/`__v`; building the wire shape
 * here means a column added to `ApiKey` cannot leak by default.
 */
function toPortalKey(source: unknown): PortalApiKey {
  const key = source as StoredKey;
  const allowedOrigins = key.allowedOrigins ?? [];
  return {
    id: String(key._id),
    label: key.label ?? '',
    prefix: key.keyPrefix ?? '',
    // Legacy rows carry no keyType — same inference as `resolveByRawKey`.
    keyType: key.keyType ?? (allowedOrigins.length > 0 ? 'browser' : 'server'),
    allowedOrigins,
    status: key.status ?? 'active',
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt ?? null,
  };
}

/**
 * THE browser-key ceiling, in one place so the two paths that can produce a
 * browser key — issuing one, and re-origining an existing key into one — cannot
 * drift apart. A plan that no longer exists fails closed via `planFor`.
 */
function assertBrowserKeysAllowed(plan: PortalPlan): void {
  if (plan.allowBrowserKeys) return;
  throw new ForbiddenException({
    error: 'Your plan does not include browser keys — move to a plan that does to issue one.',
  });
}

function assertLabel(label: string | undefined): string {
  const trimmed = (label ?? '').trim();
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new BadRequestException({ error: `A key label must be under ${MAX_LABEL_LENGTH} characters.` });
  }
  return trimmed;
}

function assertOrigins(origins: string[]): string[] {
  if (origins.length > MAX_ORIGINS_PER_KEY) {
    throw new BadRequestException({ error: `At most ${MAX_ORIGINS_PER_KEY} site URLs per key.` });
  }
  for (const origin of origins) {
    if (typeof origin !== 'string' || origin.length > MAX_ORIGIN_LENGTH) {
      throw new BadRequestException({
        error: `Each site URL must be text under ${MAX_ORIGIN_LENGTH} characters.`,
      });
    }
  }
  return origins;
}
