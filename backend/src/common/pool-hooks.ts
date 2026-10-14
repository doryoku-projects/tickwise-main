// A v4 pool's HOOK, in ONE place: the indexer's `Pool.hooks` normalised, and the
// permission bits a hook address encodes, decoded.
//
// v4 has no registry of hook permissions. `Hooks.sol` (v4-core) reads them off
// the LOW 14 BITS OF THE HOOK'S OWN ADDRESS: the hook was deployed (CREATE2,
// address mined) to an address whose low bits are exactly the callbacks it
// implements, and `PoolManager.initialize` rejects a hook whose address and
// code disagree. So the permissions can be read from the address alone, with no
// call and no ABI — which is what makes a pure decode here sound.
//
// What the badge needs from them is ONE question: can the hook take or redirect
// value that the PoolManager's own events do not show? Four bits answer yes —
// the `*_RETURNS_DELTA` flags let a hook return a currency delta that the
// PoolManager applies on the hook's behalf:
//   - BEFORE_SWAP_RETURNS_DELTA     the hook changes the swap's specified amount
//     (it can swap against its own liquidity, or skim part of the input);
//   - AFTER_SWAP_RETURNS_DELTA      the hook takes a share of the unspecified
//     amount (the output, or the input of an exact-out swap);
//   - AFTER_ADD_LIQUIDITY_RETURNS_DELTA / AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA
//     the hook takes a share of what an LP pays in, or receives on a remove
//     (and a remove or a zero-delta modify is how fees are collected).
// WHAT THE EVENTS DO AND DO NOT SHOW. PoolManager emits `Swap` with the POOL's
// own delta, BEFORE `afterSwap` runs ("event is emitted before the afterSwap call
// to ensure events are always emitted in order", v4-core `PoolManager._swap`), and
// `ModifyLiquidity` with the liquidity delta, not the caller's settled delta. So a
// pool's TVL, volume and LP fees, summed from those events, are what actually
// moved through its liquidity, and a hook that skims value does NOT make them
// wrong. What it does is move value outside them: the hook's cut (a share of the
// swap output or of what an LP pays in or receives on a remove) is in no
// PoolManager event, so (a) the hook's own fee is in no figure here, and (b) a
// POSITION's deposited / withdrawn / collected amounts, which are derived from
// those events, can exceed what its owner actually paid or received.
// `customAccounting` flags exactly that. It does not say the hook is malicious,
// and a hook WITHOUT those bits can still charge a dynamic fee or hold liquidity
// of its own.
//
// Pinned against v4-core `src/libraries/Hooks.sol` (`ALL_HOOK_MASK = (1 << 14)
// - 1` and the fourteen `*_FLAG = 1 << n` constants) by `pool-hooks.spec.ts`.

/** The 14 permission flags, by name — the bit each occupies in the hook address. */
export const HOOK_FLAGS = {
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnsDelta: 1 << 3,
  afterSwapReturnsDelta: 1 << 2,
  afterAddLiquidityReturnsDelta: 1 << 1,
  afterRemoveLiquidityReturnsDelta: 1 << 0,
} as const;

export type HookFlagName = keyof typeof HOOK_FLAGS;

/** `ALL_HOOK_MASK`: the low 14 bits of the address. */
export const ALL_HOOK_MASK = (1 << 14) - 1;

/** The four flags that let a hook take or redirect value the PoolManager's events do not show. */
export const CUSTOM_ACCOUNTING_MASK =
  HOOK_FLAGS.beforeSwapReturnsDelta |
  HOOK_FLAGS.afterSwapReturnsDelta |
  HOOK_FLAGS.afterAddLiquidityReturnsDelta |
  HOOK_FLAGS.afterRemoveLiquidityReturnsDelta;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The indexer's `Pool.hooks` as stored on a pool: lower-cased, and absent
 * (`undefined`) for no hook — the zero address (v4's "no hook"), an empty or
 * missing value, or anything that is not a 20-byte hex address. The indexer
 * writes mixed-case EIP-55; every other address here is lower-case.
 */
export function normalizeHooks(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!ADDRESS_PATTERN.test(value)) return undefined;
  const lower = value.toLowerCase();
  return lower === ZERO_ADDRESS ? undefined : lower;
}

/** The low 14 bits of a hook address (0 for no hook / an unusable value). */
export function hookPermissionBits(hooks: unknown): number {
  const address = normalizeHooks(hooks);
  if (!address) return 0;
  // The last 4 hex digits are the low 16 bits; the mask keeps 14.
  return parseInt(address.slice(-4), 16) & ALL_HOOK_MASK;
}

/** Names of the permission flags the hook address sets, in the order `HOOK_FLAGS` lists them. */
export function hookPermissions(hooks: unknown): HookFlagName[] {
  const bits = hookPermissionBits(hooks);
  return (Object.keys(HOOK_FLAGS) as HookFlagName[]).filter((name) => (bits & HOOK_FLAGS[name]) !== 0);
}

/** True when the address sets any `*_RETURNS_DELTA` flag (see the file header). False for no hook. */
export function hasCustomAccounting(hooks: unknown): boolean {
  return (hookPermissionBits(hooks) & CUSTOM_ACCOUNTING_MASK) !== 0;
}

/**
 * The additive pool / position row fields, present ONLY on a pool that has a
 * hook (a pool without one carries neither key, like `risk`): `hooks` is the
 * lower-case hook address; `customAccounting` is `hasCustomAccounting`.
 */
export function hookFields(hooks: unknown): { hooks?: string; customAccounting?: boolean } {
  const address = normalizeHooks(hooks);
  return address ? { hooks: address, customAccounting: hasCustomAccounting(address) } : {};
}
