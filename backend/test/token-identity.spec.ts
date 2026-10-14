import { describe, expect, it } from 'vitest';
import { isPhishingSymbol, isSymbolSpoof, PROTECTED_MAJOR_ADDRESSES, ZERO_ADDRESS } from '../src/config/chains.config.js';
import { isAllowlisted } from '../src/pricing/token-allowlist.js';
import {
  exclusionSetOf,
  identitySpamReason,
  identitySymbolPrefilter,
  rowRisk,
} from '../src/security/token-identity.js';
import { mongoRegexTest } from './support/mini-mongo.js';

/**
 * Token identity spam (2026-10-06). The phishing corpus is the live indexer's
 * own symbols (the live indexer, 2026-10-06): every symbol there carrying a URL, a
 * host path or "visit", and the launchpad / memecoin tickers that must NOT
 * count (domain-style branding, bare CLAIM / AIRDROP / HTTPS / WWW).
 */
const PHISHING = [
  'Visit usualget.pro to claim', // 42161 0x9ca4…14b6, GoPlus "$USUAL", 16 holders
  'Visit Aerocoin.xyz swap',
  'Visit Aerocoin.xyz swap USDC',
  'https://t.me/eth_launchpad_tokens',
  't.me/eth_launchpad_tokens',
  'https://x.com/RHdotfun',
  'https://party-final.vercel.app',
  'HTTPS://TACET.FA',
  'discord.gg/bankr',
  'LIONhttps://i.postimg.cc/dtFWhbjy/996bae4c3669ec630d94e2a94d5c76c8-v2l.webp',
  'www.claim-rewards.io',
];
const NOT_PHISHING = [
  'CLAIM', 'CLAIMIT', 'Claimed', 'CANT CLAIM', 'AIRDROP', 'Where is the airdrop?', 'WENAIRDROP',
  'HTTPS', 'https', 'HTTPSFUN', '//HTTPS', 'WWW', 'www', 'wwwGROKme', 'VISITOR', 'delegation visiting China',
  'LEMON.FUN', 'Pump.fun', 'si.gov', 'memecoin.ai', 'Sushi.com', 'RWA.xyz', 'grok.me', 'GROK.ME 4.5', 'SY SolvBTC.BERA',
  'MR.bad GUY', 'USDC.e', 'WETH.e', 'BTC.b', 'USD₮0', '𝕏Life', 'NVIDIAINTELGOOGLEGMEAPPLE', 'Titties', '',
];

const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const FAKE_USDT = '0x3173dc3af3981c6e98bb63799b9cbeb5526ff752'; // GoPlus fake_token → Tether, 4 holders
const SAI = '0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359'; // reports "DAI", allowlisted
const UNLISTED = '0x4dc3dd6e10727ede197f1acbca948b6071bbe458'; // the chain-1 "CLAIM" token, not allowlisted
const USDT0_42161 = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const URL_TOKEN_42161 = '0x9ca4254d31c23bb62edabad98c256f59966214b6';

describe('isPhishingSymbol', () => {
  it.each(PHISHING)('flags %j', (symbol) => expect(isPhishingSymbol(symbol)).toBe(true));
  it.each(NOT_PHISHING)('leaves %j alone', (symbol) => expect(isPhishingSymbol(symbol)).toBe(false));
  it('reads strings only', () => {
    expect(isPhishingSymbol(undefined)).toBe(false);
    expect(isPhishingSymbol(null)).toBe(false);
    expect(isPhishingSymbol(42 as never)).toBe(false);
  });
});

describe('identitySpamReason', () => {
  it('a major symbol at a non-canonical address is a spoof; the canonical contract is not', () => {
    expect(identitySpamReason(1, FAKE_USDT, ['USDT'])).toBe('symbol-spoof');
    expect(identitySpamReason(1, FAKE_USDT.toUpperCase().replace('0X', '0x'), [' usdt '])).toBe('symbol-spoof');
    expect(identitySpamReason(1, USDT, ['USDT'])).toBeUndefined();
  });

  it('exempts allowlisted tokens (SAI reports "DAI") and config anchors, like GoPlus', () => {
    expect(isSymbolSpoof(1, 'DAI', SAI)).toBe(true); // the pricing-side map alone would flag it
    expect(identitySpamReason(1, SAI, ['DAI'])).toBeUndefined();
    expect(identitySpamReason(1, USDT, ['Visit usdt.pro to claim'])).toBeUndefined();
    // Native ETH is an anchor but no contract, so never on the allowlist: the anchor half is load-bearing.
    expect(isAllowlisted(1, ZERO_ADDRESS)).toBe(false);
    expect(identitySpamReason(1, ZERO_ADDRESS, ['Visit eth.pro'])).toBeUndefined();
  });

  it('a phishing symbol is spam on any chain; a spoof wins over it', () => {
    expect(identitySpamReason(42161, URL_TOKEN_42161, ['Visit usualget.pro to claim'])).toBe('phishing-symbol');
    expect(identitySpamReason(1, UNLISTED, ['CLAIM'])).toBeUndefined(); // bare word: not caught (weak evidence)
    expect(identitySpamReason(1, UNLISTED, ['https://t.me/x', 'USDT'])).toBe('symbol-spoof');
  });

  it("protects Arbitrum's rebranded USD₮0 under both spellings", () => {
    expect(identitySpamReason(42161, USDT0_42161, ['USD₮0'])).toBeUndefined();
    expect(identitySpamReason(42161, URL_TOKEN_42161, ['USD₮0'])).toBe('symbol-spoof');
    expect(identitySpamReason(42161, URL_TOKEN_42161, ['usdt'])).toBe('symbol-spoof');
  });

  it('ignores non-string symbols and a missing address', () => {
    expect(identitySpamReason(1, FAKE_USDT, [undefined, null, 7, ''])).toBeUndefined();
    expect(identitySpamReason(1, undefined, ['USDT'])).toBeUndefined();
    expect(identitySpamReason(1, '', ['USDT'])).toBeUndefined();
  });

  it('a chain with no protected map still has the phishing rule', () => {
    expect(PROTECTED_MAJOR_ADDRESSES[999_999]).toBeUndefined();
    expect(identitySpamReason(999_999, FAKE_USDT, ['USDT'])).toBeUndefined();
  });
});

describe('identitySymbolPrefilter (the server-side superset)', () => {
  const chains = Object.keys(PROTECTED_MAJOR_ADDRESSES).map(Number);

  it('is a valid MongoDB regex (no \\u escape PCRE2 rejects) on every chain', () => {
    for (const chainId of [...chains, 999_999]) {
      const re = identitySymbolPrefilter(chainId);
      expect(() => mongoRegexTest(re, 'x')).not.toThrow();
      expect(re.flags).toBe('i');
    }
  });

  it('matches every symbol the JS rule flags (MongoDB `i` = JavaScript `iu`)', () => {
    const symbols = [...PHISHING, ...NOT_PHISHING];
    for (const chainId of chains) {
      for (const key of Object.keys(PROTECTED_MAJOR_ADDRESSES[chainId]!)) {
        symbols.push(key, key.toLowerCase(), ` ${key}\t`, ` ${key}﻿`, `${key}　`);
      }
    }
    const re = identitySymbolPrefilter(1);
    expect(identitySymbolPrefilter(1)).toBe(re); // cached per chain
    for (const chainId of chains) {
      const pattern = identitySymbolPrefilter(chainId);
      for (const symbol of symbols) {
        if (identitySpamReason(chainId, UNLISTED, [symbol]) === undefined) continue;
        expect(mongoRegexTest(pattern, symbol), `${chainId} ${JSON.stringify(symbol)}`).toBe(true);
      }
    }
  });

  it('stays narrow: ordinary tickers are not candidates', () => {
    const re = identitySymbolPrefilter(1);
    for (const symbol of ['PEPE', 'USDCX', 'aUSDC', 'stETH2', 'NVDA', 'LEMON.FUN', 'CLAIM']) {
      expect(mongoRegexTest(re, symbol), symbol).toBe(false);
    }
  });
});

describe('rowRisk', () => {
  it('is undefined when nothing applies', () => {
    expect(rowRisk(1, [{ address: USDT, symbol: 'USDT' }, { address: SAI, symbol: 'DAI' }], undefined, false)).toBeUndefined();
  });

  it('flags in a fixed order, de-duplicated across legs', () => {
    const excluded = exclusionSetOf([UNLISTED]);
    const risk = rowRisk(
      1,
      [
        { address: FAKE_USDT, symbol: 'USDT' },
        { address: UNLISTED.toUpperCase().replace('0X', '0x'), symbol: 'https://t.me/x' },
      ],
      excluded,
      true,
    );
    expect(risk).toEqual({ flags: ['symbol-spoof', 'phishing-symbol', 'excluded-token', 'risky-pool'] });
    expect(rowRisk(1, [{ address: FAKE_USDT, symbol: 'USDT' }, { address: FAKE_USDT, symbol: 'usdt' }], undefined, false)).toEqual({
      flags: ['symbol-spoof'],
    });
  });

  it('tolerates missing legs and addresses', () => {
    expect(rowRisk(1, [null, undefined, { symbol: 'USDT' }], undefined, true)).toEqual({ flags: ['risky-pool'] });
  });
});

describe('exclusionSetOf', () => {
  it('builds one lower-cased Set per published list object', () => {
    const list = ['0xAbC'];
    const set = exclusionSetOf(list);
    expect(set?.has('0xabc')).toBe(true);
    expect(exclusionSetOf(list)).toBe(set);
    expect(exclusionSetOf(['0xAbC'])).not.toBe(set);
    expect(exclusionSetOf([])).toBeUndefined();
    expect(exclusionSetOf(undefined)).toBeUndefined();
  });
});
