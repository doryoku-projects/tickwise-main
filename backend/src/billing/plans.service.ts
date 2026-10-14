import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InvalidationBus } from '../common/invalidation-bus.js';
import { Customer } from './customer.schema.js';
import { MeteringService } from './metering.service.js';
import {
  activeMonthlyAmountMinor,
  countActiveMonthlyPrices,
  derivePlanPrices,
  isActivePrice,
  isMonthlyPrice,
  majorFromMinor,
  mergePlanPrices,
  Plan,
  PLAN_PRICE_INTERVALS,
  syncMonthlyAmount,
} from './plan.schema.js';
import type { PlanPrice, PlanPriceInput } from './plan.schema.js';
import type { CreatePlanDto, UpdatePlanDto } from './billing.dto.js';
import { SettingsCacheService } from './settings-cache.service.js';

@Injectable()
export class PlansService {
  constructor(
    @InjectModel(Plan.name) private readonly plans: Model<Plan>,
    @Inject(SettingsCacheService) private readonly cache: SettingsCacheService,
    @Inject(MeteringService) private readonly metering: MeteringService,
    // Last ctor param on purpose: existing positional construction in tests must
    // keep working. Only used for the referential check in `remove`.
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    /** APPENDED and optional (P2.2): tells the other replicas a plan changed. Absent / off = today. */
    @Optional() @Inject(InvalidationBus) private readonly bus?: InvalidationBus,
  ) {}

  list() {
    return this.plans.find().sort({ price: 1 }).lean().exec();
  }

  /**
   * The AUTHORITATIVE plan document, straight from Mongo.
   *
   * The subscribe path must not read `SettingsCacheService`: that cache is up
   * to 30 seconds stale, and a checkout locks `unitAmountMinor` onto a
   * subscription for the life of that subscription. Selling last-minute's price
   * is a real charge at a number the customer was not shown, and it persists.
   * Every other reader — metering, the public pricing page — should keep using
   * the cache.
   */
  getByKey(key: string) {
    return this.plans.findOne({ key }).lean().exec();
  }

  async create(dto: CreatePlanDto) {
    const existing = await this.plans.findOne({ key: dto.key }).lean().exec();
    if (existing) throw new BadRequestException({ error: `Plan '${dto.key}' already exists` });

    const price = dto.price ?? 0;
    let prices: PlanPrice[];
    if (dto.prices !== undefined) {
      this.assertPricesInput(dto.prices);
      prices = mergePlanPrices([], dto.prices);
      // On create the merge base is empty, so this can only catch a payload that
      // carries two active monthly rows itself — worth having anyway: a plan born
      // forked never gets a chance to be repriced correctly.
      this.assertOneActiveMonthlyPrice(prices);
    } else {
      // Created from the float-only admin form: derive the monthly + annual
      // pair so the plan is immediately sellable. A $0 plan gets no price row.
      prices = derivePlanPrices(dto.key, price);
    }

    const created = await this.plans.create({
      key: dto.key,
      name: dto.name,
      monthlyUnits: dto.monthlyUnits,
      rateLimitPerMin: dto.rateLimitPerMin,
      // Recompute whichever side the caller did not send (see `Plan.price`).
      price: dto.price !== undefined ? price : this.denormalizedPrice(prices, price),
      enabled: dto.enabled ?? true,
      // Every field below must be listed explicitly — this is a whitelist, not
      // a spread, so an omitted one is silently dropped on create.
      prices,
      selfServe: dto.selfServe ?? false,
      maxApiKeys: dto.maxApiKeys ?? 1,
      allowBrowserKeys: dto.allowBrowserKeys ?? false,
      description: dto.description ?? '',
      features: dto.features ?? [],
    });
    await this.cache.refresh();
    this.bus?.publish({ t: 'plan', planKey: dto.key });
    return created.toObject();
  }

  /**
   * Partial plan update. Deliberately NOT the old wholesale spread of the DTO
   * into `findOneAndUpdate`: Mongoose treats a plain update object as a
   * top-level `$set`, so a PATCH carrying only the monthly price REPLACED
   * `prices[]` and wiped the annual one. Prices are merged by `id` instead,
   * which makes this a read-modify-write — hence the `__v` guard below.
   */
  async update(key: string, dto: UpdatePlanDto) {
    const current = await this.plans.findOne({ key }).lean().exec();
    if (!current) throw new NotFoundException({ error: `Plan '${key}' not found` });

    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.monthlyUnits !== undefined) set.monthlyUnits = dto.monthlyUnits;
    if (dto.rateLimitPerMin !== undefined) set.rateLimitPerMin = dto.rateLimitPerMin;
    if (dto.enabled !== undefined) set.enabled = dto.enabled;
    if (dto.selfServe !== undefined) set.selfServe = dto.selfServe;
    if (dto.maxApiKeys !== undefined) set.maxApiKeys = dto.maxApiKeys;
    if (dto.allowBrowserKeys !== undefined) set.allowBrowserKeys = dto.allowBrowserKeys;
    if (dto.description !== undefined) set.description = dto.description;
    if (dto.features !== undefined) set.features = dto.features;

    let prices: PlanPrice[] = (current.prices ?? []).map((p) => ({ ...p }));
    let pricesTouched = false;
    if (dto.prices !== undefined) {
      this.assertPricesInput(dto.prices);
      prices = mergePlanPrices(prices, dto.prices);
      pricesTouched = true;
    }

    // Keep the float `price` and `prices[]` in lockstep — recompute whichever
    // side the caller did NOT write. Both written = both taken as given.
    if (dto.price !== undefined) {
      set.price = dto.price;
      if (dto.prices === undefined) {
        prices = syncMonthlyAmount(key, prices, dto.price);
        pricesTouched = true;
      }
    } else if (dto.prices !== undefined) {
      const monthly = activeMonthlyAmountMinor(prices);
      if (monthly !== undefined) set.price = majorFromMinor(monthly);
    }
    // AFTER the merge and after `syncMonthlyAmount`, so what is checked is
    // exactly what is about to be stored. `syncMonthlyAmount` already deactivates
    // rival monthly rows, so the branch that runs it cannot trip this — the
    // `prices[]` branch, which never reaches it, is the one that could.
    if (pricesTouched) this.assertOneActiveMonthlyPrice(prices);
    if (pricesTouched) set.prices = prices;

    // An empty body is a valid no-op PATCH — but Mongo rejects an empty `$set`,
    // so short-circuit rather than issuing the write.
    if (Object.keys(set).length === 0) return current;

    // Optimistic guard. The merge above reads then writes, so without this a
    // concurrent PATCH touching a DIFFERENT price id would be silently lost.
    const version = (current as unknown as { __v?: number }).__v;
    const filter = version === undefined ? { key } : { key, __v: version };
    const updated = await this.plans
      .findOneAndUpdate(filter, { $set: set, $inc: { __v: 1 } }, { new: true })
      .lean()
      .exec();
    if (!updated) {
      throw new ConflictException({
        error: `Plan '${key}' changed while you were editing it — reload and retry`,
      });
    }
    await this.cache.refresh();
    this.metering.evictPlanLimiter(key); // rebuild limiter with new limits next request
    this.bus?.publish({ t: 'plan', planKey: key }); // …and on every other replica
    return updated;
  }

  async remove(key: string) {
    // `Customer.planKey` is a bare String with no `ref`, so Mongo enforces
    // nothing: deleting a referenced plan makes `SettingsCacheService.getPlan`
    // miss and `MeteringGuard` 403 EVERY request from every key on that plan —
    // an instant, total outage for those customers. Refuse instead.
    const referencing = await this.customers.countDocuments({ planKey: key }).exec();
    if (referencing > 0) {
      throw new ConflictException({
        error: `Plan '${key}' is assigned to ${referencing} client(s) — move them to another plan before deleting it`,
      });
    }
    const deleted = await this.plans.findOneAndDelete({ key }).lean().exec();
    if (!deleted) throw new NotFoundException({ error: `Plan '${key}' not found` });
    await this.cache.refresh();
    this.metering.evictPlanLimiter(key);
    this.bus?.publish({ t: 'plan', planKey: key });
    return { deleted: key };
  }

  /**
   * Refuse a `prices[]` array that would leave the plan with two ACTIVE monthly
   * prices.
   *
   * CHECKED ON THE MERGED ARRAY, never on the incoming payload, and that is the
   * whole point: `update` merges by `id`, so a PATCH carrying ONE monthly price
   * whose id differs from the stored one — `standard-monthly` against a stored
   * `standard_monthly`, the hyphen-vs-underscore hazard the migration warns about
   * — is not an edit at all. It APPENDS. The payload looks impeccable in
   * isolation; only the merged result shows the fork.
   *
   * Why it matters more than a tidy invariant: `activeMonthlyAmountMinor` reads
   * the monthly amount with `.find()`, so from that moment the public pricing
   * page publishes whichever of the two sits earlier in the array while the float
   * `price` mirrors the other. `assertPricesInput` had no cardinality check of any
   * kind, and the `prices[]` branch of `update` never reaches `syncMonthlyAmount`
   * (which deactivates rival monthly rows on the way past), so nothing in that
   * path could notice.
   *
   * Runs in create AND update, on the merged array in both.
   */
  private assertOneActiveMonthlyPrice(prices: PlanPrice[]): void {
    const active = countActiveMonthlyPrices(prices);
    if (active <= 1) return;
    const ids = prices
      .filter((price) => isActivePrice(price) && isMonthlyPrice(price))
      .map((price) => price.id);
    throw new BadRequestException({
      error:
        `That leaves ${active} ACTIVE monthly prices (${ids.join(', ')}) — a plan may have only one. ` +
        'Deactivate the others, or reuse the existing price id if you meant to change its amount.',
    });
  }

  /**
   * Validate an incoming `prices[]` payload. The global ValidationPipe covers
   * this in the prod build, but it is inert under `tsx` dev (esbuild drops the
   * decorator metadata), and a validator must never be the only thing between
   * raw input and a money write.
   */
  private assertPricesInput(prices: PlanPriceInput[]): void {
    const seen = new Set<string>();
    for (const price of prices) {
      const id = typeof price?.id === 'string' ? price.id.trim() : '';
      if (!id) throw new BadRequestException({ error: 'Each price needs a non-empty id' });
      if (seen.has(id)) throw new BadRequestException({ error: `Duplicate price id '${id}'` });
      seen.add(id);
      if (!PLAN_PRICE_INTERVALS.includes(price.interval)) {
        throw new BadRequestException({
          error: `Price '${id}' has an invalid interval — expected one of ${PLAN_PRICE_INTERVALS.join(', ')}`,
        });
      }
      if (!Number.isInteger(price.unitAmountMinor) || price.unitAmountMinor < 0) {
        throw new BadRequestException({
          error: `Price '${id}' unitAmountMinor must be a non-negative integer in minor units (cents)`,
        });
      }
      if (price.intervalCount !== undefined && (!Number.isInteger(price.intervalCount) || price.intervalCount < 1)) {
        throw new BadRequestException({ error: `Price '${id}' intervalCount must be an integer >= 1` });
      }
    }
  }

  /** The float `price` implied by `prices[]`, falling back to what was given. */
  private denormalizedPrice(prices: PlanPrice[], fallback: number): number {
    const monthly = activeMonthlyAmountMinor(prices);
    return monthly === undefined ? fallback : majorFromMinor(monthly);
  }
}
