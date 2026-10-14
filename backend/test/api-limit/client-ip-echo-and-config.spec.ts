import { NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientIpEchoController } from '../../src/common/client-ip-echo.controller.js';
import { AppConfigService } from '../../src/config/app-config.service.js';

describe('GET /diag/client-ip', () => {
  const req = (over: Record<string, unknown> = {}) =>
    ({
      ip: '203.0.113.7',
      ips: ['203.0.113.7'],
      socket: { remoteAddress: '100.64.0.2' },
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7', 'x-real-ip': '203.0.113.7' },
      ...over,
    }) as never;

  it('is a 404 unless CLIENT_IP_ECHO is on', () => {
    const off = new ClientIpEchoController({ clientIpEcho: false, trustProxyHops: 1 } as never);
    expect(() => off.echo(req())).toThrow(NotFoundException);
  });

  it('answers with what the process makes of the caller, so TRUST_PROXY_HOPS can be set from a measurement', () => {
    const on = new ClientIpEchoController({ clientIpEcho: true, trustProxyHops: 1 } as never);
    expect(on.echo(req())).toEqual({
      ip: '203.0.113.7',
      ips: ['203.0.113.7'],
      limiterKey: '203.0.113.7',
      socketPeer: '100.64.0.2',
      trustProxyHops: 1,
      xForwardedFor: '1.2.3.4, 203.0.113.7',
      xRealIp: '203.0.113.7',
      forwarded: null,
      cfConnectingIp: null,
    });
  });

  it('shows the limiter key an IPv6 caller is budgeted under, and copes with repeated headers and no socket', () => {
    const on = new ClientIpEchoController({ clientIpEcho: true, trustProxyHops: 0 } as never);
    const out = on.echo(req({ ip: '2001:db8:1:2::9', socket: undefined, headers: { 'x-forwarded-for': ['a', 'b'] } }));
    expect(out).toMatchObject({ limiterKey: '2001:db8:1:2::/64', socketPeer: null, xForwardedFor: 'a, b', trustProxyHops: 0 });
  });
});

describe('the /api budget settings', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('default to today: off, memory, the placeholder numbers, no read share, no echo', () => {
    const config = new AppConfigService();
    expect(config.apiLimitMode).toBe('off');
    expect(config.apiLimiterStore).toBe('memory');
    expect(config.apiLimitPoints10s).toBe(100);
    expect(config.apiLimitPointsHour).toBe(10_000);
    expect(config.apiLimitMaxInFlight).toBe(24);
    expect(config.apiLimitCountMissPerMin).toBe(3);
    expect(config.apiReadShare).toBe(1);
    expect(config.clientIpEcho).toBe(false);
  });

  it('read the env, case-insensitively, with blank meaning unset', () => {
    vi.stubEnv('API_LIMIT_MODE', ' Enforce ');
    vi.stubEnv('API_LIMITER_STORE', 'REDIS');
    vi.stubEnv('API_LIMIT_POINTS_10S', '250');
    vi.stubEnv('API_LIMIT_POINTS_HOUR', '');
    vi.stubEnv('API_LIMIT_MAX_IN_FLIGHT', '32');
    vi.stubEnv('API_LIMIT_COUNT_MISS_PER_MIN', '6');
    vi.stubEnv('API_READ_SHARE', '0.5');
    vi.stubEnv('CLIENT_IP_ECHO', 'ON');
    const config = new AppConfigService();
    expect(config.apiLimitMode).toBe('enforce');
    expect(config.apiLimiterStore).toBe('redis');
    expect(config.apiLimitPoints10s).toBe(250);
    expect(config.apiLimitPointsHour).toBe(10_000);
    expect(config.apiLimitMaxInFlight).toBe(32);
    expect(config.apiLimitCountMissPerMin).toBe(6);
    expect(config.apiReadShare).toBe(0.5);
    expect(config.clientIpEcho).toBe(true);
  });

  it('read garbage as the default rather than a zero that would refuse everything', () => {
    for (const name of ['API_LIMIT_POINTS_10S', 'API_LIMIT_POINTS_HOUR', 'API_LIMIT_MAX_IN_FLIGHT', 'API_LIMIT_COUNT_MISS_PER_MIN']) {
      for (const bad of ['abc', '0', '-5']) {
        vi.stubEnv(name, bad);
        const config = new AppConfigService();
        const value = { API_LIMIT_POINTS_10S: config.apiLimitPoints10s, API_LIMIT_POINTS_HOUR: config.apiLimitPointsHour, API_LIMIT_MAX_IN_FLIGHT: config.apiLimitMaxInFlight, API_LIMIT_COUNT_MISS_PER_MIN: config.apiLimitCountMissPerMin }[name]!;
        expect(value, `${name}=${bad}`).toBeGreaterThan(0);
        vi.unstubAllEnvs();
      }
    }
  });

  it('count the read share only inside (0, 1)', () => {
    for (const [raw, expected] of [['0.25', 0.25], ['1', 1], ['0', 1], ['-1', 1], ['2', 1], ['abc', 1], ['', 1]] as const) {
      vi.stubEnv('API_READ_SHARE', raw);
      expect(new AppConfigService().apiReadShare, raw).toBe(expected);
      vi.unstubAllEnvs();
    }
  });

  it('refuse an unknown mode at boot rather than quietly running a different one', () => {
    vi.stubEnv('API_LIMIT_MODE', 'strict');
    expect(() => new AppConfigService()).toThrow();
  });
});
