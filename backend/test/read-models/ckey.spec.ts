import { describe, expect, it } from 'vitest';
import { ckey, ckeyBytes, CkeyIndex, inCkeyDomain, MAX_DIGIT_RUN } from '../../src/read-models/core/ckey.js';
import { Dictionary } from '../../src/read-models/core/dictionary.js';
import { collatedEqual } from '../support/mini-mongo.js';

/**
 * Collation keys (design §4.4, F1 / F12; P-R R3): within the domain
 * (printable ASCII, digit runs ≤ 254) two strings are equal under the
 * leaderboard collation iff their ckeys are equal.
 *
 * The partition test regenerates EXACTLY the string set measured on the M10
 * rig (MongoDB 8.0.32, `$documents` + `$group` under `{locale: 'en',
 * numericOrdering: true}`, scratchpad `ckey-rig.js`, 2026-10-03): 10,817
 * strings fell into 10,312 collation groups, none mixing ckeys, none split.
 */

/** The rig's string set (same construction as the rig script). */
function rigStrings(): string[] {
  const P: string[] = [];
  for (let c = 0x20; c <= 0x7e; c++) P.push(String.fromCharCode(c));
  const set = new Set<string>();
  for (const a of P) set.add(a);
  for (const a of P) for (const b of P) set.add(a + b);
  const small = ['0', '1', '9', 'a', 'A', 'x', '.', '-', ' ', 'Z'];
  for (const a of small) for (const b of small) for (const c of small) set.add(a + b + c);
  const tiny = ['0', '1', 'a', 'x', '00'];
  for (const a of tiny) for (const b of tiny) for (const c of tiny) for (const d of tiny) set.add(a + b + c + d);
  for (let k = 0; k < 45; k++) {
    set.add('0'.repeat(k) + '123');
    set.add('x' + '0'.repeat(k) + '7y');
    set.add('0x' + '0'.repeat(k));
  }
  set.add('1' + '0'.repeat(30));
  set.add('0001' + '0'.repeat(30));
  set.add('9'.repeat(40));
  set.add('0' + '9'.repeat(40));
  set.add('0x' + '1'.repeat(64));
  set.add('0x00' + '1'.repeat(64));
  set.add('0x' + '1'.repeat(63) + '0');
  set.add('1'.repeat(254));
  set.add('0' + '1'.repeat(254));
  set.add('1'.repeat(255));
  set.add('0' + '1'.repeat(255));
  set.add('1'.repeat(300));
  set.add('00' + '1'.repeat(300));
  for (const s of ['a01b2', 'a1b02', '0x0ab', '0x00ab', 'uniswap-v4', 'uniswap-v04']) set.add(s);
  return [...set];
}

/** The rig's measured group count for `rigStrings()`. */
const RIG_GROUPS = 10_312;

describe('ckey', () => {
  it('maps the rig vectors (F1, F12)', () => {
    for (const s of ['0x00a1', '0x0a01', '0x0a1', '0x000a1']) expect(ckey(s)).toBe(ckey('0x0a1'));
    expect(ckey('0x00A1')).not.toBe(ckey('0x00a1'));
    expect(ckey('01')).toBe(ckey('1'));
    expect(ckey('000')).toBe('0');
    expect(ckey('none')).not.toBe(ckey('NONE'));
    expect(ckey('a01b2')).toBe(ckey('a1b02'));
    expect(ckey('0x0ab')).toBe(ckey('0x00ab'));
    expect(ckey('uniswap-v04')).toBe(ckey('uniswap-v4'));
    expect(ckey('10')).not.toBe(ckey('1'));
    expect(ckey('a0b')).toBe(ckey('a00b'));
  });

  it('reproduces the rig-measured partition of 10,817 strings into 10,312 groups — and so does mini-mongo’s independent model', () => {
    const strings = rigStrings();
    expect(strings).toHaveLength(10_817);
    expect(strings.every(inCkeyDomain), 'the rig set is inside the domain except the long runs').toBe(false);
    const classes = new Set(strings.map(ckey));
    expect(classes.size).toBe(RIG_GROUPS);
    // mini-mongo's tokenised BigInt model (written independently) agrees pairwise on a sample of collisions and non-collisions.
    const byKey = new Map<string, string[]>();
    for (const s of strings) byKey.set(ckey(s), [...(byKey.get(ckey(s)) ?? []), s]);
    let checked = 0;
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (let i = 1; i < group.length; i++) expect(collatedEqual(group[0]!, group[i]!), `${group[0]} ~ ${group[i]}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    const keys = [...byKey.keys()];
    for (let i = 0; i + 1 < keys.length; i += 7) expect(collatedEqual(byKey.get(keys[i]!)![0]!, byKey.get(keys[i + 1]!)![0]!)).toBe(false);
  });

  it('the byte form equals the string form on every in-domain rig string', () => {
    const out = { buf: new Uint8Array(4) };
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    for (const s of rigStrings().filter(inCkeyDomain)) {
      const bytes = enc.encode(`#${s}#`);
      const len = ckeyBytes(bytes, 1, bytes.length - 1, out);
      expect(dec.decode(out.buf.subarray(0, len)), s).toBe(ckey(s));
    }
  });

  it('knows its domain: printable ASCII only, digit runs of at most 254', () => {
    expect(inCkeyDomain('0xabc DEF~')).toBe(true);
    expect(inCkeyDomain('a\u0001b')).toBe(false); // C0: ignorable under the collation (F12)
    expect(inCkeyDomain('a\u007fb')).toBe(false); // DEL
    expect(inCkeyDomain('a​b')).toBe(false); // ZWSP
    expect(inCkeyDomain('é')).toBe(false);
    expect(inCkeyDomain('1'.repeat(MAX_DIGIT_RUN))).toBe(true);
    // ICU chunks runs at 254 digits: '1' + '0'×254 + '5' == '1' + '0'×253 + '5' on the rig, while their ckeys differ.
    expect(inCkeyDomain('1'.repeat(MAX_DIGIT_RUN + 1))).toBe(false);
    expect(ckey('1' + '0'.repeat(254) + '5')).not.toBe(ckey('1' + '0'.repeat(253) + '5'));
    expect(collatedEqual('1' + '0'.repeat(254) + '5', '1' + '0'.repeat(253) + '5')).toBe(true);
  });

  it('classes a dictionary incrementally; outside entries get no class; literals map to classes', () => {
    const dict = new Dictionary();
    for (const s of ['0x00a1', 'none', '0x0a01', 'a\u0001b', 'NONE', 'caf\u00e9', 'a\u007fb', '1'.repeat(255)]) dict.intern(s);
    const index = new CkeyIndex(4);
    index.extend(dict.sharedView());
    expect(index.size).toBe(8);
    // Non-ASCII, DEL and a digit run past 254 are outside the domain too (the engine's own check).
    for (const id of [5, 6, 7]) expect(index.outside(id), String(id)).toBe(true);
    expect(index.classOfId(0)).toBe(index.classOfId(2));
    expect(index.classOfId(1)).not.toBe(index.classOfId(4));
    expect(index.classOfId(3)).toBe(0);
    expect(index.outside(3)).toBe(true);
    expect(index.outsideEntries).toBe(4);
    expect(index.classOfLiteral('0x000a1')).toBe(index.classOfId(0));
    expect(index.classOfLiteral('never-seen')).toBe(0);
    expect(index.classOfLiteral('no\u0001ne')).toBeUndefined();
    for (let i = 0; i < 100; i++) dict.intern(`0x${i}`);
    index.extend(dict.sharedView());
    expect(index.size).toBe(dict.size);
    expect(index.classOfId(dict.find('0x7'))).toBe(index.classOfLiteral('0x007'));
  });
});
