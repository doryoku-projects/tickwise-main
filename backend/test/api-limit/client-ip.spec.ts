import { describe, expect, it } from 'vitest';
import { clientLimiterKey } from '../../src/common/client-ip.js';

describe('clientLimiterKey', () => {
  it('keeps an IPv4 address as itself', () => {
    expect(clientLimiterKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientLimiterKey(' 203.0.113.7 ')).toBe('203.0.113.7');
  });

  it('reads an IPv4-mapped IPv6 address (a dual-stack socket) as the IPv4', () => {
    expect(clientLimiterKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientLimiterKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys an IPv6 address by its /64: the first four groups, normalised', () => {
    expect(clientLimiterKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientLimiterKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(clientLimiterKey('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
  });

  it('puts two addresses of one /64 on one key and the neighbouring /64 on another', () => {
    const a = clientLimiterKey('2001:db8:aaaa:bbbb:1::1');
    const b = clientLimiterKey('2001:db8:aaaa:bbbb:9999:8888:7777:6666');
    const c = clientLimiterKey('2001:db8:aaaa:bbbc::1');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('expands the compressed forms before cutting', () => {
    expect(clientLimiterKey('::1')).toBe('0:0:0:0::/64');
    expect(clientLimiterKey('::')).toBe('0:0:0:0::/64');
    expect(clientLimiterKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(clientLimiterKey('2001:db8::ff:1')).toBe('2001:db8:0:0::/64');
    expect(clientLimiterKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(clientLimiterKey('::1.2.3.4')).toBe('0:0:0:0::/64');
  });

  it('is undefined for anything that is not an address', () => {
    for (const bad of [undefined, null, '', '   ', 'localhost', '999.1.1.1', '1.2.3', '2001:db8::1::2', 'x:y:z', '1.2.3.4.5']) {
      expect(clientLimiterKey(bad as never), String(bad)).toBeUndefined();
    }
  });
});
