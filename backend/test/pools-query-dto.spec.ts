import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { TopPoolsQueryDto } from '../src/pools/dto/top-pools-query.dto.js';

// The @Query ValidationPipe is inert under tsx dev, so these limits only bite in
// the prod tsc build — pinned here directly.
function errorsFor(search: string) {
  const dto = plainToInstance(TopPoolsQueryDto, { protocol: 'uniswap-v4', search });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('TopPoolsQueryDto — search length', () => {
  // A real v4 pool id (Ethereum ETH/USDT at a 21.079% fee): `0x` + 64 hex = 66 chars.
  const POOL_ID = '0x6e8c215727bc4b56f663645e409ce4c0346db25a1390f9a8d1c107bd3ae8daf8';

  it('accepts a full v4 pool id (66 characters) — the box says "token or pool address"', () => {
    expect(POOL_ID).toHaveLength(66);
    expect(errorsFor(POOL_ID)).toHaveLength(0);
  });

  it('still refuses anything longer', () => {
    expect(errorsFor(`${POOL_ID}a`).map((e) => e.property)).toEqual(['search']);
  });
});
