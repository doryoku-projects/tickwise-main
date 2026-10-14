/*
 * I1 — main.ts is wired the way P2.1 / P2.2 need (pinned from the source, like
 * test/usage-buckets.spec.ts and test/hyperindex/indexer-context.spec.ts do).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
const at = (needle: string) => {
  const i = source.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe('main.ts — P2.1 roles', () => {
  it('fixes the role BEFORE Nest builds a provider, from the same env Zod validates, and refuses the boot on a bad one', () => {
    expect(at('configureProcessRole({')).toBeLessThan(at('await NestFactory.create(AppModule'));
    expect(source).toContain('processRole: process.env.PROCESS_ROLE,');
    expect(source).toContain('processLeases: process.env.PROCESS_LEASES,');
    expect(source).toMatch(/catch \(err\) \{\s*processLogger\.error\(`Refusing to boot: /);
    expect(source).toContain('process.exit(1);');
  });

  it('installs the role gate FIRST: before CORS, compression and the access-log / usage / indexer-lane middleware', () => {
    const gate = at('app.use(roleGateMiddleware());');
    expect(gate).toBeGreaterThan(at('const config = app.get(AppConfigService);'));
    expect(gate).toBeLessThan(at('app.enableCors('));
    expect(gate).toBeLessThan(at('app.use(compression('));
    expect(gate).toBeLessThan(at('trackRequestUsage(req, res, usageDeps);'));
    expect(gate).toBeLessThan(at('await app.listen('));
  });

  it('logs the role line once at boot', () => {
    expect(source).toContain('processRoleBootLine(roleSettings)');
    expect(source).toContain('roleGateSummary(roleSettings.role)');
  });
});

describe('main.ts — P2.2 one Envio budget', () => {
  it('binds the shared indexer budget right after configuring the gateways, only for scope=shared, on the coordination client', () => {
    const configure = at('configureIndexerGateways(config.indexerGatewayConfig);');
    const bind = at('setIndexerSharedBudget(new RedisIndexerSharedBudget(new RedisGcra(() => coordination.client())));');
    expect(bind).toBeGreaterThan(configure);
    expect(bind).toBeLessThan(at('await app.listen('));
    expect(source).toContain('if (config.indexerBudgetScope === "shared") {');
    expect(source).toContain('app.get(CoordinationRedis, { strict: false })');
  });
});
