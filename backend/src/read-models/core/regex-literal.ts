/**
 * Case-insensitive substring search, exactly as MongoDB evaluates the escaped
 * `$regex` the pools search sends (design §4.9, §5.3; F3 / F14).
 *
 *  - The repository escapes the needle (`escapeRegexLiteral`) and builds
 *    `new RegExp(escaped, 'i')`; js-bson sends `.source`, which JavaScript
 *    has itself escaped (`/` → `\/`, line terminators → `\n` `\r`
 *    `\u2028` `\u2029`). PCRE2 reads `\/`, `\n`, `\r` literally and REJECTS
 *    `\u2028` / `\u2029` (error 51091), and js-bson refuses a source with a
 *    NUL byte — those needles must fail on the Mongo path as they do today,
 *    so the engine never answers them (`unsupported`).
 *  - MongoDB's `i` (PCRE2, UTF mode) matches like JavaScript's `iu` (simple
 *    case folding) on every vector measured, NOT like plain `i`.
 *  - Brute force over every code point (F3, and `pool-search.spec`): no
 *    non-ASCII character folds onto ASCII except U+017F ſ → `s` and U+212A
 *    K (Kelvin) → `k`. So for an ALL-ASCII stored string a needle matches iff
 *    its folded form (ASCII lower-cased, ſ → s, K → k; any other non-ASCII
 *    character → no match possible) is a substring of the lower-cased string.
 *    That is the byte-level fast path; any other stored string is tested with
 *    the real `RegExp(escaped, 'iu')`.
 */

const SYNTAX = '.*+?^${}()|[]\\';

/** The pools repository's escape (pools.repository.ts `buildPoolsFilter`). */
export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type NeedleResult = { needle: string } | { unsupported: string };

/**
 * The literal a cast `$regex` stands for, or why the engine must not answer
 * it. Only the repository's own shape is accepted: a RegExp with flags
 * exactly `i` whose source is an escaped literal (round-trip checked).
 */
export function literalFromRegExp(re: unknown): NeedleResult {
  if (!(re instanceof RegExp)) return { unsupported: 'regex_type' };
  if (re.flags !== 'i') return { unsupported: 'regex_flags' };
  const source = re.source;
  let needle = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c !== '\\') {
      if (SYNTAX.includes(c)) return { unsupported: 'regex_not_literal' };
      needle += c;
      continue;
    }
    const next = source[++i];
    if (next === undefined) return { unsupported: 'regex_not_literal' };
    if (SYNTAX.includes(next) || next === '/') needle += next;
    else if (next === 'n') needle += '\n';
    else if (next === 'r') needle += '\r';
    else if (next === 'u' && (source.startsWith('2028', i + 1) || source.startsWith('2029', i + 1))) {
      // JavaScript's own escape of a line terminator (refused below: PCRE2 rejects `\u`).
      needle += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16));
      i += 4;
    } else return { unsupported: 'regex_not_literal' };
  }
  if (new RegExp(escapeRegexLiteral(needle), 'i').source !== source) return { unsupported: 'regex_round_trip' };
  if (needle.includes('\0')) return { unsupported: 'regex_nul' };
  // JavaScript sends U+2028 / U+2029 as `\u2028` / `\u2029`, which PCRE2 rejects (51091):
  // the Mongo path errors, so this one must not answer.
  if (needle.includes('\u2028') || needle.includes('\u2029')) return { unsupported: 'regex_pcre_escape' };
  if (hasLoneSurrogate(needle)) return { unsupported: 'regex_surrogate' };
  return { needle };
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = value.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * The needle folded for all-ASCII haystacks, as bytes: ASCII lower-cased,
 * U+017F → `s`, U+212A → `k`. Null when no all-ASCII string can contain it
 * (any other non-ASCII character).
 */
export function foldNeedleAscii(needle: string): Uint8Array | null {
  const out = new Uint8Array(needle.length);
  for (let i = 0; i < needle.length; i++) {
    const c = needle.charCodeAt(i);
    if (c < 0x80) out[i] = c >= 0x41 && c <= 0x5a ? c | 0x20 : c;
    else if (c === 0x017f) out[i] = 0x73;
    else if (c === 0x212a) out[i] = 0x6b;
    else return null;
  }
  return out;
}

/** Is `bytes[start, end)` all ASCII? */
export function isAsciiRange(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (bytes[i] >= 0x80) return false;
  return true;
}

/** Does the ASCII range `bytes[start, end)`, lower-cased, contain `folded`? */
export function asciiContainsFolded(bytes: Uint8Array, start: number, end: number, folded: Uint8Array): boolean {
  const m = folded.length;
  if (m === 0) return true;
  const first = folded[0];
  const last = end - m;
  outer: for (let i = start; i <= last; i++) {
    let b = bytes[i];
    if (b >= 0x41 && b <= 0x5a) b |= 0x20;
    if (b !== first) continue;
    for (let j = 1; j < m; j++) {
      let c = bytes[i + j];
      if (c >= 0x41 && c <= 0x5a) c |= 0x20;
      if (c !== folded[j]) continue outer;
    }
    return true;
  }
  return false;
}

const decoder = new TextDecoder();

/**
 * One needle's matcher over dictionary entries (UTF-8 byte ranges): the
 * ASCII fast path, else the real `iu` RegExp on the decoded string.
 */
export class NeedleMatcher {
  readonly folded: Uint8Array | null;
  readonly re: RegExp;

  constructor(readonly needle: string) {
    this.folded = foldNeedleAscii(needle);
    this.re = new RegExp(escapeRegexLiteral(needle), 'iu');
  }

  matchBytes(bytes: Uint8Array, start: number, end: number): boolean {
    if (isAsciiRange(bytes, start, end)) return this.folded !== null && asciiContainsFolded(bytes, start, end, this.folded);
    return this.re.test(decoder.decode(bytes.subarray(start, end)));
  }

  matchString(value: string): boolean {
    return this.re.test(value);
  }
}
