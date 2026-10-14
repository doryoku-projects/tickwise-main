import 'reflect-metadata';
import { OPTIONAL_DEPS_METADATA, PARAMTYPES_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { BillingModule } from '../../src/billing/billing.module.js';
import { MeteringService } from '../../src/billing/metering.service.js';
import { UsageBucketService } from '../../src/billing/usage-bucket.service.js';
import { USAGE_FLUSH_OPTIONS, UsageFlushService } from '../../src/billing/usage-flush.service.js';
import { CoordinationRedis } from '../../src/common/coordination-redis.js';

/**
 * The batched writer only works if it is the SAME instance in both producers
 * (MeteringService, UsageBucketService) and is actually bound — an optional
 * token nobody provides is a feature that silently never runs.
 */

function dep(cls: object, index: number): { token: unknown; optional: boolean } {
  const self = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) as Array<{ index: number; param: unknown }> | undefined) ?? [];
  const types = (Reflect.getMetadata(PARAMTYPES_METADATA, cls) as unknown[] | undefined) ?? [];
  const optional = (Reflect.getMetadata(OPTIONAL_DEPS_METADATA, cls) as number[] | undefined) ?? [];
  return { token: self.find((d) => d.index === index)?.param ?? types[index], optional: optional.includes(index) };
}

describe('usage batching wiring', () => {
  it('BillingModule provides and exports UsageFlushService', () => {
    expect(Reflect.getMetadata('providers', BillingModule)).toContain(UsageFlushService);
    expect(Reflect.getMetadata('exports', BillingModule)).toContain(UsageFlushService);
  });

  it('both producers take it as an APPENDED optional param (positional specs unaffected)', () => {
    expect(dep(MeteringService, 3)).toEqual({ token: UsageFlushService, optional: true });
    expect(dep(UsageBucketService, 1)).toEqual({ token: UsageFlushService, optional: true });
  });

  it('the flusher reads redis-state through the global CoordinationRedis; its options token is a spec seam', () => {
    expect(dep(UsageFlushService, 3)).toEqual({ token: CoordinationRedis, optional: true });
    expect(dep(UsageFlushService, 4)).toEqual({ token: USAGE_FLUSH_OPTIONS, optional: true });
  });
});
