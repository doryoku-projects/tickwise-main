import { ConflictException } from '@nestjs/common';
import type { BackfillPauseState, PausedBackfill, SyncRepository } from '../database/sync.repository.js';
import type { QueueService } from '../queues/queue.service.js';

/**
 * The admin "run a backfill" request, shared by BOTH routes that enqueue one
 * — `POST /admin/sync/run` (x-admin-secret) and `POST /admin/ops/sync` (the
 * admin panel's JWT route) — so they answer a PAUSED chain the same way
 * (audit C-pause; the JWT route used to enqueue a job SyncService then
 * refused silently, and `{all}` neither skipped nor named the paused chains).
 *
 * The real gate stays in `SyncService.runBackfill` (every start path reaches
 * it, a job left waiting included); this is the operator's early answer.
 */

/** The pause reads the routes need; a repository without the lever (spec fakes) never reports a pause. */
export type BackfillPauseReader = Partial<Pick<SyncRepository, 'backfillPauseState' | 'pausedBackfills'>> | undefined;

type Enqueuer = Pick<QueueService, 'enqueueBackfill' | 'enqueueBackfillAll'>;

export interface PausedBackfillView {
  chainId: number;
  protocol: string;
  pausedAt: string;
  pausedBy: string;
  inProgress: boolean;
}

/** A paused backfill as the admin routes report it (ISO time). */
export function pausedView(p: PausedBackfill): PausedBackfillView {
  return { chainId: p.chainId, protocol: p.protocol, pausedAt: p.pausedAt.toISOString(), pausedBy: p.pausedBy, inProgress: p.inProgress };
}

/** The chain's pause, or null. */
export async function backfillPauseOf(repo: BackfillPauseReader, chainId: number, protocol: string): Promise<BackfillPauseState | null> {
  return typeof repo?.backfillPauseState === 'function' ? repo.backfillPauseState(chainId, protocol) : null;
}

/** Every paused backfill (empty without the lever). */
export async function pausedBackfillList(repo: BackfillPauseReader): Promise<PausedBackfill[]> {
  return typeof repo?.pausedBackfills === 'function' ? repo.pausedBackfills() : [];
}

/**
 * `{all: true}`: one backfill per enabled integration EXCEPT the paused ones,
 * which are skipped and named in `skippedPaused`. With nothing paused this is
 * exactly `enqueueBackfillAll(fromStart)`, the call both routes always made.
 */
export async function enqueueBackfillAllUnlessPaused(
  queues: Enqueuer,
  repo: BackfillPauseReader,
  integrations: ReadonlyArray<{ chainId: number; protocol: string }>,
  fromStart: boolean,
): Promise<{ jobs: Array<{ chainId: number; protocol: string; jobId?: string }>; fromStart: boolean; skippedPaused?: PausedBackfillView[] }> {
  const paused = await pausedBackfillList(repo);
  if (paused.length === 0) return { jobs: await queues.enqueueBackfillAll(fromStart), fromStart };
  const skip = new Set(paused.map((p) => `${p.chainId}:${p.protocol}`));
  const jobs: Array<{ chainId: number; protocol: string; jobId?: string }> = [];
  for (const integration of integrations) {
    if (skip.has(`${integration.chainId}:${integration.protocol}`)) continue;
    const jobId = await queues.enqueueBackfill(integration.chainId, integration.protocol, fromStart);
    jobs.push({ chainId: integration.chainId, protocol: integration.protocol, jobId });
  }
  return { jobs, fromStart, skippedPaused: paused.map(pausedView) };
}

/**
 * One chain: refused with a 409 naming the pause while it is PAUSED — above
 * all a `fromStart`, whose cursor reset would throw away the walk the pause
 * exists to keep — else enqueued as always.
 */
export async function enqueueBackfillUnlessPaused(
  queues: Enqueuer,
  repo: BackfillPauseReader,
  chainId: number,
  protocol: string,
  fromStart: boolean,
): Promise<{ jobId: string | undefined; chainId: number; protocol: string; fromStart: boolean }> {
  const pause = await backfillPauseOf(repo, chainId, protocol);
  if (pause) {
    throw new ConflictException({
      error:
        `the backfill of ${chainId}:${protocol} is PAUSED since ${pause.pausedAt.toISOString()} (${pause.pausedBy}) — ` +
        `POST /admin/sync/backfill/resume first`,
      paused: pausedView({ chainId, protocol, ...pause }),
    });
  }
  return { jobId: await queues.enqueueBackfill(chainId, protocol, fromStart), chainId, protocol, fromStart };
}
