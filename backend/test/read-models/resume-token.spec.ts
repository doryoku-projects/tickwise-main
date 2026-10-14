/*
 * Resume tokens and cluster times (design §1 F4): the `_data` of a token is
 * `82` + the event's cluster time as 8 big-endian bytes, measured on the rig
 * (MongoDB 8.0.32, 3000/3000 events: token time == clusterTime).
 */
import { describe, expect, it } from 'vitest';
import {
  compareTimes,
  compareTokens,
  formatTime,
  maxTime,
  parseTime,
  timeFromBson,
  timeFromMs,
  tokenData,
  tokenTime,
} from '../../src/read-models/feeder/resume-token.js';

describe('resume tokens', () => {
  it('decodes the cluster time from a real rig token', () => {
    // An update event's token captured on m10-3 (2026-10-03), clusterTime {t: 1791042985, i: 3}.
    const data = '826AC125A9000000032B042C0100296E5A1004A02C3F6FE48F4041A453C120D4AD22E7463C6F7065726174696F6E54797065003C7570646174650046646F63756D656E744B65790046645F696400646AC09D39D50692A6C3259D65000004';
    expect(tokenTime(data)).toEqual({ t: 1791042985, i: 3 });
    expect(tokenTime({ _data: data })).toEqual({ t: 1791042985, i: 3 });
    expect(tokenData({ _data: data })).toBe(data);
  });

  it('refuses tokens that are not in the timestamp-prefixed form', () => {
    expect(tokenTime('')).toBeUndefined();
    expect(tokenTime('83' + '0'.repeat(30))).toBeUndefined();
    expect(tokenTime('8200')).toBeUndefined();
    expect(tokenTime(undefined)).toBeUndefined();
  });

  it('orders cluster times by seconds, then increment', () => {
    expect(compareTimes({ t: 5, i: 9 }, { t: 6, i: 0 })).toBeLessThan(0);
    expect(compareTimes({ t: 6, i: 2 }, { t: 6, i: 1 })).toBeGreaterThan(0);
    expect(compareTimes({ t: 6, i: 1 }, { t: 6, i: 1 })).toBe(0);
    expect(maxTime({ t: 1, i: 5 }, { t: 2, i: 0 })).toEqual({ t: 2, i: 0 });
    expect(compareTokens(`82${'00000005'}${'00000001'}`, `82${'00000004'}${'000000ff'}`)).toBeGreaterThan(0);
  });

  it('round-trips t:i and reads BSON timestamps in every shape the driver has used', () => {
    expect(parseTime(formatTime({ t: 1791041254, i: 889 }))).toEqual({ t: 1791041254, i: 889 });
    expect(parseTime('x')).toBeUndefined();
    expect(parseTime('1:-1')).toBeUndefined();
    expect(timeFromBson({ t: 7, i: 3 })).toEqual({ t: 7, i: 3 });
    expect(timeFromBson({ getHighBits: () => 7, getLowBits: () => 3 })).toEqual({ t: 7, i: 3 });
    expect(timeFromBson({ high: 7, low: 3 })).toEqual({ t: 7, i: 3 });
    expect(timeFromBson('nope')).toBeUndefined();
    expect(timeFromMs(12_345)).toEqual({ t: 12, i: 0 });
  });
});
