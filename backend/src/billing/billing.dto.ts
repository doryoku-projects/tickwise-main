import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateClientDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  planKey?: string;
}

export class AssignPlanDto {
  @IsString()
  @MinLength(1)
  planKey!: string;
}

export class IssueKeyDto {
  @IsOptional()
  @IsString()
  label?: string;

  /** 'server' (default, backend-only) or 'browser' (frontend, origin-bound). */
  @IsOptional()
  @IsIn(['server', 'browser'])
  keyType?: 'server' | 'browser';

  /** Required (non-empty) when keyType==='browser'; rejected for a server key. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  origins?: string[];
}

export class SetKeyOriginsDto {
  /** Full replacement list of allowed browser origins (empty = unrestricted). */
  @IsArray()
  @IsString({ each: true })
  origins!: string[];
}

/**
 * One entry of `Plan.prices[]`. `id` is the MERGE KEY — `PlansService.update`
 * matches on it, so a PATCH carrying only the monthly price leaves the annual
 * one intact.
 *
 * NOTE for clients: a READ of `prices[]` also carries the Mongoose subdocument
 * `_id`, which is deliberately NOT declared here. The global pipe is
 * `forbidNonWhitelisted`, so echoing a fetched price straight back 400s the
 * whole save on that one property — build the payload field by field (the
 * admin plans page does exactly that).
 */
export class PlanPriceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id!: string;

  @IsIn(['month', 'year'])
  interval!: 'month' | 'year';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  intervalCount?: number;

  /** Money. ALWAYS an integer in MINOR units (cents) — never a float. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitAmountMinor!: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerPriceId?: string;
}

export class CreatePlanDto {
  @IsString()
  @MinLength(1)
  key!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  monthlyUnits!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  rateLimitPerMin!: number;

  /** Float USD/month. Mirrored onto the monthly `prices[]` entry when omitted there. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PlanPriceDto)
  prices?: PlanPriceDto[];

  @IsOptional()
  @IsBoolean()
  selfServe?: boolean;

  /** `0` = unlimited. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxApiKeys?: number;

  @IsOptional()
  @IsBoolean()
  allowBrowserKeys?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(160, { each: true })
  features?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  monthlyUnits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rateLimitPerMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

  /** PARTIAL by design — merged into the stored array by `id`, never replacing it. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PlanPriceDto)
  prices?: PlanPriceDto[];

  @IsOptional()
  @IsBoolean()
  selfServe?: boolean;

  /** `0` = unlimited. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxApiKeys?: number;

  @IsOptional()
  @IsBoolean()
  allowBrowserKeys?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(160, { each: true })
  features?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateEndpointCostDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * Create-or-replace one `endpoint_costs` row.
 *
 * `unitCost` is REQUIRED here and optional on the PATCH, and that asymmetry is
 * the point: `EndpointCost.unitCost` carries a schema default of 1, so an
 * upsert that omitted it would silently price the route at 1 — which on
 * `v1.*.charts` is a 10x undercharge on the only route whose upstream we pay
 * per call for, exactly the bug `seedCostFor` was written to close. A create
 * must state the price.
 */
export class CreateEndpointCostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  routeKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  /** Units charged per request. `0` = free route. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitCost!: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * The window + breakdown for `GET /admin/clients/:id/usage/detail`.
 *
 * Deliberately a SECOND class rather than an import of the portal's
 * `UsageDetailQueryDto`: imports run one way here (portal → billing), and a DTO
 * reaching back the other way would put a file edge between the two realms for
 * the sake of three fields. Both are validated by the ONE implementation in
 * `ClientsService.getUsageDetail`, so the two cannot accept different windows
 * however they drift.
 */
export class ClientUsageDetailQueryDto {
  /** Inclusive lower bound, `YYYY-MM-DD` UTC. Defaults to the 1st of `to`'s month. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date as YYYY-MM-DD' })
  from?: string;

  /** Inclusive upper bound, `YYYY-MM-DD` UTC. Defaults to today. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a date as YYYY-MM-DD' })
  to?: string;

  /** Omitted = all four breakdowns; named = only that one is populated. */
  @IsOptional()
  @IsIn(['day', 'routeKey', 'apiKey', 'status'])
  groupBy?: 'day' | 'routeKey' | 'apiKey' | 'status';
}

export class RunSyncDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;

  @IsOptional()
  @IsString()
  protocol?: string;

  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @IsOptional()
  @IsBoolean()
  fromStart?: boolean;
}
