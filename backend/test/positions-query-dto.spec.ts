import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { TopPositionsQueryDto } from '../src/leaderboard/dto/top-positions-query.dto.js';

// The @Query ValidationPipe is inert under tsx dev (decorator metadata is
// dropped by esbuild — see Session Learnings), so the owner @Matches guard only
// runs in the prod tsc build. These tests exercise it directly so a regression
// in the regex / transform is caught regardless of runtime.
function build(over: Record<string, unknown>) {
  const dto = plainToInstance(TopPositionsQueryDto, { protocol: 'uniswap-v4', ...over });
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors };
}

describe('TopPositionsQueryDto — owner validation', () => {
  const LOWER = '0x1111111111111111111111111111111111111111';

  it('accepts a checksummed/uppercase address and lowercases it', () => {
    const { dto, errors } = build({ owner: LOWER.toUpperCase() });
    expect(errors).toHaveLength(0);
    expect(dto.owner).toBe(LOWER); // @Transform lowercases before @Matches
  });

  it('trims surrounding whitespace', () => {
    const { dto, errors } = build({ owner: `  ${LOWER}  ` });
    expect(errors).toHaveLength(0);
    expect(dto.owner).toBe(LOWER);
  });

  it('rejects a non-hex owner', () => {
    const { errors } = build({ owner: '0xZZZ1111111111111111111111111111111111111' });
    expect(errors.some((e) => e.property === 'owner')).toBe(true);
  });

  it('rejects a wrong-length owner (too short)', () => {
    const { errors } = build({ owner: '0x1234' });
    expect(errors.some((e) => e.property === 'owner')).toBe(true);
  });

  it('rejects a non-0x-prefixed owner', () => {
    const { errors } = build({ owner: '1111111111111111111111111111111111111111' });
    expect(errors.some((e) => e.property === 'owner')).toBe(true);
  });

  it('accepts an omitted owner (optional)', () => {
    const { dto, errors } = build({});
    expect(errors).toHaveLength(0);
    expect(dto.owner).toBeUndefined();
  });
});
