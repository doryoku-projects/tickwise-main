import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIntegrations, type IntegrationConfig } from '../../src/config/integrations.config.js';
import { FIXED_NOW, NORMALIZE_CASES, normalizeCase } from './normalize-fixtures.js';

const ENVIO_URL = 'https://indexer.hyperindex.xyz/test/v1/graphql';
const PONDER_URL = 'https://ponder-mainnet.example/subgraph';

function integration(order: string): IntegrationConfig {
  const row = buildIntegrations({
    UNISWAP_V4_INDEXER_URL: ENVIO_URL,
    UNISWAP_V4_INDEXER_DIALECT: 'hyperindex',
    ETHEREUM_UNISWAP_V4_PONDER_URL: PONDER_URL,
    UNISWAP_V4_INDEXER_SOURCES: order,
  }).find((candidate) => candidate.chainId === 1);
  if (!row) throw new Error('Ethereum Uniswap V4 integration was not built');
  return row;
}

const ENVIO_ONLY = integration('envio');
const SOURCE_MODES = [
  integration('ponder'),
  integration('envio,ponder'),
  integration('ponder,envio'),
];

const MATH_CONFIGS = [
  {},
  { positionAmountsSource: 'tickmath' },
  { priceQuoteGuard: 'on' },
  { honeypotFeeAnchorExempt: 'on' },
  { positionAmountsSource: 'tickmath', honeypotFeeAnchorExempt: 'on' },
  { positionAmountsSource: 'tickmath', priceQuoteGuard: 'on', honeypotFeeAnchorExempt: 'on' },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => vi.useRealTimers());

describe('Ponder and Envio position math parity', () => {
  it('normalizes identical indexer rows with identical math for either source and either priority', async () => {
    for (const fixture of NORMALIZE_CASES) {
      for (const config of MATH_CONFIGS) {
        const envio = await normalizeCase(fixture, config, ENVIO_ONLY);
        for (const sourceMode of SOURCE_MODES) {
          expect(await normalizeCase(fixture, config, sourceMode), `${fixture.name}; ${JSON.stringify(sourceMode.sources)}`)
            .toEqual(envio);
        }
      }
    }
  });
});
