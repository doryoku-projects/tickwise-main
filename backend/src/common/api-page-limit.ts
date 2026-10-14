import { BadRequestException } from '@nestjs/common';
import { API_MAX_PAGE_LIMIT } from './api-cost.js';

/**
 * The keyless `/api` lists serve at most `API_MAX_PAGE_LIMIT` rows a page: the
 * dashboards ask for 25 and never more, while a script copying the data asks
 * for the largest page it is allowed. `/v1` shares the query DTO and keeps its
 * own `@Max(100)`, so the cap is applied in the `/api` controllers, never in
 * the shared DTO.
 *
 * Reads the RAW query: it runs in a handler, before the global pipe has
 * (in production) turned `limit` into a number, and under `tsx` dev the pipe
 * never runs at all. Anything that is not a number is left to the DTO.
 */
export function assertApiPageLimit(query: { limit?: unknown } | undefined): void {
  const raw = query?.limit;
  if (raw === undefined || raw === null) return;
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.some((value) => (typeof value === 'string' || typeof value === 'number') && Number(value) > API_MAX_PAGE_LIMIT)) {
    throw new BadRequestException({
      error: `limit is capped at ${API_MAX_PAGE_LIMIT} on the keyless /api. The /v1 API serves up to 100 rows a page: use a free key.`,
      max: API_MAX_PAGE_LIMIT,
    });
  }
}
