import { describe, expect, it } from 'vitest';
import {
  escapeRegexLiteral,
  foldNeedleAscii,
  literalFromRegExp,
  NeedleMatcher,
} from '../../src/read-models/core/regex-literal.js';
import { mongoRegexTest, prng } from '../support/mini-mongo.js';

/**
 * Pool search in the catalog (design §5.3, F3 / F14): case-insensitive
 * substring exactly as MongoDB's `$regex(escaped, 'i')` (PCRE2, UTF mode ≡
 * JavaScript `iu`) — the ASCII fast path pinned against the real RegExp by a
 * brute force over every code point, the needle parsing against what
 * js-bson / PCRE2 accept.
 */

const ASCII = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join('');

describe('ASCII folding (brute force over every code point)', () => {
  it('a needle character matches an ASCII character under `iu` iff its fold says so', () => {
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const needle = String.fromCodePoint(cp);
      const folded = foldNeedleAscii(needle);
      const re = new RegExp(escapeRegexLiteral(needle), 'iu');
      if (cp >= 0x80 && folded === null) {
        // Most of the range: no ASCII character may match.
        if (re.test(ASCII)) throw new Error(`U+${cp.toString(16)} matches ASCII under iu but folds to nothing`);
        continue;
      }
      expect(folded, `U+${cp.toString(16)}`).not.toBeNull();
      for (let a = 0; a < 128; a++) {
        const ch = String.fromCharCode(a);
        const lower = a >= 0x41 && a <= 0x5a ? a | 0x20 : a;
        expect(re.test(ch), `U+${cp.toString(16)} vs ${a}`).toBe(lower === folded![0]);
      }
    }
  }, 120_000);
});

const PIECES = ['a', 'B', 'x', '0', '9', 'f', 'F', 'ſ', 's', 'S', 'K', 'k', 'K', 'İ', 'i', 'ß', 'ss', 'Σ', 'σ', 'ς', 'é', 'É', '金', '🍏', ' ', '.', '(', '\\', '/', '\n', 'µ', 'Μ', 'ﬀ', 'ﬃ', 'Ａ', 'ａ'];

describe('NeedleMatcher', () => {
  it('equals RegExp(escaped, iu) — and mini-mongo, the specs’ MongoDB — on random haystacks and needles', () => {
    const rand = prng(4);
    const word = (max: number) => Array.from({ length: Math.floor(rand() * max) }, () => PIECES[Math.floor(rand() * PIECES.length)]).join('');
    for (let i = 0; i < 20_000; i++) {
      const haystack = word(8);
      const needle = rand() < 0.4 && haystack.length > 0 ? haystack.slice(Math.floor(rand() * haystack.length), Math.floor(rand() * haystack.length) + 3) : word(3);
      if (!needle) continue;
      const matcher = new NeedleMatcher(needle);
      const bytes = new TextEncoder().encode(haystack);
      const expected = new RegExp(escapeRegexLiteral(needle), 'iu').test(haystack);
      expect(matcher.matchBytes(bytes, 0, bytes.length), `${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`).toBe(expected);
      expect(mongoRegexTest(new RegExp(escapeRegexLiteral(needle), 'i'), haystack)).toBe(expected);
    }
  });

  it('is not plain `i`: ſ, K and K match their ASCII folds', () => {
    expect(new NeedleMatcher('ſ').matchBytes(new TextEncoder().encode('USD'), 0, 3)).toBe(true);
    expect(new NeedleMatcher('k').matchBytes(new TextEncoder().encode('K'), 0, 3)).toBe(true);
    expect(new RegExp('ſ', 'i').test('S')).toBe(false); // plain `i` would miss it
  });
});

describe('literalFromRegExp (the repository regex → a needle, or unsupported)', () => {
  it('round-trips every escaped literal the repository can build', () => {
    const rand = prng(9);
    const chars = ['a', 'Z', '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/', '\n', '\r', '-', '#', ' ', 'é', '🍏', 'ſ'];
    for (let i = 0; i < 5_000; i++) {
      const needle = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => chars[Math.floor(rand() * chars.length)]).join('');
      expect(literalFromRegExp(new RegExp(escapeRegexLiteral(needle), 'i'))).toEqual({ needle });
    }
  });

  it('refuses what MongoDB / js-bson refuse, and anything that is not the repository’s shape', () => {
    expect(literalFromRegExp(new RegExp(escapeRegexLiteral('a\u2028b'), 'i'))).toEqual({ unsupported: 'regex_pcre_escape' });
    expect(literalFromRegExp(new RegExp(escapeRegexLiteral('a\u2029'), 'i'))).toEqual({ unsupported: 'regex_pcre_escape' });
    expect(literalFromRegExp(new RegExp(escapeRegexLiteral('a\0b'), 'i'))).toEqual({ unsupported: 'regex_nul' });
    expect(literalFromRegExp(new RegExp(escapeRegexLiteral('\ud800x'), 'i'))).toEqual({ unsupported: 'regex_surrogate' });
    expect(literalFromRegExp(/abc/)).toEqual({ unsupported: 'regex_flags' });
    expect(literalFromRegExp(/abc/iu)).toEqual({ unsupported: 'regex_flags' });
    expect(literalFromRegExp(/a.c/i)).toEqual({ unsupported: 'regex_not_literal' });
    expect(literalFromRegExp(/a\dc/i)).toEqual({ unsupported: 'regex_not_literal' });
    expect(literalFromRegExp('abc')).toEqual({ unsupported: 'regex_type' });
    // mini-mongo (the oracle) fails the U+2028 needle the way MongoDB does.
    expect(() => mongoRegexTest(new RegExp(escapeRegexLiteral('a\u2028'), 'i'), 'x')).toThrow();
  });
});
