import { describe, expect, it } from 'vitest';
import { ApiLimitMeter, formatHour, formatMinute, percentiles } from '../../src/common/api-limit-meter.js';

describe('percentiles', () => {
  it('uses nearest-rank on the sorted values', () => {
    const p = percentiles(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(p).toEqual({ p50: 50, p95: 95, p99: 99, max: 100 });
  });
  it('is zero for nothing, and the value itself for one', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 });
    expect(percentiles([7])).toEqual({ p50: 7, p95: 7, p99: 7, max: 7 });
  });
  it('does not depend on the order it is given', () => {
    expect(percentiles([9, 1, 5, 3, 7])).toEqual(percentiles([1, 3, 5, 7, 9]));
  });
});

describe('ApiLimitMeter', () => {
  it('summarises a minute and starts the next one empty; an idle minute is nothing', () => {
    const meter = new ApiLimitMeter(0);
    meter.record('a', 3, 1);
    meter.record('a', 5, 2);
    meter.record('b', 1, 3);
    meter.inFlight(4);
    meter.inFlight(2);
    meter.limit('rate-10s', false);
    meter.limit('rate-10s', false);
    meter.limit('in-flight', true);
    meter.failOpen();
    const minute = meter.takeMinute()!;
    expect(minute).toMatchObject({
      requests: 3,
      points: 9,
      ips: 2,
      maxIpPoints: 8,
      maxInFlight: 4,
      limited: 1,
      wouldLimit: { 'rate-10s': 2 },
      failOpen: 1,
    });
    expect(meter.takeMinute()).toBeUndefined();
  });

  it('reports the hour once an hour has passed: per-IP points, the first-minute burst, the top addresses', () => {
    const meter = new ApiLimitMeter(0);
    // 'big' arrives at t=0 and spends 30 in its first minute, 70 more later.
    meter.record('big', 30, 0);
    meter.record('big', 40, 90_000);
    meter.record('big', 30, 1_000_000);
    meter.record('small', 2, 10_000);
    meter.record('small', 1, 20_000);
    expect(meter.takeHour(3_599_999)).toBeUndefined();
    const hour = meter.takeHour(3_600_000)!;
    expect(hour.ips).toBe(2);
    expect(hour.hour.max).toBe(100);
    expect(hour.hour.p50).toBe(3);
    expect(hour.firstMinute.max).toBe(30);
    expect(hour.firstMinute.p50).toBe(3);
    expect(hour.top).toEqual([['big', 100], ['small', 3]]);
    // The next hour starts clean.
    meter.record('later', 1, 3_700_000);
    expect(meter.takeHour(7_300_000)!.ips).toBe(1);
  });

  it('formats lines an operator can read and grep', () => {
    const meter = new ApiLimitMeter(0);
    meter.record('203.0.113.7', 3, 1);
    meter.limit('rate-hour', false);
    const minute = formatMinute('observe', meter.takeMinute()!);
    expect(minute).toContain('[api-limit] mode=observe 60s requests=1 points=3 ips=1');
    expect(minute).toContain('wouldLimit{rate-hour:1}');
    const hour = formatHour('observe', meter.takeHour(3_600_000)!);
    expect(hour).toContain('pointsPerIpHour{p50=3 p95=3 p99=3 max=3}');
    expect(hour).toContain('top: 203.0.113.7=3');
  });
});
