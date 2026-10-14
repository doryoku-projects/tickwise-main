import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'sync_runs',
  timestamps: true,
})
export class SyncRun {
  @Prop({ type: Number, required: true })
  chainId!: number;

  @Prop({ type: String, required: true })
  protocol!: string;

  // `partial`: a refresh that finished with some chunks failed (stale sweep skipped).
  // `interrupted`: the process stopped mid-run — closed by its own shutdown, or
  // by the reaper once the run's heartbeat went quiet (a SIGKILL, crash or OOM).
  // A run that later finishes after all overwrites it with its real outcome.
  @Prop({ type: String, enum: ['running', 'success', 'partial', 'failed', 'interrupted'], required: true })
  status!: 'running' | 'success' | 'partial' | 'failed' | 'interrupted';

  @Prop({ type: Number, default: 0 })
  fetched!: number;

  @Prop({ type: Number, default: 0 })
  refreshed!: number;

  @Prop({ type: Number, default: 0 })
  upserted!: number;

  @Prop({ type: Number, default: 0 })
  transactionsUpserted!: number;

  @Prop({ type: Number, default: 0 })
  markedClosed!: number;

  @Prop({ type: Number, default: 0 })
  durationMs!: number;

  @Prop({ type: String })
  error?: string;

  @Prop({ type: Date, default: () => new Date() })
  startedAt!: Date;

  @Prop({ type: Date })
  finishedAt?: Date;

  // Stamped while the run is open (`SyncRepository`, every 2 min): a `running`
  // row whose stamp is older than `RUN_STALE_MS` belongs to a dead process.
  @Prop({ type: Date })
  heartbeatAt?: Date;
}

export type SyncRunDocument = HydratedDocument<SyncRun>;
export const SyncRunSchema = SchemaFactory.createForClass(SyncRun);
SyncRunSchema.index({ chainId: 1, protocol: 1, startedAt: -1 });
// TTL: Mongo auto-deletes sync_runs rows older than 90 days. The audit log
// would otherwise grow unbounded (one row per sync execution).
SyncRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
