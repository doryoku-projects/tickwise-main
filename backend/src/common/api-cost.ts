import { SetMetadata } from '@nestjs/common';

/**
 * What a keyless `/api` request is worth, in points, to the per-IP budget
 * (`ApiLimitService`). Each controller handler names the KIND of work it does;
 * the weight comes from here so the numbers live in one place.
 *
 * Every number is a placeholder to be sized from observe-mode data: the budget
 * is set at 5–10× the heaviest real visitor, so what matters is the RATIO
 * between a cached list page and a deep walk or a chart, not the unit.
 */
export type AnonCostKind = 'list' | 'count' | 'detail' | 'chart';

export const ANON_COST_METADATA = 'tw:anon-cost';

/** Mark a controller handler with the kind of work it does. A handler without it is not charged. */
export const AnonCost = (kind: AnonCostKind): MethodDecorator => SetMetadata(ANON_COST_METADATA, kind);

/** The largest page `/api` serves; the dashboards only ever ask for this many. `/v1` stays at 100. */
export const API_MAX_PAGE_LIMIT = 25;
/** A list reaching past this many rows (`page × limit`) is a deep walk, not a cached window. */
export const DEEP_PAGE_ROWS = 1000;

export type CostClass = 'list' | 'deep' | 'search' | 'count' | 'detail' | 'chart';

export interface ApiCost {
  kind: AnonCostKind;
  /** Which row of the weight table applied (for the log line). */
  class: CostClass;
  /** Charged for every request. */
  base: number;
  /**
   * Charged up front as well, and given back when the answer came from a cache
   * (or, for a detail or a chart, needed no indexer call): what a cache miss
   * costs the database and the indexer on top of the request itself.
   */
  surcharge: number;
}

export const API_COST_WEIGHTS: Record<CostClass, { base: number; surcharge: number }> = {
  list: { base: 1, surcharge: 2 },
  deep: { base: 5, surcharge: 2 },
  search: { base: 3, surcharge: 2 },
  count: { base: 2, surcharge: 2 },
  detail: { base: 2, surcharge: 2 },
  chart: { base: 5, surcharge: 3 },
};

/**
 * Guards run before the ValidationPipe, so `query` is the RAW query string
 * object here: every value may be a string, an array, an object or missing.
 */
export function classifyApiCost(kind: AnonCostKind, query: Record<string, unknown> | undefined): ApiCost {
  const q = query ?? {};
  let cls: CostClass;
  if (kind === 'list') {
    if (isPresent(q['search']) || isPresent(q['positionId']) || isPresent(q['owner'])) cls = 'search';
    else if (pageRows(q) > DEEP_PAGE_ROWS) cls = 'deep';
    else cls = 'list';
  } else {
    cls = kind;
  }
  return { kind, class: cls, ...API_COST_WEIGHTS[cls] };
}

/** `page × limit`, read defensively (the DTO's defaults: page 1, limit 20). */
function pageRows(q: Record<string, unknown>): number {
  const page = positiveInt(q['page'], 1);
  const limit = positiveInt(q['limit'], 20);
  return page * limit;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' || typeof value === 'number' ? Math.floor(Number(value)) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function isPresent(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : false;
}
