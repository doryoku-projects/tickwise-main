import { describe, expect, it } from 'vitest';
import { isSpamSignals, SPAM_MONGO_PREDICATE, TokensRepository } from '../src/database/token.repository.js';
import { fakeTokenFlag, parseGoplusToken } from '../src/security/goplus.service.js';
import { matches, miniModel, prng } from './support/mini-mongo.js';

/**
 * The widened spam half of the ranked-list exclusion (2026-10-06): GoPlus
 * `fake_token` joins the hard-flag rule, and token identity spam on the
 * stored symbols rides the same scan. `miniModel` runs the real filter with
 * MongoDB's semantics (`$regex` `i` = JavaScript `iu`), so the server-side
 * pre-filter and the JS rule are exercised together.
 */

const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const FAKE_USDT = '0x3173dc3af3981c6e98bb63799b9cbeb5526ff752';
const SAI = '0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359';
const CLAIM = '0x4dc3dd6e10727ede197f1acbca948b6071bbe458';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const MIXED = '0x00000000000000000000000000000000000000Ab';

async function spamOf(docs: Array<Record<string, unknown>>, chainId = 1) {
  const { model, calls } = miniModel(docs);
  const repo = new TokensRepository({ tokenModel: () => model } as never);
  return { spam: (await repo.findSpamAddresses(chainId)).sort(), calls };
}

describe('findSpamAddresses — hard flags + identity, one scan', () => {
  it('excludes hard flags, fake_token, a spoofed major and a phishing GoPlus symbol; nothing else', async () => {
    const docs = [
      { chainId: 1, address: a(1), isHoneypot: true },
      { chainId: 1, address: a(2), fakeToken: true, tokenSymbol: 'USDT' },
      { chainId: 1, address: FAKE_USDT, symbol: 'USDT' }, // GoPlus never scanned it: identity alone
      { chainId: 1, address: a(3), tokenSymbol: 'Visit usdt-claim.pro to claim' },
      { chainId: 1, address: MIXED, symbol: ' weth ' }, // stored mixed-case: served lowercased
      // Not spam:
      { chainId: 1, address: USDT, symbol: 'USDT', tokenSymbol: 'USDT' }, // the canonical contract
      { chainId: 1, address: SAI, symbol: 'DAI' }, // allowlisted (reports "DAI")
      { chainId: 1, address: CLAIM, symbol: 'CLAIM' }, // bare word
      { chainId: 1, address: a(5), symbol: 'LEMON.FUN', isHoneypot: false, fakeToken: false },
      // An identity candidate the JS rule exempts, with a hand-edited string flag:
      // `{isHoneypot: true}` never matched it, so it must not count here either.
      { chainId: 1, address: USDT, symbol: 'usdt', isHoneypot: 'true' },
      // Another chain's row in the same collection (the filter leads with chainId).
      { chainId: 42161, address: a(6), isHoneypot: true },
    ];
    const { spam, calls } = await spamOf(docs);
    expect(spam).toEqual([a(1), a(2), a(3), MIXED.toLowerCase(), FAKE_USDT].sort());
    expect(calls).toHaveLength(1); // ONE scan, as before
    expect(calls[0]!.filter.chainId).toBe(1);
  });

  it('a row with no address is skipped, not thrown on', async () => {
    const { spam } = await spamOf([{ chainId: 1, isHoneypot: true }, { chainId: 1, address: a(7), fakeToken: true }]);
    expect(spam).toEqual([a(7)]);
  });

  it('Robinhood: a symbol with no canonical deployment there (DAI) is a spoof at any address', async () => {
    const { spam } = await spamOf([{ chainId: 4663, address: a(8), symbol: 'DAI' }], 4663);
    expect(spam).toEqual([a(8)]);
  });
});

describe('isSpamSignals ≡ SPAM_MONGO_PREDICATE', () => {
  it('agree on 2,000 random signal docs (booleans, absent, garbage)', () => {
    const rnd = prng(31);
    const values = [true, false, undefined, 'true', 1, null];
    const fields = SPAM_MONGO_PREDICATE.$or.map((clause) => Object.keys(clause)[0]!);
    expect(fields.sort()).toEqual(['cannotSellAll', 'fakeToken', 'isBlacklisted', 'isHoneypot', 'personalSlippageModifiable']);
    for (let i = 0; i < 2000; i++) {
      const doc: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[Math.floor(rnd() * values.length)];
        if (v !== undefined) doc[f] = v;
      }
      const booleanOnly = fields.every((f) => doc[f] === undefined || typeof doc[f] === 'boolean');
      // The two agree on what the sweep writes (booleans); garbage is the scan's job (`=== true`).
      if (booleanOnly) expect(isSpamSignals(doc), JSON.stringify(doc)).toBe(matches(doc, SPAM_MONGO_PREDICATE, false));
    }
  });
});

describe('GoPlus fake_token', () => {
  it('is an object whose value is 1 (number or string)', () => {
    expect(fakeTokenFlag({ true_token_address: USDT, value: 1 })).toBe(true);
    expect(fakeTokenFlag({ true_token_address: USDT, value: '1' })).toBe(true);
    expect(fakeTokenFlag({ true_token_address: USDT, value: 0 })).toBe(false);
    expect(fakeTokenFlag({ value: 2 })).toBe(false);
    expect(fakeTokenFlag(null)).toBe(false);
    expect(fakeTokenFlag(undefined)).toBe(false);
    expect(fakeTokenFlag('1')).toBe(false);
  });

  it('parseGoplusToken stores it beside the four hard flags (the live fake-USDT answer)', () => {
    // GET api.gopluslabs.io/api/v1/token_security/1?contract_addresses=0x3173…f752 (2026-10-06)
    const live = {
      fake_token: { true_token_address: USDT, value: 1 },
      token_symbol: 'USDT',
      token_name: 'usdt',
      is_honeypot: null,
      cannot_sell_all: '0',
      is_blacklisted: null,
      personal_slippage_modifiable: null,
      holder_count: '4',
    };
    const record = parseGoplusToken(1, FAKE_USDT, live);
    expect(record).toMatchObject({ fakeToken: true, isHoneypot: false, cannotSellAll: false, tokenSymbol: 'USDT', holderCount: 4 });
    expect(isSpamSignals(record)).toBe(true);
    expect(parseGoplusToken(1, USDT, { token_symbol: 'USDT' }).fakeToken).toBe(false);
    expect(parseGoplusToken(1, USDT, undefined)).toEqual({ chainId: 1, address: USDT });
  });
});
