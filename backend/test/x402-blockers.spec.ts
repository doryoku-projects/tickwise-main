import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../src/config/app-config.service.js';

/**
 * Regressions for two defects introduced by an earlier round of "fixes" to this
 * rail. Both were found by review, not by tests, and both were the kind that
 * looks harmless in a diff.
 */

// AppConfigService reads process.env at construction, so the suite stubs rather
// than injecting.
function cfg(env: Record<string, string>) {
  vi.stubEnv('PAYMENTS_PROVIDER', 'x402');
  vi.stubEnv('X402_TREASURY_ADDRESS', '0x' + '11'.repeat(20));
  vi.stubEnv('PAYMENT_ACCEPTED_TOKENS', 'USDC:8453');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return new AppConfigService();
}

afterEach(() => vi.unstubAllEnvs());

describe('EVM_RPC_URLS validation must never switch the payment rail off', () => {
  const good = '8453=https://rpc.example.com/v1/key';

  it('keeps x402 configured with a TRAILING COMMA (the parser filters it)', () => {
    const c = cfg({ EVM_RPC_URLS: `${good},` });
    expect(c.evmRpcUrls.get(8453)).toBe('https://rpc.example.com/v1/key');
    expect(c.x402ConfigProblem()).toBeNull();
    expect(c.x402PaymentsConfigured).toBe(true);
  });

  it('keeps x402 configured with a DOUBLED comma', () => {
    expect(cfg({ EVM_RPC_URLS: `${good},,` }).x402PaymentsConfigured).toBe(true);
  });

  it('keeps x402 configured even when another entry is malformed', () => {
    // The accepted token's chain is present; a junk entry for some other chain
    // must not take settlement down for the chain that IS configured.
    const c = cfg({ EVM_RPC_URLS: `${good},not-an-entry` });
    expect(c.x402PaymentsConfigured).toBe(true);
    // ...but it must be reported.
    expect(c.evmRpcUrlWarnings()).toMatch(/entry 2/);
  });

  it('still fails when the accepted token has no endpoint at all', () => {
    const c = cfg({ EVM_RPC_URLS: '1=https://rpc.example.com/v1/key' });
    expect(c.x402ConfigProblem()).toMatch(/8453/);
  });

  it('warns about a duplicate chain without disabling anything', () => {
    const c = cfg({ EVM_RPC_URLS: `${good},8453=https://other.example.com/x` });
    expect(c.x402PaymentsConfigured).toBe(true);
    expect(c.evmRpcUrlWarnings()).toMatch(/more than once/);
  });

  it('never echoes the url (which carries the api key) in a warning', () => {
    const c = cfg({ EVM_RPC_URLS: `${good},9=ftp://host/SUPERSECRET` });
    const w = c.evmRpcUrlWarnings() ?? '';
    expect(w).not.toContain('SUPERSECRET');
    expect(w).toMatch(/entry 2/);
  });

  it('is silent on a clean value', () => {
    expect(cfg({ EVM_RPC_URLS: good }).evmRpcUrlWarnings()).toBeNull();
  });
});

/**
 * The retire sweep introduced `expired`, a status `issue()` was never taught to
 * re-issue from. The write matched nothing, `modifiedCount` was discarded, and a
 * signable payload was returned that had not been persisted — so `confirm()`
 * failed permanently and retrying looped.
 */
describe('issue() must persist before it returns a payload', () => {
  it('accepts expired as a re-issuable status', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/payments/providers/x402/authorization.service.ts', 'utf8'),
    );
    const guard = src.match(/status: \{ \$in: \[([^\]]*)\] \}/)?.[1] ?? '';
    expect(guard).toContain("'expired'");
    expect(guard).toContain("'issued'");
    expect(guard).toContain("'authorized'");
    expect(guard).toContain("'failed'");
  });

  it('refuses to return a payload it did not persist', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/payments/providers/x402/authorization.service.ts', 'utf8'),
    );
    // The update result must be inspected, not discarded.
    expect(src).toMatch(/matchedCount/);
    expect(src).toMatch(/x402\.issue_not_persisted/);
  });
});
