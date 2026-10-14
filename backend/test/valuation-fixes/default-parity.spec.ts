import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asJson, FIXED_NOW, NORMALIZE_CASES, normalizeCase } from './normalize-fixtures.js';
import { makeRankConfig, positionsRepo, SORTS } from '../read-models/rank-support.js';

/**
 * Today's default must be BYTE-IDENTICAL: the golden files were written by the
 * code as it stood BEFORE the valuation flags existed, and every run compares
 * the default (no flag set) and the explicit "off" values against them.
 *
 *  - `normalize-default.json`: one EnvioAdapter `normalize` per fixture case.
 *  - `leaderboard-filters-default.json`: `leaderboardPlan(...).filter` and its
 *    `shapeFilter` for a fixed query matrix (every shape, tab, toggle).
 */

const OFF_FLAGS = {
  positionAmountsSource: 'indexer',
  honeypotFeeFilter: 'off',
  priceQuoteGuard: 'off',
  tokenTrustMode: 'allowlist',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('valuation flags off: positions are byte-identical to today', () => {
  it('normalize output, default config', async () => {
    const out: Record<string, unknown> = {};
    for (const c of NORMALIZE_CASES) out[c.name] = asJson(await normalizeCase(c));
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__golden__/normalize-default.json');
  });

  it('normalize output, every flag explicitly off', async () => {
    const out: Record<string, unknown> = {};
    for (const c of NORMALIZE_CASES) out[c.name] = asJson(await normalizeCase(c, OFF_FLAGS));
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__golden__/normalize-default.json');
  });
});

function queryMatrix(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const shapes: Array<Record<string, unknown>> = [
    {},
    { owner: '0xAbCd000000000000000000000000000000000001' },
    { poolId: '0x' + 'd'.repeat(64) },
    { positionId: '366810' },
  ];
  for (const shape of shapes)
    for (const status of ['active', 'inactive', 'all', undefined])
      for (const includeRisky of [true, false])
        for (const sort of [SORTS[0], SORTS[5], SORTS[6]])
          out.push({
            chainId: 1,
            protocol: 'uniswap-v4',
            sort,
            page: 1,
            limit: 20,
            activeOnly: false,
            status,
            range: 'in',
            minValueUsd: 500,
            minPoolTvl: 1000,
            includeRisky,
            ...shape,
          });
  return out;
}

async function filters(config: Record<string, unknown>): Promise<string> {
  const { repo } = positionsRepo(new Map([[1, []]]), makeRankConfig(config));
  const rows = [];
  for (const query of queryMatrix()) {
    const plan = await repo.leaderboardPlan(query as never);
    rows.push({ query, filter: plan.filter, shapeFilter: plan.shapeFilter, hint: plan.hint ?? null, countHint: plan.countHint ?? null, countKey: plan.countKey });
  }
  return JSON.stringify(rows, null, 2);
}

describe('valuation flags off: leaderboard filters are identical to today', () => {
  it('default config', async () => {
    await expect(await filters({})).toMatchFileSnapshot('./__golden__/leaderboard-filters-default.json');
  });
  it('honeypot filter explicitly off', async () => {
    await expect(await filters({ honeypotFeeFilter: 'off' })).toMatchFileSnapshot('./__golden__/leaderboard-filters-default.json');
  });
  it('anchor exemption on / off with the honeypot filter off (the exemption alone adds nothing)', async () => {
    await expect(await filters({ honeypotFeeAnchorExempt: 'off' })).toMatchFileSnapshot('./__golden__/leaderboard-filters-default.json');
    await expect(await filters({ honeypotFeeFilter: 'off', honeypotFeeAnchorExempt: 'on' })).toMatchFileSnapshot('./__golden__/leaderboard-filters-default.json');
  });
});
