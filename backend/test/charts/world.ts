/*
 * The charts specs' world: fixtures, the in-memory subgraph, the real Envio
 * adapter reading it, and ONE ChartInputsService shared by the charts service
 * and position detail — the production wiring (ChartsModule exports the
 * instance LeaderboardModule injects).
 */
import { ChartInputsService, TX_WAIT_MS } from '../../src/charts/chart-inputs.service.js';
import { ChartsService } from '../../src/charts/charts.service.js';
import { LeaderboardService } from '../../src/leaderboard/leaderboard.service.js';
import { EnvioAdapter } from '../../src/subgraph/adapters/envio.adapter.js';
import type { PositionAdapter } from '../../src/subgraph/position-adapter.js';
import { CHAIN, PROTO, buildFixture } from './chart-fixtures.js';
import { fakeSubgraph, type FakeSubgraphOptions } from './fake-subgraph.js';

export function makeWorld(
  options: {
    subgraph?: FakeSubgraphOptions;
    adapter?: (envio: EnvioAdapter) => PositionAdapter;
    /** `TX_WAIT_MS` for this world, so a spec need not sleep the real 1.5 s. */
    txWaitMs?: number;
  } = {},
) {
  const fixture = buildFixture();
  const fake = fakeSubgraph(fixture.data, options.subgraph);
  const integration = {
    chainId: CHAIN,
    protocol: PROTO,
    dialect: 'hyperindex',
    enabled: true,
    subgraphUrl: 'http://fake.local/graphql',
  };
  const config = {
    getIntegration: () => integration,
    isSupportedChain: () => true,
    isSupportedProtocol: () => true,
    chartCacheMaxBytes: 64 * 1024 * 1024,
  };
  const positions = {
    findOneForRead: async (_chainId: number, _protocol: string, id: string) =>
      structuredClone(fixture.positions[id] ?? null),
  };
  const envio = new EnvioAdapter({} as never, {} as never, {} as never);
  (envio as unknown as { positionSource: () => unknown }).positionSource = () => fake.client;
  const adapter = options.adapter ? options.adapter(envio) : envio;
  const adapters = { resolve: () => adapter };
  class Inputs extends ChartInputsService {
    protected override readonly txWaitMs = options.txWaitMs ?? TX_WAIT_MS;
    protected override clientFor() {
      return fake.client;
    }
  }
  const inputs = new Inputs(config as never);
  const leaderboard = new LeaderboardService(
    config as never,
    positions as never,
    { findForPosition: async () => [] } as never,
    adapters as never,
    undefined,
    inputs,
  );
  const warn: string[] = [];
  const log: string[] = [];
  (leaderboard as unknown as { logger: { warn: (m: string) => void; log: (m: string) => void } }).logger = {
    warn: (m) => warn.push(m),
    log: (m) => log.push(m),
  };
  const inputsWarn: string[] = [];
  (inputs as unknown as { logger: { warn: (m: string) => void; log: (m: string) => void } }).logger = {
    warn: (m) => inputsWarn.push(m),
    log: () => undefined,
  };
  return {
    fixture,
    fake,
    envio,
    adapter,
    integration,
    inputs,
    charts: new ChartsService(config as never, positions as never, adapters as never, inputs),
    leaderboard,
    /** Lines `LeaderboardService` warned with. */
    warn,
    /** Lines `LeaderboardService` logged at info level. */
    log,
    /** Lines `ChartInputsService` warned with. */
    inputsWarn,
  };
}

/** How many indexer calls selected a given root. */
export function rootCount(calls: Array<{ roots: string[] }>, root: string): number {
  return calls.reduce((n, call) => n + call.roots.filter((r) => r === root).length, 0);
}
