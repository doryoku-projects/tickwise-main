import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service.js';
import type { PaymentToken } from '../../../config/payment-tokens.config.js';
import { DECIMALS_SELECTOR, EvmRpcClient, SYMBOL_SELECTOR } from './evm-rpc.client.js';

/**
 * Cross-checks every accepted token's `decimals()` — and, best-effort, its
 * `symbol()` — against the chain itself at boot.
 *
 * THIS IS WHAT LETS THE PAYMENT REGISTRY BE A SEPARATE FILE from
 * `chains.config.ts` without the addresses being a second, drifting authority.
 * The registry (and any operator-supplied `SYM:chain:addr:decimals`) is a
 * bootstrap value; the CHAIN is the source of truth. A wrong `decimals` — the
 * one field where an error is catastrophic, because it makes every payment
 * invisible or mis-sized by orders of magnitude — is caught here, loudly, at
 * boot.
 *
 * FATAL vs TOLERATED, deliberately split:
 *  - a DEFINITIVE mismatch (the contract says 6, config says 18) throws and
 *    stops the boot: shipping that is money lost on every payment.
 *  - an RPC hiccup (can't reach the node, contract has no `decimals()`) is a
 *    WARNING, not a boot failure: a transient node blip must not take the whole
 *    API down, and the watcher's own calls will surface a persistent problem.
 */
@Injectable()
export class TokenVerificationService implements OnModuleInit {
  private readonly logger = new Logger(TokenVerificationService.name);

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    // Gated on `x402PaymentsConfigured`, NOT on `paymentsProvider === 'x402'`.
    // The watcher settles real transfers whenever the rail is CONFIGURED (that
    // is what the settlement watcher and the queue's per-chain
    // repeatables key off), regardless of which rail is the checkout default —
    // e.g. Radom is the default but on-chain subscriptions are still renewing,
    // or the default was switched after on-chain checkouts existed. Gating this
    // decimals check on the DEFAULT rail left a live settlement path whose
    // amounts were never verified against the chain, which is exactly the
    // 6-vs-18 catastrophe the check exists to prevent.
    if (!this.config.x402PaymentsConfigured) return;
    await this.verify(this.config.acceptedPaymentTokens);
  }

  /** Extracted so a spec can drive it with a stub RPC. */
  async verify(tokens: PaymentToken[]): Promise<void> {
    const rpc = this.config.evmRpcUrls;
    for (const token of tokens) {
      const url = rpc.get(token.chainId);
      if (!url) {
        // `x402PaymentsConfigured` already guarantees this; belt-and-braces.
        throw new Error(`Accepted token ${token.symbol}:${token.chainId} has no EVM_RPC_URLS entry`);
      }
      const client = new EvmRpcClient(token.chainId, url);

      let onChainDecimals: number | undefined;
      try {
        const raw = await client.ethCall(token.address, DECIMALS_SELECTOR);
        onChainDecimals = Number(BigInt(raw || '0x0'));
      } catch (err) {
        // Could not reach the chain or the contract has no decimals() — tolerate.
        this.logger.warn(
          `Could not verify ${token.symbol}:${token.chainId} decimals on-chain (${(err as Error).message}); ` +
            `trusting the configured value ${token.decimals}. The watcher will surface a persistent RPC problem.`,
        );
        continue;
      }

      // A DEFINITIVE mismatch is fatal — this is the exact bug the check exists
      // to catch, and it is money on every payment.
      if (onChainDecimals !== token.decimals) {
        throw new Error(
          `Token ${token.symbol} at ${token.address} on chain ${token.chainId} has ${onChainDecimals} ` +
            `decimals on-chain but is configured as ${token.decimals}. Refusing to accept it — every ` +
            'payment would be mis-sized by orders of magnitude. Fix PAYMENT_ACCEPTED_TOKENS or the registry.',
        );
      }

      // symbol() is advisory — a mismatch is worth a warning (wrong address?)
      // but not fatal, since matching is by address, not by ticker.
      try {
        const raw = await client.ethCall(token.address, SYMBOL_SELECTOR);
        const onChainSymbol = decodeStringReturn(raw);
        if (onChainSymbol && onChainSymbol.toUpperCase() !== token.symbol.toUpperCase()) {
          this.logger.warn(
            `[alert] payments.token_symbol_mismatch configured=${token.symbol} onchain=${onChainSymbol} ` +
              `address=${token.address} chain=${token.chainId} — is the address right?`,
          );
        }
      } catch {
        /* symbol() is optional on the ERC-20 spec; silence is fine */
      }

      this.logger.log(`Verified ${token.symbol}:${token.chainId} (${token.decimals} decimals) against the chain`);
    }
  }
}

/**
 * Decode an ABI-encoded `string` return (the shape `symbol()` returns).
 *
 * Some old tokens (MKR) return a `bytes32` instead — handled by falling back to
 * trimming NULs off a raw hex decode. Best-effort: this feeds a warning, never
 * a decision.
 */
function decodeStringReturn(hex: string): string | undefined {
  const clean = hex.replace(/^0x/, '');
  if (clean.length === 0) return undefined;
  try {
    // Dynamic string: [offset(32)][length(32)][data]. Length at bytes 32..64.
    if (clean.length >= 128) {
      const len = Number(BigInt(`0x${clean.slice(64, 128)}`));
      if (len > 0 && len <= 64) {
        const data = clean.slice(128, 128 + len * 2);
        return Buffer.from(data, 'hex').toString('utf8').replace(/\0+$/, '') || undefined;
      }
    }
    // bytes32 fallback: the whole word, NUL-trimmed.
    return Buffer.from(clean.slice(0, 64), 'hex').toString('utf8').replace(/\0+$/, '') || undefined;
  } catch {
    return undefined;
  }
}
