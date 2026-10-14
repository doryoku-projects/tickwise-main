import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { SUPPORTED_PROTOCOL_KEYS } from '../../config/protocols.config.js';

const SORTS = [
  'apr',
  'fee_apr',
  'roi',
  'age',
  'pnl',
  'underlying_value',
  'nft_id_asc',
  'nft_id_desc',
] as const;
/**
 * Derived from `protocols.config.ts`, never re-listed here — the literal
 * `['uniswap-v3', 'uniswap-v4']` this replaced advertised a protocol the
 * registry does not carry, so `?protocol=uniswap-v3` passed validation and was
 * then 400'd by `LeaderboardService.assertSupported`.
 */
const PROTOCOLS = SUPPORTED_PROTOCOL_KEYS;
const STATUSES = ['active', 'inactive', 'all'] as const;
const RANGES = ['all', 'in', 'out'] as const;

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

export class TopPositionsQueryDto {
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
  @IsIn(SORTS as unknown as string[])
  sort = 'apr';

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
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  activeOnly = true;

  @IsOptional()
  @IsIn(STATUSES as unknown as string[])
  status?: 'active' | 'inactive' | 'all';

  @IsOptional()
  @IsIn(RANGES as unknown as string[])
  range = 'all';

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  minValueUsd = 0;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  minPoolTvl = 1000;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  includeRisky = false;

  /**
   * Exact-match filter on `positionId` (= tokenId for ERC721 protocols like
   * Uniswap v4). When set, all other ranking/filter constraints still apply
   * but the result is restricted to that single id. Used by the search bar
   * so a user can jump straight to a known position regardless of pagination.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  positionId?: string;

  /** Filter positions to those belonging to a specific pool (lowercased pool address). */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  poolId?: string;

  /**
   * Filter positions to a single owner wallet (EVM address, case-insensitive —
   * owners are stored lowercased). Lets a client fetch every position held by an
   * address. Composes with the other filters/sorts/pagination, so the defaults
   * (open, non-risky, pool TVL ≥ minPoolTvl) still apply — to fetch the wallet's
   * COMPLETE set (closed + small + risky included) combine with
   * `status=all&minValueUsd=0&minPoolTvl=0&includeRisky=true`.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(/^0x[a-f0-9]{40}$/, { message: 'owner must be a 0x-prefixed 40-hex EVM address' })
  owner?: string;

  /**
   * `equity` restricts results to tokenized-equity pools (Robinhood Chain).
   * A chain with no tokenized equities returns zero rows, never all rows.
   */
  @IsOptional()
  @IsIn(['equity'])
  assetClass?: 'equity';

}
