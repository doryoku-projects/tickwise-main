import { describe, expect, it } from 'vitest';
import {
  ALL_HOOK_MASK,
  CUSTOM_ACCOUNTING_MASK,
  HOOK_FLAGS,
  hasCustomAccounting,
  hookFields,
  hookPermissionBits,
  hookPermissions,
  normalizeHooks,
} from '../src/common/pool-hooks.js';

/**
 * The v4 hook address decode (`common/pool-hooks.ts`): which of a hook's 14
 * permission flags its ADDRESS sets, and the one question the badge asks of
 * them — can the hook take or redirect value the PoolManager's events do not
 * show (`customAccounting`).
 *
 * The flag values are pinned to v4-core `src/libraries/Hooks.sol` as it reads
 * on main (verified 2026-10-06):
 *   ALL_HOOK_MASK = uint160((1 << 14) - 1)
 *   BEFORE_INITIALIZE_FLAG 1<<13, AFTER_INITIALIZE 1<<12, BEFORE_ADD_LIQUIDITY 1<<11,
 *   AFTER_ADD_LIQUIDITY 1<<10, BEFORE_REMOVE_LIQUIDITY 1<<9, AFTER_REMOVE_LIQUIDITY 1<<8,
 *   BEFORE_SWAP 1<<7, AFTER_SWAP 1<<6, BEFORE_DONATE 1<<5, AFTER_DONATE 1<<4,
 *   BEFORE_SWAP_RETURNS_DELTA 1<<3, AFTER_SWAP_RETURNS_DELTA 1<<2,
 *   AFTER_ADD_LIQUIDITY_RETURNS_DELTA 1<<1, AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA 1<<0
 * The numbers below are written out literally so a changed constant in the
 * helper cannot move its own expectation.
 */

// Real hooks on the live indexer (checksummed as it reports them).
const ANGSTROM = '0x0000000aa232009084Bd71A5797d089AA4Edfad4'; // low 14 bits 0x3ad4
const ZERO = '0x0000000000000000000000000000000000000000';

describe('HOOK_FLAGS', () => {
  it('are the fourteen v4-core permission bits, by name', () => {
    expect(HOOK_FLAGS).toEqual({
      beforeInitialize: 0x2000,
      afterInitialize: 0x1000,
      beforeAddLiquidity: 0x0800,
      afterAddLiquidity: 0x0400,
      beforeRemoveLiquidity: 0x0200,
      afterRemoveLiquidity: 0x0100,
      beforeSwap: 0x0080,
      afterSwap: 0x0040,
      beforeDonate: 0x0020,
      afterDonate: 0x0010,
      beforeSwapReturnsDelta: 0x0008,
      afterSwapReturnsDelta: 0x0004,
      afterAddLiquidityReturnsDelta: 0x0002,
      afterRemoveLiquidityReturnsDelta: 0x0001,
    });
    expect(ALL_HOOK_MASK).toBe(0x3fff);
  });

  it('the custom-accounting mask is exactly the four *_RETURNS_DELTA bits', () => {
    expect(CUSTOM_ACCOUNTING_MASK).toBe(0x000f);
  });
});

describe('normalizeHooks', () => {
  it('lower-cases a checksummed address', () => {
    expect(normalizeHooks(ANGSTROM)).toBe('0x0000000aa232009084bd71a5797d089aa4edfad4');
  });

  it('treats the zero address, empty, missing and non-address values as no hook', () => {
    for (const value of [ZERO, '', '   ', null, undefined, 0, {}, '0x', '0x1234', `${ANGSTROM}00`, ANGSTROM.slice(2), `0x${'g'.repeat(40)}`]) {
      expect(normalizeHooks(value)).toBeUndefined();
    }
  });

  it('trims whitespace and accepts an already lower-case address', () => {
    expect(normalizeHooks(`  ${ANGSTROM.toLowerCase()}\n`)).toBe(ANGSTROM.toLowerCase());
  });
});

describe('hookPermissionBits / hookPermissions', () => {
  it('reads the low 14 bits of the address (Angstrom: 0x...fad4 → 0x3ad4)', () => {
    expect(hookPermissionBits(ANGSTROM)).toBe(0x3ad4);
    expect(hookPermissions(ANGSTROM)).toEqual([
      'beforeInitialize',
      'afterInitialize',
      'beforeAddLiquidity',
      'beforeRemoveLiquidity',
      'beforeSwap',
      'afterSwap',
      'afterDonate',
      'afterSwapReturnsDelta',
    ]);
  });

  it('ignores the two bits above the mask (0x...c000 sets none)', () => {
    expect(hookPermissionBits('0x000000000000000000000000000000000000c000')).toBe(0);
    expect(hookPermissions('0x000000000000000000000000000000000000c000')).toEqual([]);
  });

  it('is 0 for no hook', () => {
    expect(hookPermissionBits(ZERO)).toBe(0);
    expect(hookPermissionBits(undefined)).toBe(0);
    expect(hookPermissions(null)).toEqual([]);
  });

  it('decodes each single flag from an address that sets only it', () => {
    for (const [name, bit] of Object.entries(HOOK_FLAGS)) {
      const address = `0x00000000000000000000000000000000000${bit.toString(16).padStart(5, '0')}`;
      expect(hookPermissions(address)).toEqual([name]);
    }
  });
});

describe('hasCustomAccounting', () => {
  it('is true for each *_RETURNS_DELTA bit alone', () => {
    for (const name of ['beforeSwapReturnsDelta', 'afterSwapReturnsDelta', 'afterAddLiquidityReturnsDelta', 'afterRemoveLiquidityReturnsDelta'] as const) {
      const address = `0x00000000000000000000000000000000000${HOOK_FLAGS[name].toString(16).padStart(5, '0')}`;
      expect(hasCustomAccounting(address), name).toBe(true);
    }
  });

  it('is false for every other flag, alone and all together', () => {
    const others = Object.entries(HOOK_FLAGS).filter(([name]) => !name.endsWith('ReturnsDelta'));
    for (const [name, bit] of others) {
      expect(hasCustomAccounting(`0x00000000000000000000000000000000000${bit.toString(16).padStart(5, '0')}`), name).toBe(false);
    }
    // all ten non-delta flags: 0x3ff0
    expect(hasCustomAccounting('0x0000000000000000000000000000000000003ff0')).toBe(false);
  });

  it('reads real hooks: Angstrom can redirect value; a plain fee-hook (0xc0: beforeSwap + afterSwap) cannot', () => {
    expect(hasCustomAccounting(ANGSTROM)).toBe(true); // AFTER_SWAP_RETURNS_DELTA
    expect(hasCustomAccounting('0xcdf0049105d85b0a32d39d0ea7a99818733d80c0')).toBe(false); // 0xc0
    expect(hasCustomAccounting('0x046a23058b1e56d6aa3e9ac11565bbe8a89728cc')).toBe(true); // 0x28cc: BEFORE_/AFTER_SWAP_RETURNS_DELTA
    expect(hasCustomAccounting('0xfdf6492b6c161269714cdb48a8646b1974d10088')).toBe(true); // 0x88: BEFORE_SWAP_RETURNS_DELTA
  });

  it('is false for no hook', () => {
    expect(hasCustomAccounting(ZERO)).toBe(false);
    expect(hasCustomAccounting(undefined)).toBe(false);
    expect(hasCustomAccounting('not an address')).toBe(false);
  });
});

describe('hookFields', () => {
  it('carries neither key for a pool without a hook', () => {
    for (const value of [undefined, null, '', ZERO]) {
      const fields = hookFields(value);
      expect(fields).toEqual({});
      expect(Object.hasOwn(fields, 'hooks')).toBe(false);
      expect(Object.hasOwn(fields, 'customAccounting')).toBe(false);
    }
  });

  it('carries the lower-case address and the flag for a hooked pool', () => {
    expect(hookFields(ANGSTROM)).toEqual({ hooks: '0x0000000aa232009084bd71a5797d089aa4edfad4', customAccounting: true });
    expect(hookFields('0xCDF0049105D85B0A32D39D0EA7A99818733D80C0')).toEqual({
      hooks: '0xcdf0049105d85b0a32d39d0ea7a99818733d80c0',
      customAccounting: false,
    });
  });
});
