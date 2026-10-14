import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * The Dwellir outage of 2026-09-07 was a 403 whose text/plain body said exactly
 * what was wrong — "API key is disabled" — and it reached the operator as
 * `Unexpected token 'A', "API key is"...` because the client parsed before it
 * checked the status. These pin that a transport failure names the status, the
 * host and the provider's own words, and never the API key.
 */

const KEY = 'sk_super_secret_key_value';
const URL_WITH_KEY = `https://api-eth.example.com/v1/${KEY}`;

let scripted: { statusCode: number; body: string } = { statusCode: 200, body: '{}' };
let thrown: Error | null = null;

vi.mock('undici', () => ({
  request: async () => {
    if (thrown) throw thrown;
    return {
      statusCode: scripted.statusCode,
      body: {
        json: async () => JSON.parse(scripted.body),
        text: async () => scripted.body,
      },
    };
  },
}));

const { EvmRpcClient } = await import('../src/payments/providers/x402/evm-rpc.client.js');

describe('EvmRpcClient transport errors', () => {
  beforeEach(() => {
    thrown = null;
    scripted = { statusCode: 200, body: '{"jsonrpc":"2.0","id":1,"result":"0x1"}' };
  });
  afterEach(() => vi.clearAllMocks());

  it('reports a non-2xx with its status, host and the provider message', async () => {
    scripted = {
      statusCode: 403,
      body: 'API key is disabled. Please contact Dwellir at support@dwellir.com if this is unexpected.',
    };
    const c = new EvmRpcClient(1, URL_WITH_KEY);
    await expect(c.blockNumber()).rejects.toThrow(/HTTP 403/);
    await expect(c.blockNumber()).rejects.toThrow(/api-eth\.example\.com/);
    await expect(c.blockNumber()).rejects.toThrow(/API key is disabled/);
  });

  it('NEVER leaks the api key into the error', async () => {
    scripted = { statusCode: 403, body: 'API key is disabled.' };
    const c = new EvmRpcClient(1, URL_WITH_KEY);
    const err = await c.blockNumber().catch((e: Error) => e);
    expect(String(err)).not.toContain(KEY);
  });

  it('names the status and host when a 200 body is not JSON', async () => {
    scripted = { statusCode: 200, body: '<html>gateway timeout</html>' };
    const c = new EvmRpcClient(1, URL_WITH_KEY);
    const err = await c.blockNumber().catch((e: Error) => e);
    expect(String(err)).toMatch(/non-JSON body/);
    expect(String(err)).toContain('api-eth.example.com');
    expect(String(err)).not.toContain(KEY);
  });

  it('attaches host, code and cause to a TLS/network failure', async () => {
    const tls = Object.assign(
      new Error('SSL routines:ssl3_read_bytes:tlsv1 alert internal error'),
      { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', cause: new Error('alert number 80') },
    );
    thrown = tls;
    const c = new EvmRpcClient(1, URL_WITH_KEY);
    const err = await c.blockNumber().catch((e: Error) => e);
    expect(String(err)).toContain('api-eth.example.com');
    expect(String(err)).toContain('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR');
    expect(String(err)).toContain('alert number 80');
    expect(String(err)).not.toContain(KEY);
  });

  it('still returns a normal result on a healthy 200', async () => {
    const c = new EvmRpcClient(1, URL_WITH_KEY);
    await expect(c.blockNumber()).resolves.toBe(1n);
  });
});
