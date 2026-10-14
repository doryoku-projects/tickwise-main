/*
 * Boot smoke finding (2026-10-04): Mongoose warned "Duplicate schema index" at
 * every boot for Plan.key, EndpointCost.routeKey, AdminUser.email and
 * ApiKey.keyHash — each declared `@Prop({ unique: true })` AND an identical
 * `Schema.index({ field: 1 }, { unique: true })`. One declaration each now;
 * the index itself (keys, unique) is unchanged.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AdminUserSchema } from '../src/auth/admin-user.schema.js';
import { ApiKeySchema } from '../src/billing/api-key.schema.js';
import { EndpointCostSchema } from '../src/billing/endpoint-cost.schema.js';
import { PlanSchema } from '../src/billing/plan.schema.js';

const cases = [
  ['plans', PlanSchema, 'key'],
  ['endpoint_costs', EndpointCostSchema, 'routeKey'],
  ['admin_users', AdminUserSchema, 'email'],
  ['api_keys', ApiKeySchema, 'keyHash'],
] as const;

describe('unique single-field indexes are declared once', () => {
  for (const [name, schema, field] of cases) {
    it(`${name}.${field}: exactly one { ${field}: 1 } index, unique`, () => {
      const matching = schema.indexes().filter(([keys]) => JSON.stringify(keys) === JSON.stringify({ [field]: 1 }));
      expect(matching).toHaveLength(1);
      expect(matching[0]![1]).toMatchObject({ unique: true });
    });
  }
});
