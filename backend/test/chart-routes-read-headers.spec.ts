/*
 * Every chart route is a user read — the position lookup has a 2 s budget and
 * its timeout is a 503 — so each one must answer that 503 with `Retry-After`,
 * like the list and detail routes beside it.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ChartsController } from '../src/charts/charts.controller.js';
import { QueryTimeoutException } from '../src/database/user-read.js';
import { PoolsController } from '../src/pools/pools.controller.js';
import { V1PoolsController } from '../src/v1/v1-pools.controller.js';
import { V1PositionsController } from '../src/v1/v1-positions.controller.js';

const POOL = '0x' + 'ab'.repeat(32);

function timingOutCharts() {
  const fail = async () => {
    throw new QueryTimeoutException();
  };
  return { getPositionCharts: fail, getPoolCharts: fail };
}

function recorder() {
  const headers: Record<string, string> = {};
  return { headers, res: { setHeader: (name: string, value: string) => (headers[name] = value) } };
}

describe('chart routes answer a read timeout with Retry-After', () => {
  it.each([
    [
      '/api position charts',
      (res: { setHeader: (n: string, v: string) => unknown }) =>
        new ChartsController(timingOutCharts() as never).getCharts(1, 'uniswap-v4', '7', res, 'all'),
    ],
    [
      '/v1 position charts',
      (res: { setHeader: (n: string, v: string) => unknown }) =>
        new V1PositionsController({} as never, timingOutCharts() as never).positionCharts(1, 'uniswap-v4', '7', res, 'all'),
    ],
    [
      '/api pool charts',
      (res: { setHeader: (n: string, v: string) => unknown }) =>
        new PoolsController({} as never, timingOutCharts() as never).getPoolCharts(1, 'uniswap-v4', POOL, res, 'all'),
    ],
    [
      '/v1 pool charts',
      (res: { setHeader: (n: string, v: string) => unknown }) =>
        new V1PoolsController({} as never, timingOutCharts() as never).poolCharts(1, 'uniswap-v4', POOL, res, 'all'),
    ],
  ])('%s', async (_name, call) => {
    const { headers, res } = recorder();
    await expect(call(res)).rejects.toBeInstanceOf(QueryTimeoutException);
    expect(headers['Retry-After']).toBe('5');
  });
});
