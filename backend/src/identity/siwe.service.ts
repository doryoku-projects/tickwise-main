import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage } from 'viem';
import { AppConfigService } from '../config/app-config.service.js';

const NONCE_PREFIX = 'sso:siwe:nonce:';
/** Long enough to find the wallet popup, short enough to bound replay. */
const CHALLENGE_TTL_SEC = 5 * 60;
/** Ethereum mainnet — the message field is a binding/display value, see below. */
const DEFAULT_CHAIN_ID = 1;

/** What the client must present to the wallet, verbatim. */
export interface SiweChallenge {
  nonce: string;
  /** The EXACT string to pass to `personal_sign`. Signing anything else fails. */
  message: string;
  /** EIP-55 checksummed address the challenge was issued to. */
  address: string;
  chainId: number;
  issuedAt: string;
  expiresAt: string;
}

/** Proven wallet ownership. */
export interface SiweVerification {
  /** LOWERCASED — this is the `Identity.subject` for `provider: 'wallet'`. */
  address: string;
  /** EIP-55 checksummed, for display. */
  checksumAddress: string;
  chainId: number;
}

/** Redis-side record. `message` is the authoritative string we verify against. */
interface SiweNonceRecord {
  message: string;
  /** Lowercased address the nonce was ISSUED to. */
  address: string;
  checksumAddress: string;
  chainId: number;
  expiresAt: string;
}

/**
 * Sign-In with Ethereum (EIP-4361).
 *
 * THE DESIGN, and the reason it looks different from most SIWE integrations:
 * the SERVER composes the full message and stores it in Redis under the nonce;
 * the client signs that exact string and returns only `{ nonce, signature }`.
 * Verification recovers the signer against the STORED message.
 *
 * We therefore NEVER parse an attacker-supplied SIWE message, which removes the
 * entire class of SIWE parser-mismatch attacks: every real-world SIWE break has
 * been a disagreement between the parser and the signer about what the bytes
 * meant — a statement containing a newline that smuggles in a second `URI:`
 * line, a `domain` the parser reads differently from the wallet's display, a
 * field duplicated so the checker validates the first copy while the victim read
 * the second. None of that reaches us: there is exactly one message string, we
 * wrote it, and the client cannot influence it after issue.
 *
 * A future refactor that starts accepting a client-supplied `message` (because
 * "the siwe library does it that way") reopens all of it. Don't.
 */
@Injectable()
export class SiweService implements OnModuleDestroy {
  private readonly logger = new Logger(SiweService.name);
  private readonly redis: Redis;

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {
    // Same client pattern as MeteringService — lazyConnect so an unused feature
    // never opens a socket.
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.redis.on('error', (err) => this.logger.error(`SIWE Redis error: ${err.message}`));
  }

  onModuleDestroy(): void {
    void this.redis.quit().catch(() => undefined);
  }

  isEnabled(): boolean {
    return this.config.walletLoginEnabled;
  }

  /**
   * Issue a nonce bound to ONE address, and the exact message to sign. The
   * address binding is load-bearing: without it anyone holding a live nonce
   * could complete the challenge with their own key (`verify` only ever learns
   * the nonce), so a nonce is a challenge for that wallet and nobody else.
   */
  async createChallenge(args: { address: string; chainId?: number }): Promise<SiweChallenge> {
    this.assertEnabled();

    const raw = typeof args.address === 'string' ? args.address.trim() : '';
    if (!isAddress(raw)) {
      throw new BadRequestException('A valid wallet address is required');
    }
    const checksumAddress = getAddress(raw);
    const chainId = normalizeChainId(args.chainId);

    // EIP-4361's nonce grammar is alphanumeric only, so hex — NOT base64url,
    // whose `-`/`_` would produce a message that a strict wallet may reject.
    const nonce = randomBytes(16).toString('hex');

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_SEC * 1000);
    const message = buildSiweMessage({
      domain: this.config.siweDomain,
      address: checksumAddress,
      statement: this.config.siweStatement,
      uri: this.config.portalBaseUrl,
      chainId,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expiresAt.toISOString(),
    });

    const record: SiweNonceRecord = {
      message,
      address: checksumAddress.toLowerCase(),
      checksumAddress,
      chainId,
      expiresAt: expiresAt.toISOString(),
    };
    // TTL is the primary single-use bound; `verify` deletes on first read.
    await this.redis.set(`${NONCE_PREFIX}${nonce}`, JSON.stringify(record), 'EX', CHALLENGE_TTL_SEC);

    return {
      nonce,
      message,
      address: checksumAddress,
      chainId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Verify a signature against the STORED message for `nonce`.
   *
   * The nonce is consumed BEFORE the signature is checked — deliberately. A
   * failed attempt burns the challenge, so one nonce can't be used to grind
   * candidate signatures, and a replay of a valid signature finds nothing to
   * replay it against.
   */
  async verify(args: { nonce: string; signature: string }): Promise<SiweVerification> {
    this.assertEnabled();

    const nonce = typeof args.nonce === 'string' ? args.nonce.trim() : '';
    if (!/^[a-f0-9]{16,64}$/i.test(nonce)) {
      throw new UnauthorizedException('Sign-in request expired or already used');
    }
    const signature = typeof args.signature === 'string' ? args.signature.trim() : '';
    // Shape only — the value itself is never logged (rule: no signatures in logs).
    if (!/^0x[0-9a-fA-F]{2,520}$/.test(signature)) {
      throw new BadRequestException('A valid signature is required');
    }

    const record = await this.consumeNonce(nonce);
    if (!record) {
      throw new UnauthorizedException('Sign-in request expired or already used');
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new UnauthorizedException('Sign-in request expired or already used');
    }

    let valid = false;
    try {
      valid = await verifyMessage({
        // The address the nonce was ISSUED to, not one supplied by the caller.
        address: record.checksumAddress as `0x${string}`,
        message: record.message,
        signature: signature as `0x${string}`,
      });
    } catch (error) {
      // Malformed signature bytes throw rather than return false.
      this.logger.warn(`SIWE signature could not be recovered: ${(error as Error).message}`);
      valid = false;
    }
    if (!valid) {
      throw new UnauthorizedException('Signature does not match the requested wallet address');
    }

    return {
      address: record.address,
      checksumAddress: record.checksumAddress,
      chainId: record.chainId,
    };
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new ForbiddenException('Wallet sign-in is not enabled');
    }
  }

  /** Atomic single-use read, same reasoning as `OauthStateService.take`. */
  private async consumeNonce(nonce: string): Promise<SiweNonceRecord | null> {
    const key = `${NONCE_PREFIX}${nonce}`;
    let raw: string | null;
    try {
      raw = await this.redis.getdel(key);
    } catch (error) {
      // GETDEL needs Redis ≥ 6.2; MULTI is still atomic (GET-then-DEL is not).
      this.logger.warn(`GETDEL unavailable (${(error as Error).message}) — falling back to MULTI`);
      const results = await this.redis.multi().get(key).del(key).exec();
      const first = results?.[0];
      raw = !first || first[0] ? null : typeof first[1] === 'string' ? first[1] : null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SiweNonceRecord;
      if (typeof parsed?.message !== 'string' || typeof parsed?.checksumAddress !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

/** SIWE chainId is a binding/display field (personal_sign is chain-agnostic). */
function normalizeChainId(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > 2 ** 31) {
    return DEFAULT_CHAIN_ID;
  }
  return raw;
}

/**
 * Compose an EIP-4361 message. Field order and blank lines are part of the
 * spec — wallets render it, and a strict verifier reads it — so this layout is
 * not cosmetic.
 *
 * `domain` is `host[:port]` with NO scheme (`AppConfigService.siweDomain`
 * guarantees that, and prod refuses a localhost value): it is the binding that
 * stops a signature collected by another site being replayed here.
 */
export function buildSiweMessage(args: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}): string {
  // A newline in the statement would let an operator-configured string forge
  // extra header lines; collapse all whitespace to keep the grammar intact.
  const statement = args.statement.replace(/\s+/g, ' ').trim();
  return [
    `${args.domain} wants you to sign in with your Ethereum account:`,
    args.address,
    '',
    statement,
    '',
    `URI: ${args.uri}`,
    'Version: 1',
    `Chain ID: ${args.chainId}`,
    `Nonce: ${args.nonce}`,
    `Issued At: ${args.issuedAt}`,
    `Expiration Time: ${args.expirationTime}`,
  ].join('\n');
}
