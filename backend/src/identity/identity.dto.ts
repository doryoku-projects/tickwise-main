import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// The global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so EVERY
// property here needs a decorator or a request carrying it 400s. The pipe is
// also inert under `tsx` dev (esbuild drops the decorator metadata), so nothing
// security-relevant may rest on these bounds alone — the service re-validates
// every one of these values (`SiweService` re-checks the address and the
// signature, `sanitizeReturnTo` re-checks the path, `OauthStateService` re-checks
// the opaque token shape).

/** Opaque base64url tokens (handoff codes) never exceed this. */
const MAX_OPAQUE_TOKEN_LENGTH = 256;

/**
 * Body of both `POST /account/auth/oauth/:provider/start` and
 * `POST /account/identities/:provider/link` — the two routes that hand back an
 * authorize URL. `returnTo` is a PORTAL-RELATIVE path; `sanitizeReturnTo` drops
 * anything absolute or protocol-relative, because the callback concatenates it
 * onto `PORTAL_BASE_URL` and an absolute value there is an open redirect that
 * carries a freshly minted session with it.
 */
export class OauthStartDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  returnTo?: string;
}

/** Body of `POST /account/auth/oauth/exchange`. */
export class OauthExchangeDto {
  /** The single-use handoff code from the callback redirect. NOT the provider's
   *  authorization code, and NOT a token — see `OauthStateService`. */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_OPAQUE_TOKEN_LENGTH)
  code!: string;
}

/** Body of `POST /account/identities/link-pending`. */
export class LinkPendingDto {
  /**
   * The opaque pending-link token from the `/link-account` redirect. Like the
   * handoff code it is a Redis key, not a credential on its own — the binder
   * cookie and the caller's session are the other two factors.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_OPAQUE_TOKEN_LENGTH)
  token!: string;
}

/** Body of `POST /account/auth/wallet/nonce`. */
export class WalletNonceDto {
  /** `0x` + 40 hex. Any case: the challenge is issued to the EIP-55 form and
   *  `Identity.subject` stores the lowercased one. */
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/)
  address!: string;
}

/** Body of `POST /account/auth/wallet/verify`. */
export class WalletVerifyDto {
  /** Hex nonce from `/wallet/nonce`; the server holds the message it belongs to. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  nonce!: string;

  /**
   * `personal_sign` output over the server's stored message. Deliberately NO
   * `message` field: the client never gets to say what was signed (that is the
   * whole SIWE parser-mismatch attack class), so a body carrying one is REJECTED
   * by `forbidNonWhitelisted` rather than quietly ignored.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  signature!: string;
}
