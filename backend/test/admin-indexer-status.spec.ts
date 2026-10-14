/*
 * `GET /admin/sync/status` carries the indexer meter + gateway snapshot, so the
 * per-lane, per-job request rate can be read without grepping a minute of logs.
 * It is ADDITIVE and only present once this process has called the indexer:
 * before then there is nothing to report, and the existing response shape (which
 * `config.spec.ts` pins) is unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { AdminController } from '../src/admin/admin.controller.js';
import type { AppConfigService } from '../src/config/app-config.service.js';
import { __resetIndexerGateways, gatewayForUrl } from '../src/subgraph/hyperindex/indexer-gateway.js';
import { __resetIndexerMeters } from '../src/subgraph/hyperindex/indexer-meter.js';

const SECRET = 'a-strong-ops-secret-for-tests';

function controller() {
  return new AdminController(
    { adminSecret: SECRET } as unknown as AppConfigService,
    { status: async () => ({ waiting: 0 }) } as never,
    { status: async () => ({ cursors: [] }) } as never,
  );
}

afterEach(() => {
  __resetIndexerGateways();
  __resetIndexerMeters();
});

describe('GET /admin/sync/status — indexer budget', () => {
  it('omits the indexer block before any indexer call', async () => {
    const res = (await controller().syncStatus(SECRET)) as Record<string, unknown>;
    expect(res).not.toHaveProperty('indexer');
    expect(res).toMatchObject({ queue: { waiting: 0 }, cursors: [] });
  });

  it('reports each URL, by lane and job, once traffic has flowed', async () => {
    const g = gatewayForUrl('https://indexer.example.test/v1/graphql');
    await g.run({ lane: 'interactive', job: '/v1/positions' }, async () => ({ status: 200 }));
    await g.run({ lane: 'refresh', job: 'refresh' }, async () => ({ status: 429 }));

    const res = (await controller().syncStatus(SECRET)) as unknown as {
      indexer: Array<{ url: string; meter: { current: { lanes: Record<string, number>; jobs: Record<string, number>; outcomes: Record<string, number> } }; gateway: { mode: string } }>;
    };
    expect(res.indexer).toHaveLength(1);
    const [row] = res.indexer;
    expect(row.url).toBe('https://indexer.example.test/v1/graphql');
    expect(row.meter.current.lanes).toMatchObject({ interactive: 1, refresh: 1 });
    expect(row.meter.current.jobs).toEqual({ '/v1/positions': 1, refresh: 1 });
    expect(row.meter.current.outcomes['429']).toBe(1);
    expect(row.gateway.mode).toBe('observe');
  });

  it('is still behind the admin secret', async () => {
    await expect(controller().syncStatus('wrong')).rejects.toMatchObject({ status: 403 });
  });
});
