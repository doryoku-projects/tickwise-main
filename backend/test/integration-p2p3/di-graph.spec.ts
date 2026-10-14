/*
 * P2/P3 integration (I1): the WHOLE DI graph reachable from AppModule resolves.
 *
 * Six packages appended `@Optional()` constructor params and string tokens
 * (SYNC_FLOW_LOCKS, PAGE_FEE_READER, POSITION_WRITE_OBSERVER, FEE_COORDINATION,
 * FEE_RPC_FETCH, GECKOTERMINAL_GCRA, WRITE_BUDGET_REDIS …). An optional token
 * nobody binds is not an error to Nest — it injects `undefined` and the feature
 * silently runs today's path forever. Booting AppModule needs MongoDB, so this
 * spec resolves the graph from the decorator metadata instead: every module
 * reachable from AppModule, every provider / controller, every constructor
 * dependency — each REQUIRED token must be visible from the declaring module
 * (own providers, imported modules' exports, global modules' exports), and each
 * token in `MUST_BE_BOUND` must be visible to every consumer even though it is
 * injected as optional.
 */
import 'reflect-metadata';
import {
  GLOBAL_MODULE_METADATA,
  MODULE_METADATA,
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants.js';
import { ModuleRef, Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { CoordinationRedis } from '../../src/common/coordination-redis.js';
import { FeeWorkerLeaseHolder } from '../../src/common/fee-coordination.js';
import { FlowLocks } from '../../src/common/flow-lock.js';
import { InvalidationBus } from '../../src/common/invalidation-bus.js';
import { LimiterFactory } from '../../src/common/limiter-factory.js';
import { ProcessStatusService } from '../../src/common/process-status.js';
import { RpcBudget } from '../../src/common/rpc-budget.js';
import { WRITE_BUDGET_REDIS, WriteBudgetService } from '../../src/common/write-budget.js';
import { WriteBudgetController } from '../../src/common/write-budget-controller.js';
import { MongoMonitor } from '../../src/database/mongo-monitor.js';
import { POSITION_WRITE_OBSERVER } from '../../src/database/positions.repository.js';
import { GECKOTERMINAL_GCRA } from '../../src/pricing/providers/geckoterminal.provider.js';
import { PAGE_FEE_READER } from '../../src/subgraph/adapters/envio.adapter.js';
import { FEE_COORDINATION } from '../../src/sync/fee-signals.js';
import { FEE_RPC_FETCH, FeeMeasurer } from '../../src/sync/fee-measurer.js';
import { FeeRowHintPublisher } from '../../src/sync/fee-row-hint-publisher.js';
import { SYNC_FLOW_LOCKS } from '../../src/sync/sync.service.js';
import { UsageFlushService } from '../../src/billing/usage-flush.service.js';

type Token = unknown;

interface ModuleNode {
  key: unknown;
  cls: Function;
  name: string;
  providers: unknown[];
  controllers: Function[];
  imports: unknown[];
  exports: unknown[];
  global: boolean;
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'forwardRef' in (value as object)) {
    return (value as { forwardRef: () => unknown }).forwardRef();
  }
  return value;
}

function isModuleLike(value: unknown): boolean {
  const v = unwrap(value);
  if (typeof v === 'function') return Reflect.getMetadataKeys(v).some((k) => k === MODULE_METADATA.IMPORTS || k === MODULE_METADATA.PROVIDERS || k === MODULE_METADATA.EXPORTS || k === GLOBAL_MODULE_METADATA);
  return Boolean(v && typeof v === 'object' && 'module' in (v as object));
}

function node(value: unknown): ModuleNode {
  const v = unwrap(value);
  const dynamic = v && typeof v === 'object' && 'module' in (v as object) ? (v as Record<string, unknown>) : undefined;
  const cls = (dynamic ? dynamic.module : v) as Function;
  const meta = (key: string): unknown[] => (Reflect.getMetadata(key, cls) as unknown[] | undefined) ?? [];
  return {
    key: v,
    cls,
    name: cls?.name ?? String(v),
    providers: [...meta(MODULE_METADATA.PROVIDERS), ...((dynamic?.providers as unknown[]) ?? [])],
    controllers: [...meta(MODULE_METADATA.CONTROLLERS), ...((dynamic?.controllers as unknown[]) ?? [])] as Function[],
    imports: [...meta(MODULE_METADATA.IMPORTS), ...((dynamic?.imports as unknown[]) ?? [])],
    exports: [...meta(MODULE_METADATA.EXPORTS), ...((dynamic?.exports as unknown[]) ?? [])],
    global: Boolean(dynamic?.global ?? Reflect.getMetadata(GLOBAL_MODULE_METADATA, cls)),
  };
}

function providerToken(provider: unknown): Token {
  if (typeof provider === 'function') return provider;
  return (provider as { provide?: unknown })?.provide;
}

/** Every module reachable from `root` (dynamic modules are distinct nodes). */
function collect(root: unknown): ModuleNode[] {
  const seen = new Map<unknown, ModuleNode>();
  const visit = (value: unknown) => {
    const v = unwrap(value);
    if (!v || seen.has(v)) return;
    const n = node(v);
    seen.set(v, n);
    for (const imp of n.imports) visit(imp);
  };
  visit(root);
  return [...seen.values()];
}

const nodes = collect(AppModule);
const byKey = new Map(nodes.map((n) => [n.key, n]));

/** The tokens a module makes visible to its importers (re-exported modules expanded). */
function exported(n: ModuleNode, stack = new Set<ModuleNode>()): Set<Token> {
  const out = new Set<Token>();
  if (stack.has(n)) return out;
  stack.add(n);
  for (const e of n.exports) {
    const v = unwrap(e);
    // A re-exported module: an import of `n` whose key or class is `v`.
    const reexports = n.imports.map((i) => byKey.get(unwrap(i))).filter((m): m is ModuleNode => !!m && (m.key === v || m.cls === v));
    if (reexports.length > 0 && isModuleLike(v)) {
      for (const m of reexports) for (const t of exported(m, stack)) out.add(t);
      continue;
    }
    // A provider object can be exported directly (`exports: [connectionProvider]`).
    out.add(v && typeof v === 'object' && 'provide' in (v as object) ? (v as { provide: unknown }).provide : v);
  }
  return out;
}

const globalTokens = new Set<Token>();
for (const n of nodes) if (n.global) for (const t of exported(n)) globalTokens.add(t);

function visibleFrom(n: ModuleNode): Set<Token> {
  const out = new Set<Token>([...globalTokens, ...n.providers.map(providerToken), ModuleRef, Reflector]);
  for (const imp of n.imports) {
    const m = byKey.get(unwrap(imp));
    if (m) for (const t of exported(m)) out.add(t);
  }
  return out;
}

const IGNORED_PARAM_TYPES = new Set<unknown>([Object, Function, String, Number, Boolean, Array, Promise, undefined]);

interface Dep {
  index: number;
  token: Token;
  optional: boolean;
}

function classDeps(cls: Function): Dep[] {
  const paramtypes = (Reflect.getMetadata(PARAMTYPES_METADATA, cls) as unknown[] | undefined) ?? [];
  const self = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls) as Array<{ index: number; param: unknown }> | undefined) ?? [];
  const optional = new Set((Reflect.getMetadata(OPTIONAL_DEPS_METADATA, cls) as number[] | undefined) ?? []);
  const length = Math.max(paramtypes.length, ...self.map((d) => d.index + 1), 0);
  const out: Dep[] = [];
  for (let i = 0; i < length; i++) {
    const declared = self.find((d) => d.index === i);
    const token = unwrap(declared ? declared.param : paramtypes[i]);
    out.push({ index: i, token, optional: optional.has(i) });
  }
  return out;
}

function providerDeps(provider: unknown): Dep[] {
  if (typeof provider === 'function') return classDeps(provider);
  const p = provider as { useClass?: Function; useFactory?: unknown; inject?: unknown[]; useExisting?: unknown };
  if (p.useClass) return classDeps(p.useClass);
  if (p.useExisting !== undefined) return [{ index: 0, token: unwrap(p.useExisting), optional: false }];
  if (p.useFactory) {
    return (p.inject ?? []).map((entry, index) => {
      const e = entry as { token?: unknown; optional?: boolean };
      return e && typeof e === 'object' && 'token' in e
        ? { index, token: unwrap(e.token), optional: Boolean(e.optional) }
        : { index, token: unwrap(entry), optional: false };
    });
  }
  return [];
}

function tokenName(token: Token): string {
  return typeof token === 'function' ? token.name : String(token);
}

/** Optional tokens P2/P3 code injects that the integration MUST bind (unbound = the feature silently never runs). */
const MUST_BE_BOUND: Token[] = [
  SYNC_FLOW_LOCKS,
  PAGE_FEE_READER,
  POSITION_WRITE_OBSERVER,
  FEE_COORDINATION,
  FEE_RPC_FETCH,
  GECKOTERMINAL_GCRA,
  WRITE_BUDGET_REDIS,
  CoordinationRedis,
  FlowLocks,
  LimiterFactory,
  InvalidationBus,
  RpcBudget,
  ProcessStatusService,
  WriteBudgetService,
  WriteBudgetController,
  MongoMonitor,
  FeeRowHintPublisher,
  FeeMeasurer,
  FeeWorkerLeaseHolder,
  // Usage write batching: MeteringService / UsageBucketService (BillingModule)
  // and the admin status (AdminModule imports BillingModule for it).
  UsageFlushService,
];

describe('P2/P3 DI graph from AppModule (I1 wiring)', () => {
  it('reaches the global CoordinationModule and the modules every P2/P3 consumer lives in', () => {
    const names = nodes.map((n) => n.name);
    for (const name of ['CoordinationModule', 'DatabaseModule', 'SubgraphModule', 'PricingModule', 'SyncModule', 'QueuesModule', 'AdminModule']) {
      expect(names).toContain(name);
    }
    expect(nodes.find((n) => n.name === 'CoordinationModule')?.global).toBe(true);
  });

  it('every REQUIRED constructor dependency of every provider and controller is visible from its module', () => {
    const missing: string[] = [];
    for (const n of nodes) {
      const visible = visibleFrom(n);
      const owners: Array<[string, Dep[]]> = [
        ...n.providers.map((p) => [tokenName(providerToken(p)), providerDeps(p)] as [string, Dep[]]),
        ...n.controllers.map((c) => [c.name, classDeps(c)] as [string, Dep[]]),
      ];
      for (const [owner, deps] of owners) {
        for (const dep of deps) {
          if (dep.optional || IGNORED_PARAM_TYPES.has(dep.token)) continue;
          if (!visible.has(dep.token)) missing.push(`${n.name}: ${owner}[${dep.index}] → ${tokenName(dep.token)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every P2/P3 optional token is BOUND where it is consumed (never a silent `undefined`)', () => {
    const unbound: string[] = [];
    const consumed = new Set<Token>();
    for (const n of nodes) {
      const visible = visibleFrom(n);
      const owners: Array<[string, Dep[]]> = [
        ...n.providers.map((p) => [tokenName(providerToken(p)), providerDeps(p)] as [string, Dep[]]),
        ...n.controllers.map((c) => [c.name, classDeps(c)] as [string, Dep[]]),
      ];
      for (const [owner, deps] of owners) {
        for (const dep of deps) {
          if (!MUST_BE_BOUND.includes(dep.token)) continue;
          consumed.add(dep.token);
          if (!visible.has(dep.token)) unbound.push(`${n.name}: ${owner}[${dep.index}] → ${tokenName(dep.token)}`);
        }
      }
    }
    expect(unbound).toEqual([]);
    // And each one really has a consumer (a token in this list nobody injects is a stale entry).
    const neverConsumed = MUST_BE_BOUND.filter((t) => !consumed.has(t) && !globalTokens.has(t)).map(tokenName);
    expect(neverConsumed).toEqual([]);
  });

  it('pins the specific bindings the package reports asked for', () => {
    const coordination = nodes.find((n) => n.name === 'CoordinationModule')!;
    const provided = (n: ModuleNode, token: Token) => n.providers.find((p) => providerToken(p) === token) as Record<string, unknown> | undefined;
    expect(provided(coordination, SYNC_FLOW_LOCKS)?.useExisting).toBe(FlowLocks);
    expect(provided(coordination, WRITE_BUDGET_REDIS)?.useExisting).toBe(CoordinationRedis);
    expect(provided(coordination, FEE_COORDINATION)?.useFactory).toBeTypeOf('function');
    expect(provided(coordination, FEE_RPC_FETCH)?.useFactory).toBeTypeOf('function');
    const database = nodes.find((n) => n.name === 'DatabaseModule')!;
    expect(provided(database, POSITION_WRITE_OBSERVER)?.useExisting).toBe(FeeRowHintPublisher);
    const subgraph = nodes.find((n) => n.name === 'SubgraphModule')!;
    expect(provided(subgraph, PAGE_FEE_READER)?.useExisting).toBe(FeeMeasurer);
    const pricing = nodes.find((n) => n.name === 'PricingModule')!;
    expect(provided(pricing, GECKOTERMINAL_GCRA)?.useFactory).toBeTypeOf('function');
  });
});
