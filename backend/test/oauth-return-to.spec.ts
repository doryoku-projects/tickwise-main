import { describe, expect, it } from 'vitest';
import { sanitizeReturnTo } from '../src/identity/oauth-state.service.js';

/**
 * `returnTo` is echoed into the `Location` of the post-login redirect, so
 * anything that escapes this function is an open redirect that carries a freshly
 * minted session with it.
 *
 * The subtle case, and the one an adversarial review actually found: the URL
 * parser SILENTLY STRIPS C0 control characters. A raw TAB therefore walks past
 * both the `//` prefix check and the backslash check as `/<TAB>/evil.com`, and
 * only becomes `//evil.com` — protocol-relative, i.e. off-origin — once parsed.
 * So the guard is the whole U+0000-U+001F range plus DEL, rather than a list of
 * the ones we happened to think of.
 */
describe('sanitizeReturnTo', () => {
  it('accepts ordinary relative paths, including hyphens and query strings', () => {
    expect(sanitizeReturnTo('/portal')).toBe('/portal');
    // A hyphen must survive: an over-broad control-character class that also
    // matched `-` would silently break every real path like this one.
    expect(sanitizeReturnTo('/portal/api-keys')).toBe('/portal/api-keys');
    expect(sanitizeReturnTo('/portal/usage?period=2026-07')).toBe('/portal/usage?period=2026-07');
  });

  it.each([
    ['tab', '/\tevil.com'],
    ['carriage return', '/\revil.com'],
    ['line feed', '/\nevil.com'],
    ['NUL', '/\u0000evil.com'],
    ['unit separator', '/\u001Fevil.com'],
    ['DEL', '/\u007Fevil.com'],
  ])('rejects a path smuggling an authority past the parser via %s', (_label, value) => {
    expect(sanitizeReturnTo(value)).toBeUndefined();
  });

  /**
   * The WHOLE rejected range, built with `String.fromCharCode` rather than
   * written as literals.
   *
   * Two reasons, and the second is not theoretical: a literal control character
   * is invisible in a diff, and a tool boundary that decodes `\uXXXX` into a REAL
   * byte on write has already turned one of these cases into an ordinary path the
   * guard correctly allows — i.e. a test that passed while testing nothing.
   * Generating the codepoint leaves nothing to mangle.
   */
  it('rejects every C0 control character and DEL, one codepoint at a time', () => {
    const rejected = [...Array.from({ length: 0x20 }, (_unused, code) => code), 0x7f];

    for (const code of rejected) {
      const smuggled = `/${String.fromCharCode(code)}/evil.example`;
      expect(sanitizeReturnTo(smuggled)).toBeUndefined();
    }
    // Positive control, so the sweep above cannot pass by rejecting everything:
    // the character just past the range is ordinary and must survive.
    expect(sanitizeReturnTo(`/${String.fromCharCode(0x20 + 1)}/ok`)).toBe('/!/ok');
  });

  it.each([
    ['leading', '/\\evil.example'],
    ['mid-path', '/portal\\evil.example'],
    ['after a segment', '/portal/\\evil.example'],
    ['trailing', '/portal/usage\\'],
    ['doubled', '/\\\\evil.example'],
    ['inside a query string', '/portal?next=\\evil.example'],
  ])('rejects a backslash in ANY position (%s)', (_label, value) => {
    // The check is `includes('\\')`, not a prefix test, and it has to stay that
    // way: browsers normalise a backslash to `/`, so any position can compose an
    // authority once the rest of the string cooperates.
    expect(sanitizeReturnTo(value)).toBeUndefined();
  });

  it('accepts exactly 512 characters and rejects 513', () => {
    // The cap is a memory/log-size bound rather than a security boundary, but an
    // off-by-one here is the kind of thing that only ever shows up as a
    // mysteriously dropped destination, so the boundary is pinned on both sides.
    const at = `/${'a'.repeat(511)}`;
    const over = `/${'a'.repeat(512)}`;

    expect(at).toHaveLength(512);
    expect(over).toHaveLength(513);
    expect(sanitizeReturnTo(at)).toBe(at);
    expect(sanitizeReturnTo(over)).toBeUndefined();
  });

  it('measures the length AFTER trimming, so surrounding space is not fatal', () => {
    const padded = `  /${'a'.repeat(511)}  `;

    expect(sanitizeReturnTo(padded)).toBe(`/${'a'.repeat(511)}`);
  });

  it.each([
    ['protocol-relative', '//evil.com'],
    ['backslash', '/\\evil.com'],
    ['absolute http', 'http://evil.com'],
    ['absolute https', 'https://evil.com'],
    ['javascript URI', 'javascript:alert(1)'],
    ['not rooted', 'portal'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeReturnTo(value)).toBeUndefined();
  });

  it('rejects non-strings and over-long values rather than coercing them', () => {
    expect(sanitizeReturnTo(undefined)).toBeUndefined();
    expect(sanitizeReturnTo(null)).toBeUndefined();
    expect(sanitizeReturnTo(`/${'a'.repeat(600)}`)).toBeUndefined();
  });
});
