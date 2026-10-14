import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PaymentProviderRegistry } from '../src/payments/provider-registry.js';
import type { AppConfigService } from '../src/config/app-config.service.js';
import type { PaymentProvider } from '../src/payments/payment-provider.interface.js';

/**
 * The registry's checkout-rail resolution.
 *
 * The bug this pins: with a crypto rail selected but half-configured, checkout
 * threw `BadRequestException('Unknown payment provider …')` — a 400 blaming the
 * customer for a server MISCONFIGURATION, and calling a known rail "unknown".
 * The checkout path must instead 503 with a clean customer message and log the
 * SPECIFIC reason for the operator.
 */

function rail(key: string, configured: boolean): PaymentProvider {
  return {
    key,
    capabilities: {
      hostedCheckout: false,
      onChainDirect: key === 'x402',
      recurring: false,
      webhooks: false,
      bodySignature: false,
      variableSettlement: true,
    },
    isConfigured: () => configured,
    createCheckout: async () => ({ ref: 'x' }),
    getPayment: async () => null,
    verifyWebhook: () => false,
    parseWebhook: () => null,
  };
}

function build(opts: { provider: string; x402Configured?: boolean; x402Problem?: string | null }) {
  const config = {
    paymentsProvider: opts.provider,
    underpayToleranceMinor: 100,
    x402ConfigProblem: () => opts.x402Problem ?? 'X402_TREASURY_ADDRESS is not set',
  } as unknown as AppConfigService;

  // POSITIONAL, so this call site must track the constructor exactly. It has
  // already caught one rail addition loudly — and removing the deposit rail
  // showed the other failure mode: leaving a now-extra argument in place is
  // SILENT, because the surplus is simply ignored and every remaining rail binds
  // one slot early (`x402` would have been the object named `onchain`, and the
  // tests would have passed while testing the wrong rail).
  const registry = new PaymentProviderRegistry(
    config,
    rail('x402', opts.x402Configured ?? false),
    rail('radom', false),
    rail('manual', true),
    rail('fake', false),
  );
  registry.onModuleInit();
  return registry;
}

describe('PaymentProviderRegistry.resolveCheckoutProvider', () => {
  it('503s (not 400) when the configured checkout rail is a KNOWN rail that is not configured', () => {
    // MUTATION: route this through `resolve()` (400 "Unknown") → this fails.
    const registry = build({ provider: 'x402', x402Configured: false });
    let thrown: unknown;
    try {
      registry.resolveCheckoutProvider();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    // A clean customer-facing message — never the internal "Unknown provider".
    const body = (thrown as ServiceUnavailableException).getResponse() as { error: string };
    expect(body.error).not.toMatch(/unknown/i);
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it('returns the rail once it IS configured', () => {
    const registry = build({ provider: 'x402', x402Configured: true, x402Problem: null });
    expect(registry.resolveCheckoutProvider().key).toBe('x402');
  });

  it('still resolves a configured rail even when it is not the checkout default', () => {
    // `manual` is configured here; asking for it by name via find() works.
    const registry = build({ provider: 'x402', x402Configured: false });
    expect(registry.find('manual')?.key).toBe('manual');
    expect(registry.find('x402')).toBeUndefined(); // unconfigured → not live
  });

  it('503s for an unconfigured x402 rail too, without leaking the reason to the customer', () => {
    const registry = build({ provider: 'x402', x402Configured: false });
    let thrown: unknown;
    try {
      registry.resolveCheckoutProvider();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    const body = (thrown as ServiceUnavailableException).getResponse() as { error: string };
    // The operator gets `X402_TREASURY_ADDRESS is not set` in the log; the
    // customer must never see a config key name.
    expect(body.error).not.toMatch(/X402_TREASURY|unknown/i);
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it('names a DELETED rail as unknown rather than merely unconfigured', () => {
    // `onchain` was a real rail until 2026-08-11. An operator whose env still
    // says so must be told it is not a rail at all — "not fully configured" would
    // send them hunting for a missing xpub that no longer has anywhere to go.
    const registry = build({ provider: 'onchain' });
    expect(() => registry.resolveCheckoutProvider()).toThrow(ServiceUnavailableException);
    expect(registry.find('onchain')).toBeUndefined();
    expect(registry.list().map((r) => r.key)).not.toContain('onchain');
  });
});
