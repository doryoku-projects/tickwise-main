import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SUPPORTED_PROTOCOL_KEYS } from '../../config/protocols.config.js';

const POOL_SORTS = ['tvl', 'volume', 'fees', 'fee_apr', 'age'] as const;
/** See `SUPPORTED_PROTOCOL_KEYS` — derived, never re-listed. */
const PROTOCOLS = SUPPORTED_PROTOCOL_KEYS;

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().trim();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return value as boolean;
}

export type PoolSortKey = (typeof POOL_SORTS)[number];

export class TopPoolsQueryDto {
  /**
   * Omit for ALL enabled chains (scatter-gather merge across the per-chain
   * shards). When set, restricts to that one chain (must be registered).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;

  @IsString()
  @IsIn([...PROTOCOLS])
  protocol = 'uniswap-v4';

  @IsOptional()
  @IsIn(POOL_SORTS as unknown as string[])
  sort: PoolSortKey = 'tvl';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  minTvlUsd = 0;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  includeRisky = false;

  // 66 = a full v4 pool id (`0x` + 64 hex). At 64 the search box's own
  // placeholder ("token or pool address") 400'd on every v4 pool address.
  @IsOptional()
  @IsString()
  @MaxLength(66)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  /**
   * `equity` restricts results to tokenized-equity pools (Robinhood Chain).
   * A chain with no tokenized equities returns zero rows, never all rows.
   */
  @IsOptional()
  @IsIn(['equity'])
  assetClass?: 'equity';

}
