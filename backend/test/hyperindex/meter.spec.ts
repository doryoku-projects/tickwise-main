/*
 * The indexer meter: per-URL counters by lane, job and outcome, rolled and
 * logged once a minute as one `[indexer-budget]` line. It replaces the estimates
 * every Envio budget figure has rested on so far, so it must count exactly, keep
 * its tables bounded, and never be able to fail the call it is describing.
 */

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetIndexerMeters,
  displayUrl,
  formatBudgetLine,
  IndexerMeter,
  indexerMeterSnapshots,
  meterForUrl,
  METER_WINDOW_MS,
  percentile,
  rollAndLogIndexerMeters,
} from '../../src/subgraph/hyperindex/indexer-meter.js';

const URL_ = 'https://indexer.hyperindex.xyz/abc123/v1/graphql';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetIndexerMeters();
});

describe('IndexerMeter', () => {
  it('counts every call by lane, job and outcome, in the window and since boot', () => {
    const m = new IndexerMeter(URL_);
    m.record({ lane: 'interactive', job: '/api/top-positions/:id/uniswap-v4/:id/charts', outcome: '2xx', latencyMs: 120 });
    m.record({ lane: 'interactive', job: '/api/top-positions/:id/uniswap-v4/:id/charts', outcome: '429', latencyMs: 40 });
    m.record({ lane: 'live', job: 'live-listener', outcome: '2xx', latencyMs: 300 });
    m.record({ lane: 'sweep', job: 'pool-sync', outcome: 'network', latencyMs: 5 });
    m.record({ lane: 'refresh', outcome: 'timeout', latencyMs: 30_000 });

    const s = m.snapshot();
    expect(s.current.total).toBe(5);
    expect(s.current.lanes).toEqual({ interactive: 2, live: 1, health: 0, refresh: 1, sweep: 1 });
    expect(s.current.jobs).toEqual({
      '/api/top-positions/:id/uniswap-v4/:id/charts': 2,
      'live-listener': 1,
      'pool-sync': 1,
      untagged: 1,
    });
    expect(s.current.outcomes).toMatchObject({ '2xx': 2, '429': 1, network: 1, timeout: 1, abort: 0, '5xx': 0 });
    expect(s.sinceBoot.total).toBe(5);
    expect(s.lastMinute).toBeNull();
  });

  it('rolls the window: the closed minute becomes lastMinute, the new one starts empty, boot totals keep counting', () => {
    const m = new IndexerMeter(URL_);
    m.record({ lane: 'health', job: 'health', outcome: '2xx', latencyMs: 900 });
    vi.advanceTimersByTime(60_000);
    const closed = m.roll();

    expect(closed.total).toBe(1);
    expect(closed.durationMs).toBe(60_000);
    m.record({ lane: 'health', job: 'health', outcome: '2xx', latencyMs: 800 });
    const s = m.snapshot();
    expect(s.lastMinute!.total).toBe(1);
    expect(s.current.total).toBe(1);
    expect(s.sinceBoot.total).toBe(2);
  });

  it('reports latency p50/p95 and the interactive queue-wait p95', () => {
    const m = new IndexerMeter(URL_);
    for (let i = 1; i <= 100; i++) {
      m.record({ lane: 'interactive', job: 'x', outcome: '2xx', latencyMs: i, queuedMs: i === 100 ? 900 : 0 });
    }
    const w = m.snapshot().current;
    expect(w.p50Ms).toBe(50);
    expect(w.p95Ms).toBe(95);
    expect(w.interactiveQueueP95Ms).toBe(0);

    // Background waits do not pollute the user-facing number.
    const b = new IndexerMeter(URL_);
    b.record({ lane: 'sweep', job: 'x', outcome: '2xx', latencyMs: 1, queuedMs: 60_000 });
    expect(b.snapshot().current.interactiveQueueP95Ms).toBeNull();
  });

  it('folds job names past the cap into `other`, so a stray route cannot grow the table without bound', () => {
    const m = new IndexerMeter(URL_);
    for (let i = 0; i < 200; i++) m.record({ lane: 'sweep', job: `job-${i}`, outcome: '2xx', latencyMs: 1 });
    const jobs = m.snapshot().current.jobs;
    expect(Object.keys(jobs)).toHaveLength(65); // 64 named + other
    expect(jobs.other).toBe(136);
    // A job already in the table keeps counting under its own name.
    m.record({ lane: 'sweep', job: 'job-0', outcome: '2xx', latencyMs: 1 });
    expect(m.snapshot().current.jobs['job-0']).toBe(2);
  });

  it('never throws out of record, whatever it is handed', () => {
    const m = new IndexerMeter(URL_);
    expect(() =>
      m.record({ lane: 'nope' as never, job: undefined, outcome: 'weird' as never, latencyMs: NaN }),
    ).not.toThrow();
  });
});

describe('the once-a-minute [indexer-budget] line', () => {
  it('names the URL, total, lanes, jobs, 429s and percentiles', () => {
    const m = new IndexerMeter(URL_);
    m.record({ lane: 'interactive', job: '/v1/positions', outcome: '2xx', latencyMs: 100 });
    m.record({ lane: 'refresh', job: 'refresh', outcome: '429', latencyMs: 20 });
    const line = formatBudgetLine(URL_, m.roll());

    expect(line).toMatch(/^\[indexer-budget\] url=https:\/\/indexer\.hyperindex\.xyz\/abc123\/v1\/graphql total=2 /);
    expect(line).toContain('lanes{interactive=1 refresh=1}');
    expect(line).toContain('jobs{/v1/positions=1 refresh=1}');
    expect(line).toContain(' 429=1 ');
    expect(line).toMatch(/p50\/p95ms=\d+\/\d+/);
  });

  it('logs once a minute per URL with traffic, and stays silent for an idle URL', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const busy = meterForUrl(URL_);
    meterForUrl('https://idle.example.test/graphql');
    busy.record({ lane: 'live', job: 'live-listener', outcome: '2xx', latencyMs: 10 });

    vi.advanceTimersByTime(METER_WINDOW_MS);

    const lines = log.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith('[indexer-budget]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('live-listener=1');
    // The next minute has nothing to say.
    vi.advanceTimersByTime(METER_WINDOW_MS);
    expect(log.mock.calls.filter(([m]) => String(m).startsWith('[indexer-budget]'))).toHaveLength(1);
  });

  it('rollAndLogIndexerMeters returns exactly the lines it logged', () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    meterForUrl(URL_).record({ lane: 'health', job: 'health', outcome: '2xx', latencyMs: 1 });
    expect(rollAndLogIndexerMeters()).toHaveLength(1);
    expect(rollAndLogIndexerMeters()).toHaveLength(0);
  });
});

describe('snapshots and URLs', () => {
  it('is one meter per URL, listed for the admin status route', () => {
    expect(indexerMeterSnapshots()).toEqual([]);
    const a = meterForUrl(URL_);
    expect(meterForUrl(URL_)).toBe(a);
    a.record({ lane: 'sweep', job: 'pool-sync', outcome: '2xx', latencyMs: 3 });
    const [s] = indexerMeterSnapshots();
    expect(s.url).toBe(URL_);
    expect(s.current.jobs['pool-sync']).toBe(1);
  });

  it('never shows a query string or userinfo, in case a key ever rides in either', () => {
    expect(displayUrl('https://user:pass@indexer.example.test/v1/graphql?apikey=SECRET')).toBe(
      'https://indexer.example.test/v1/graphql',
    );
    expect(displayUrl('not a url?x=1')).toBe('not a url');
  });

  it('percentile is null on no data and nearest-rank otherwise', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
  });
});
