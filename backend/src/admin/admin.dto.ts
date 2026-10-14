import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';
import { SUPPORTED_PROTOCOL_KEYS } from '../config/protocols.config.js';

export class RunSyncDto {
  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @ValidateIf((dto: RunSyncDto) => dto.all !== true)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;

  @ValidateIf((dto: RunSyncDto) => dto.all !== true)
  @IsString()
  // Same registry-derived list as the `/v1` query DTOs. It carried the same
  // stale `uniswap-v3` literal, which here would have enqueued a backfill for a
  // protocol with no adapter row.
  @IsIn([...SUPPORTED_PROTOCOL_KEYS])
  protocol?: string;

  /**
   * When true, reset the sync cursor to zero before running the backfill so
   * the whole subgraph is rescanned ascending. Catches positions that may
   * have been back-dated or missed in earlier runs. Default false (resume
   * from the persisted cursor).
   */
  @IsOptional()
  @IsBoolean()
  fromStart?: boolean;
}

/**
 * `POST /admin/sync/backfill/pause` and `/resume` (audit C-pause): one chain
 * (`chainId` + `protocol`) or every enabled one (`all: true`). Checked again in
 * the handler — the pipe is inert under tsx.
 */
export class BackfillPauseDto {
  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @ValidateIf((dto: BackfillPauseDto) => dto.all !== true)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;

  @ValidateIf((dto: BackfillPauseDto) => dto.all !== true)
  @IsString()
  @IsIn([...SUPPORTED_PROTOCOL_KEYS])
  protocol?: string;

  /** Pause only: why (stored as `backfillPausedBy: "admin: <note>"`, ≤ 200 chars). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  /** Resume only: re-enqueue the interrupted walk from its cursor (default true). */
  @IsOptional()
  @IsBoolean()
  enqueue?: boolean;
}

/** `POST /admin/read-models/override` (P-R kill switch). Checked again in the handler: the pipe is inert under tsx. */
export class ReadModelsOverrideDto {
  @IsString()
  @IsIn(['rank', 'pools'])
  model!: 'rank' | 'pools';

  @IsString()
  @IsIn(['off', 'shadow', 'serve'])
  mode!: 'off' | 'shadow' | 'serve';
}

/** `POST /admin/read-models/rescan`: one shard (`<chainId>:<protocol>`) or, without it, everything. */
export class ReadModelsRescanDto {
  @IsString()
  @IsIn(['rank', 'pools'])
  model!: 'rank' | 'pools';

  @IsOptional()
  @IsString()
  shard?: string;
}

/** `POST /admin/read-models/scan`: `target` `feeder` (default — the cold / shard scan, field backfill) or `verify` (lane B's verification scan). */
export class ReadModelsScanDto {
  @IsString()
  @IsIn(['pause', 'resume', 'pace'])
  action!: 'pause' | 'resume' | 'pace';

  @IsOptional()
  @IsString()
  @IsIn(['feeder', 'verify'])
  target?: 'feeder' | 'verify';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  docsPerSec?: number;
}
