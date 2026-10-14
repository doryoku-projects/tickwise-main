import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InvalidationBus } from '../common/invalidation-bus.js';
import type { CreateEndpointCostDto, UpdateEndpointCostDto } from './billing.dto.js';
import { EndpointCost } from './endpoint-cost.schema.js';
import { ROUTE_KEYS } from './endpoint-costs.seed.js';
import { SettingsCacheService } from './settings-cache.service.js';

/** Every route key THIS BUILD can actually charge — see `assertKnownRouteKey`. */
const KNOWN_ROUTE_KEYS: readonly string[] = Object.freeze(Object.values(ROUTE_KEYS));

@Injectable()
export class EndpointCostsService {
  private readonly logger = new Logger(EndpointCostsService.name);

  constructor(
    @InjectModel(EndpointCost.name) private readonly costs: Model<EndpointCost>,
    @Inject(SettingsCacheService) private readonly cache: SettingsCacheService,
    /** APPENDED and optional (P2.2): tells the other replicas to reload their settings. Absent / off = today. */
    @Optional() @Inject(InvalidationBus) private readonly bus?: InvalidationBus,
  ) {}

  list() {
    return this.costs.find().sort({ routeKey: 1 }).lean().exec();
  }

  /**
   * Create — or re-state — the price of one route.
   *
   * WHY THIS ROUTE EXISTS. `SettingsCacheService.seedIfEmpty` inserts
   * `ENDPOINT_COST_SEEDS` only into an EMPTY collection, so any install whose
   * first boot predates a route key has no row for it and never will. Until
   * now the admin surface was `PATCH /admin/endpoint-costs/:routeKey` alone,
   * which 404s on a missing row — so an operator simply could not reprice such
   * a route from the panel. `seedCostFor` means the route is still charged the
   * PUBLISHED ladder rather than a wrong 1, so nothing was mispriced; what was
   * missing was the ability to change it.
   *
   * UPSERT, not insert-or-409. "Make this route cost N" is idempotent, and an
   * operator re-running it after a partial rollout should not have to know
   * whether the row already exists. `_id` is left alone by `$setOnInsert`
   * defaults so a repeat is a plain field write.
   */
  async create(dto: CreateEndpointCostDto) {
    const routeKey = dto.routeKey.trim();
    this.assertKnownRouteKey(routeKey);

    // Every declared field written explicitly. An upsert-on-insert applies no
    // Mongoose defaults for paths the update does not mention, so a row born
    // here must carry `enabled` rather than inheriting it — the same
    // raw-driver/`.lean()` trap that let plan rows read back without
    // `intervalCount`.
    const updated = await this.costs
      .findOneAndUpdate(
        { routeKey },
        {
          $set: {
            routeKey,
            label: dto.label.trim(),
            unitCost: dto.unitCost,
            enabled: dto.enabled ?? true,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();

    await this.cache.refresh();
    this.bus?.publish({ t: 'settings' });
    this.logger.log(`Endpoint cost set: ${routeKey} = ${dto.unitCost} unit(s)`);
    return updated;
  }

  async update(routeKey: string, dto: UpdateEndpointCostDto) {
    // Built field by field rather than spreading the DTO into the update. The
    // global pipe is `forbidNonWhitelisted` and would reject an unknown
    // property — but it is INERT under `tsx` dev, and a raw DTO reaching a
    // Mongo update is one added field away from writing something nobody
    // reviewed. Same reasoning as `PlansService.update`.
    const set: Record<string, unknown> = {};
    if (dto.unitCost !== undefined) set.unitCost = dto.unitCost;
    if (dto.label !== undefined) set.label = dto.label.trim();
    if (dto.enabled !== undefined) set.enabled = dto.enabled;

    // An empty body is a valid no-op PATCH, but Mongo rejects an empty `$set`.
    if (Object.keys(set).length === 0) {
      const current = await this.costs.findOne({ routeKey }).lean().exec();
      if (!current) throw this.missing(routeKey);
      return current;
    }

    // Deliberately NOT an upsert, unlike `create`. `unitCost` is optional here,
    // so an upserting PATCH could mint a row with no price and let the schema
    // default (1) decide what a route costs. A create must state the price;
    // that is what `POST` is for, and the 404 below says so.
    const updated = await this.costs.findOneAndUpdate({ routeKey }, { $set: set }, { new: true }).lean().exec();
    if (!updated) throw this.missing(routeKey);
    await this.cache.refresh();
    this.bus?.publish({ t: 'settings' });
    return updated;
  }

  private missing(routeKey: string): NotFoundException {
    return new NotFoundException({
      error:
        `No endpoint_costs row for '${routeKey}'. This install first booted before that route key existed, ` +
        'and seeds only fill an empty collection — create it with POST /admin/endpoint-costs.',
    });
  }

  /**
   * Refuse a route key this build does not serve.
   *
   * A row keyed to anything outside `ROUTE_KEYS` is DEAD: `MeteringGuard` looks
   * the cost up by the key on the handler's `@UnitCost` decorator, so a typo'd
   * key is silently never read. Accepting one would let an operator believe
   * they had repriced a route while the meter carried on charging the old
   * amount — the same class of silent no-op this route was added to fix, so
   * accepting it here would be self-defeating.
   */
  private assertKnownRouteKey(routeKey: string): void {
    if (KNOWN_ROUTE_KEYS.includes(routeKey)) return;
    throw new BadRequestException({
      error:
        `Unknown route key '${routeKey}' — nothing would ever read it. Valid keys: ${KNOWN_ROUTE_KEYS.join(', ')}.`,
    });
  }
}
