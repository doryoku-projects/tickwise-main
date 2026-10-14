import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from '../src/admin/admin.controller.js';
import { PAYMENT_TOKEN_REGISTRY } from '../src/config/payment-tokens.config.js';
import { AppConfigService } from '../src/config/app-config.service.js';
import { getChainConfig, isStablecoin, isWrappedNative } from '../src/config/chains.config.js';
import { buildIntegrations } from '../src/config/integrations.config.js';
import { getProtocolConfig } from '../src/config/protocols.config.js';

describe('config registries', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves ethereum by chain id', () => {
    expect(getChainConfig(1)?.slug).toBe('ethereum');
  });

  it('resolves protocol by single protocol key', () => {
    expect(getProtocolConfig('uniswap-v4')?.version).toBe('v4');
    // expect(getProtocolConfig('uniswap-v3')?.version).toBe('v3');
  });

  it('builds enabled integrations from config-referenced env URLs', () => {
    const integrations = buildIntegrations({
      ETHEREUM_UNISWAP_V4_SUBGRAPH_URL: 'https://example.com/v4',
    });
    expect(integrations).toContainEqual(
      expect.objectContaining({
        chainId: 1,
        protocol: 'uniswap-v4',
        // ONE subgraph URL feeds positions + all pricing — no separate
        // historicalPriceSubgraphUrl (removed; we price live).
        subgraphUrl: 'https://example.com/v4',
        enabled: true,
      }),
    );
    expect(integrations.find((i) => i.protocol === 'uniswap-v4')).not.toHaveProperty('historicalPriceSubgraphUrl');
    // expect(integrations.find((i) => i.protocol === 'uniswap-v3')?.enabled).toBe(false);
  });

  // This REPLACES 'injects graph api key into keyless gateway urls'. The Graph's
  // hosted service is gone, so there is no key to inject and no gateway URL
  // rewriting; a gateway URL now has to be refused rather than silently
  // half-working. `buildIntegrations` still accepts it — the refusal is a boot
  // assertion in `validateRegistries`, which is where it can name the chain.
  it('refuses a The Graph gateway url at boot', () => {
    vi.stubEnv(
      'ETHEREUM_UNISWAP_V4_SUBGRAPH_URL',
      'https://gateway.thegraph.com/api/subgraphs/id/deployment',
    );
    expect(() => new AppConfigService()).toThrow(/gateway\.thegraph\.com/);
  });

  it('accepts an indexer url that is not a The Graph gateway', () => {
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', 'https://indexer.hyperindex.xyz/abc123/v1/graphql');
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_DIALECT', 'hyperindex');
    const config = new AppConfigService();
    const integration = config.getIntegration(1, 'uniswap-v4');
    expect(integration?.subgraphUrl).toBe('https://indexer.hyperindex.xyz/abc123/v1/graphql');
    expect(integration?.dialect).toBe('hyperindex');
  });

  it('knows ethereum stablecoins and wrapped native', () => {
    expect(isStablecoin(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true);
    expect(isWrappedNative(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).toBe(true);
  });

  it('defaults transaction sync + historical pricing on, position cron enabled', () => {
    // Transaction sync rides on the position refresh tick now — there is no
    // standalone tx cron and no full-resync interval/validator to configure.
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');

    const config = new AppConfigService();

    expect(config.transactionsSyncEnabled).toBe(true);
    expect(config.transactionsHistoricalPricingEnabled).toBe(true);
    expect(config.positionsSyncCronEnabled).toBe(true);
  });
});

// ─── validateSecurity — prod auth-realm fail-fast ─────────────────────────

const STRONG_ADMIN_SECRET = 'admin-secret-long-enough-for-prod';
const STRONG_CUSTOMER_SECRET = 'customer-secret-long-enough-for-prod';
const STRONG_OPS_SECRET = 'ops-secret-long-enough-for-prod';
const PLACEHOLDER_CUSTOMER_SECRET = 'dev-insecure-customer-jwt-secret-change-me';
/** The placeholder committed in `.env.example` / `docker-compose.yml`. */
const PLACEHOLDER_OPS_SECRET = 'change-me';
/** A genuinely EIP-55-checksummed address, verified with `viem.getAddress`. */
const CHECKSUMMED_TREASURY = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

/**
 * Stub a minimal production env. Every integration URL is blanked so
 * `validateRegistries` stays out of the way and only `validateSecurity` can
 * throw; `JWT_SECRET` and `ADMIN_SECRET` are strong so the checks under test
 * are the ones that fire.
 */
function stubProdEnv(overrides: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    ETHEREUM_UNISWAP_V4_SUBGRAPH_URL: '',
    AVALANCHE_UNISWAP_V4_SUBGRAPH_URL: '',
    JWT_SECRET: STRONG_ADMIN_SECRET,
    ADMIN_SECRET: STRONG_OPS_SECRET,
    // Email verification now defaults ON, and prod refuses to boot with it on
    // while NO MAILER IS CONFIGURED — requiring a code nobody can receive locks
    // every new signup out. These fixtures are about the JWT/SSO rules, so they
    // opt out; the dedicated cases below assert the guard itself in both
    // directions (no mailer → refuse, mailer → boot).
    CUSTOMER_EMAIL_VERIFICATION_REQUIRED: 'false',
    // Blanked so a real `.env` in the shell cannot make a "no mailer" fixture
    // silently configured — `vi.stubEnv('', …)` reads as unset via `presentValue`.
    RESEND_API_KEY: '',
    MAIL_FROM: '',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

describe('AppConfigService.validateSecurity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unset/placeholder CUSTOMER_JWT_SECRET in production', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: PLACEHOLDER_CUSTOMER_SECRET });
    expect(() => new AppConfigService()).toThrow(/CUSTOMER_JWT_SECRET/);
  });

  it('rejects a weak (<16 char) CUSTOMER_JWT_SECRET in production', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: 'too-short' });
    expect(() => new AppConfigService()).toThrow(/CUSTOMER_JWT_SECRET/);
  });

  it('rejects CUSTOMER_JWT_SECRET copy-pasted from JWT_SECRET — that collapses both realms', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: STRONG_ADMIN_SECRET });
    expect(() => new AppConfigService()).toThrow(/CUSTOMER_JWT_SECRET must differ from JWT_SECRET/);
  });

  it('still rejects a weak JWT_SECRET in production', () => {
    stubProdEnv({ JWT_SECRET: 'short', CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });
    expect(() => new AppConfigService()).toThrow(/JWT_SECRET must be set to a strong/);
  });

  // ADMIN_SECRET is the ONLY credential on the legacy `x-admin-secret` ops
  // routes (`/admin/sync/*`). Leaving it unset used to
  // make `AdminController.assertAdmin` return early — an unauthenticated
  // full-rescan trigger — and the Dockerfile ships NODE_ENV=production with no
  // ADMIN_SECRET, so that was the image's default posture.

  it('refuses to boot in production with NO ADMIN_SECRET at all', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });
    delete process.env.ADMIN_SECRET; // vi.unstubAllEnvs() restores it afterwards

    expect(() => new AppConfigService()).toThrow(/ADMIN_SECRET must be set to a strong/);
  });

  it('rejects an empty ADMIN_SECRET in production', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET, ADMIN_SECRET: '' });
    expect(() => new AppConfigService()).toThrow(/ADMIN_SECRET must be set to a strong/);
  });

  it('rejects the committed placeholder ADMIN_SECRET in production', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET, ADMIN_SECRET: PLACEHOLDER_OPS_SECRET });
    expect(() => new AppConfigService()).toThrow(/ADMIN_SECRET must be set to a strong/);
  });

  it('rejects a weak (<16 char) ADMIN_SECRET in production', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET, ADMIN_SECRET: 'short-secret' });
    expect(() => new AppConfigService()).toThrow(/ADMIN_SECRET must be set to a strong/);
  });

  // Email verification defaults ON — proving an address is the right default —
  // and production deliberately never logs the code. Requiring a code nobody can
  // receive is a total signup outage, not a stricter setting, so prod refuses to
  // boot when the flag is on AND no mailer is configured. The guard is on the
  // COMBINATION, so all four cases below matter.
  it('refuses a production boot that requires email verification with no mailer', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      CUSTOMER_EMAIL_VERIFICATION_REQUIRED: 'true',
    });

    expect(() => new AppConfigService()).toThrow(/CUSTOMER_EMAIL_VERIFICATION_REQUIRED/);
  });

  it('names both ways out in that error — configure the mailer, or turn the flag off', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      CUSTOMER_EMAIL_VERIFICATION_REQUIRED: 'true',
    });

    expect(() => new AppConfigService()).toThrow(/RESEND_API_KEY and MAIL_FROM/);
    expect(() => new AppConfigService()).toThrow(/CUSTOMER_EMAIL_VERIFICATION_REQUIRED=false/);
  });

  // The point of building the mailer: this combination used to be a hard boot
  // failure with no way to satisfy it. It must now boot.
  it('BOOTS in production with email verification on once a mailer is configured', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      CUSTOMER_EMAIL_VERIFICATION_REQUIRED: 'true',
      RESEND_API_KEY: 're_live_key_placeholder',
      MAIL_FROM: 'Tickwise <noreply@example.test>',
    });

    const config = new AppConfigService();

    expect(config.mailConfigured).toBe(true);
    expect(config.customerEmailVerificationRequired).toBe(true);
    expect(config.mailFrom).toBe('Tickwise <noreply@example.test>');
  });

  // Half-configured must read as NOT configured — a key with no verified sender
  // cannot send, so it must not be allowed to satisfy the boot guard.
  it.each([
    ['a key with no MAIL_FROM', { RESEND_API_KEY: 're_live_key_placeholder' }],
    ['a MAIL_FROM with no key', { MAIL_FROM: 'Tickwise <noreply@example.test>' }],
    ['a blank key', { RESEND_API_KEY: '   ', MAIL_FROM: 'Tickwise <noreply@example.test>' }],
  ])('still refuses the boot with %s', (_label, mailEnv) => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      CUSTOMER_EMAIL_VERIFICATION_REQUIRED: 'true',
      ...mailEnv,
    });

    expect(() => new AppConfigService()).toThrow(/CUSTOMER_EMAIL_VERIFICATION_REQUIRED/);
  });

  it('leaves mail unconfigured by default, which keeps the console-fallback behaviour', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });

    const config = new AppConfigService();

    expect(config.mailConfigured).toBe(false);
    expect(config.resendApiKey).toBeUndefined();
    expect(config.mailFrom).toBeUndefined();
    expect(config.mailReplyTo).toBeUndefined();
  });

  it('defaults email verification ON outside production, where the code is logged', () => {
    // No prod stub: dev/test keeps the secure default, and the dev-only log is
    // what makes the loop walkable without a mailer.
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');

    expect(new AppConfigService().customerEmailVerificationRequired).toBe(true);
  });

  it('accepts two distinct strong secrets and exposes both realms', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });

    const config = new AppConfigService();

    expect(config.jwtSecret).toBe(STRONG_ADMIN_SECRET);
    expect(config.customerJwtSecret).toBe(STRONG_CUSTOMER_SECRET);
    expect(config.customerJwtExpiresIn).toBe('12h');
    expect(config.adminSecret).toBe(STRONG_OPS_SECRET);
  });

  // Wallet login makes SIWE_DOMAIN mandatory in prod. That is correct — the domain
  // binding is the only thing stopping a signature captured elsewhere being replayed
  // here — but it means the FLAG'S DEFAULT decides whether every already-deployed
  // environment still boots. These two pin that contract in both directions.
  it('boots in production without SSO config, because wallet login is opt-in', () => {
    stubProdEnv({ CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });

    const config = new AppConfigService();

    expect(config.walletLoginEnabled).toBe(false);
    expect(config.configuredOauthProviders).toEqual([]);
  });

  /**
   * FINDING 11 — a wallet-only production deployment used to sign a localhost URI.
   *
   * `PORTAL_BASE_URL` was asserted only when an OAuth provider was configured,
   * but `siwe.service.ts` reads `portalBaseUrl` UNCONDITIONALLY to compose the
   * EIP-4361 message and `CustomerAuthService.passwordResetUrl` builds the emailed
   * reset link from it. A wallet-only prod deployment — a supported configuration —
   * therefore asked people to SIGN a message naming `http://localhost:3011`, and
   * mailed reset links pointing at their own machine.
   */
  it('refuses a production boot with wallet login on and a LOCALHOST PORTAL_BASE_URL', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      WALLET_LOGIN_ENABLED: 'true',
      SIWE_DOMAIN: 'app.example.com',
      PORTAL_BASE_URL: 'http://localhost:3011',
    });

    expect(() => new AppConfigService()).toThrow(/PORTAL_BASE_URL/);
  });

  it('refuses an http (non-TLS) PORTAL_BASE_URL for a wallet-only deployment too', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      WALLET_LOGIN_ENABLED: 'true',
      SIWE_DOMAIN: 'app.example.com',
      PORTAL_BASE_URL: 'http://app.example.com',
    });

    expect(() => new AppConfigService()).toThrow(/PORTAL_BASE_URL/);
  });

  it('BOOTS a wallet-only production deployment with a real https PORTAL_BASE_URL', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      WALLET_LOGIN_ENABLED: 'true',
      SIWE_DOMAIN: 'app.example.com',
      PORTAL_BASE_URL: 'https://app.example.com',
    });

    const config = new AppConfigService();

    expect(config.portalBaseUrl).toBe('https://app.example.com');
    expect(config.walletLoginEnabled).toBe(true);
  });

  it('does NOT assert OAUTH_CALLBACK_BASE_URL for a wallet-only deployment', () => {
    // Nothing but the OAuth `redirect_uri` reads it, so a deployment with no
    // provider has no callback to protect — widening this one instead of
    // PORTAL_BASE_URL would fail boots for a URL nobody uses.
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      WALLET_LOGIN_ENABLED: 'true',
      SIWE_DOMAIN: 'app.example.com',
      PORTAL_BASE_URL: 'https://app.example.com',
      OAUTH_CALLBACK_BASE_URL: 'http://localhost:3010',
    });

    expect(() => new AppConfigService()).not.toThrow();
  });

  it('ships dev URL defaults that point at ports this repo actually serves', () => {
    // FINDING 13. `OAUTH_CALLBACK_BASE_URL` defaulted to `:3000` while `PORT`
    // defaults to `3010` and the frontend runs on `3011` — so an OAuth round trip
    // on the shipped defaults handed the provider a `redirect_uri` pointing at a
    // closed port, and the callback never arrived.
    const config = new AppConfigService();

    expect(config.port).toBe(3010);
    // This backend's own origin must be this backend's own port.
    expect(config.oauthCallbackBaseUrl).toBe(`http://localhost:${config.port}`);
    // The portal is the FRONTEND's port, deliberately a different one.
    expect(config.portalBaseUrl).toBe('http://localhost:3011');
    expect(config.corsOrigins).toContain('http://localhost:3011');
  });

  it('refuses a production boot that enables wallet login while SIWE_DOMAIN is localhost', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      WALLET_LOGIN_ENABLED: 'true',
      SIWE_DOMAIN: 'localhost:3011',
      // Satisfies the OTHER wallet-login prerequisite so this case isolates the
      // SIWE_DOMAIN rule. Enabling wallet login now also demands a real
      // PORTAL_BASE_URL (see the finding-11 cases above), and that assertion runs
      // FIRST — without this the test would pass on the wrong error.
      PORTAL_BASE_URL: 'https://app.example.com',
    });

    expect(() => new AppConfigService()).toThrow(/SIWE_DOMAIN/);
  });

  // ─── The x402 rail's treasury ────────────────────────────────────────────
  //
  // This rail needs NO key material, which is its whole point — so the guards
  // here are about the two ways an operator can put key material in anyway, both
  // of which are silent without an explicit check (a 64-hex private key simply
  // fails the address regex and reads as "not set", sending them hunting for a
  // typo instead of rotating a leaked key).

  // ─── the DERIVED accept-list ──────────────────────────────────────────────
  //
  // Two lists that had to agree — an accept-list and an endpoint list — is exactly
  // the drift that had an operator add an Arbitrum RPC and get only Base offered.
  // Adding an endpoint is now the single action that starts accepting that chain.

  it('DERIVES the accepted tokens from EVM_RPC_URLS × the token registry', () => {
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');
    vi.stubEnv('PAYMENT_ACCEPTED_TOKENS', '');
    vi.stubEnv('EVM_RPC_URLS', '42161=https://arb.example,8453=https://base.example');

    const config = new AppConfigService();

    expect(config.acceptedTokensAreDerived).toBe(true);
    expect(config.acceptedPaymentTokens.map((t) => `${t.symbol}:${t.chainId}`).sort()).toEqual([
      'USDC:42161',
      'USDC:8453',
    ]);
  });

  it('accepts NOTHING for a chain with no endpoint — the endpoint is the gate', () => {
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');
    vi.stubEnv('PAYMENT_ACCEPTED_TOKENS', '');
    vi.stubEnv('EVM_RPC_URLS', '');
    // The treasury must be SET, or `x402ConfigProblem` returns ITS complaint first
    // and this test passes on the wrong error — the trap this repo has already
    // been bitten by once when a prod assertion was widened.
    vi.stubEnv('X402_TREASURY_ADDRESS', CHECKSUMMED_TREASURY);

    const config = new AppConfigService();

    expect(config.acceptedPaymentTokens).toEqual([]);
    // And the reason names the fix rather than the symptom.
    expect(config.x402ConfigProblem()).toMatch(/EVM_RPC_URLS/);
  });

  it('lets an EXPLICIT list override the derivation, to accept LESS', () => {
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');
    vi.stubEnv('PAYMENT_ACCEPTED_TOKENS', 'USDC:8453');
    vi.stubEnv('EVM_RPC_URLS', '42161=https://arb.example,8453=https://base.example');

    const config = new AppConfigService();

    expect(config.acceptedTokensAreDerived).toBe(false);
    expect(config.acceptedPaymentTokens.map((t) => t.chainId)).toEqual([8453]);
  });

  it('carries NO token that cannot implement EIP-3009 — USDT and DAI are out', () => {
    // The registry is now the SOURCE of the derived accept-list, so an entry that
    // cannot be signed for would be offered at checkout and refused by the token
    // at the last step, after the customer had signed. USDT implements no
    // EIP-3009 anywhere; DAI has EIP-2612 `permit`, which is a different thing.
    const symbols = new Set(Object.values(PAYMENT_TOKEN_REGISTRY).map((t) => t.symbol));
    expect(symbols.has('USDT')).toBe(false);
    expect(symbols.has('DAI')).toBe(false);
    expect(symbols).toEqual(new Set(['USDC']));
  });

  it('refuses a PRIVATE KEY pasted into X402_TREASURY_ADDRESS, naming it as such', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      PAYMENTS_PROVIDER: 'x402',
      X402_TREASURY_ADDRESS: `0x${'ab'.repeat(32)}`, // 32 bytes = a key, not an address
    });
    expect(() => new AppConfigService()).toThrow(/PRIVATE KEY/i);
  });

  it('refuses a seed phrase in X402_TREASURY_ADDRESS', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      PAYMENTS_PROVIDER: 'x402',
      X402_TREASURY_ADDRESS: Array(12).fill('abandon').join(' '),
    });
    expect(() => new AppConfigService()).toThrow(/SEED PHRASE/i);
  });

  it('refuses PAYMENTS_PROVIDER=x402 with no treasury address at all', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      PAYMENTS_PROVIDER: 'x402',
      X402_TREASURY_ADDRESS: '',
    });
    expect(() => new AppConfigService()).toThrow(/X402_TREASURY_ADDRESS is not set/);
  });

  it('refuses x402 when an accepted token has no RPC endpoint — it would never settle', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      PAYMENTS_PROVIDER: 'x402',
      X402_TREASURY_ADDRESS: '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359',
      PAYMENT_ACCEPTED_TOKENS: 'USDC:8453',
      EVM_RPC_URLS: '',
    });
    expect(() => new AppConfigService()).toThrow(/EVM_RPC_URLS/);
  });

  it('boots with a valid CHECKSUMMED treasury + RPC, and normalises the address', () => {
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      PAYMENTS_PROVIDER: 'x402',
      // A genuine EIP-55 checksum. NOTE: the first version of this fixture used a
      // plausible-looking mixed-case string I typed by hand, and the guard below
      // rejected it — which is the guard doing exactly its job, since a mistyped
      // treasury is money nobody can recover.
      X402_TREASURY_ADDRESS: CHECKSUMMED_TREASURY,
      PAYMENT_ACCEPTED_TOKENS: 'USDC:8453',
      EVM_RPC_URLS: '8453=https://mainnet.base.org',
      // Required now that a CONFIGURED CRYPTO RAIL counts as
      // `paymentsCheckoutConfigured` — `finishInvoice` builds return URLs from it
      // and every billing email links to it, so prod refuses a localhost value.
      // Without this the fixture would throw about PORTAL_BASE_URL and "pass" a
      // test that asserts nothing about the treasury.
      PORTAL_BASE_URL: 'https://app.example.com',
    });

    const config = new AppConfigService();

    expect(config.x402PaymentsConfigured).toBe(true);
    expect(config.paymentsCheckoutConfigured).toBe(true);
    expect(config.x402ConfigProblem()).toBeNull();
    // Lowercased, so a comparison against a log-derived or chain-derived address
    // never fails on casing alone.
    expect(config.x402TreasuryAddress).toBe(CHECKSUMMED_TREASURY.toLowerCase());
  });

  it('a CONFIGURED CRYPTO RAIL makes PORTAL_BASE_URL a production requirement', () => {
    // The gap this closes: `paymentsCheckoutConfigured` used to answer TRUE only
    // for radom, so a production deployment selling on a self-custody rail could
    // boot with the dev default and mail dead `http://localhost:3011` links to
    // paying customers. Neither crypto rail redirects a browser, but
    // `finishInvoice` builds return URLs from this value for EVERY rail and every
    // billing email links to it.
    stubProdEnv({
      CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET,
      PAYMENTS_PROVIDER: 'x402',
      X402_TREASURY_ADDRESS: CHECKSUMMED_TREASURY,
      PAYMENT_ACCEPTED_TOKENS: 'USDC:8453',
      EVM_RPC_URLS: '8453=https://mainnet.base.org',
      PORTAL_BASE_URL: 'http://localhost:3011',
    });
    expect(() => new AppConfigService()).toThrow(/PORTAL_BASE_URL/);
  });

  it('accepts an ALL-LOWERCASE treasury — such a string carries no checksum to verify', () => {
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');
    vi.stubEnv('X402_TREASURY_ADDRESS', CHECKSUMMED_TREASURY.toLowerCase());

    expect(new AppConfigService().x402TreasuryAddress).toBe(CHECKSUMMED_TREASURY.toLowerCase());
  });

  it('REJECTS a mixed-case treasury whose EIP-55 checksum fails — a one-character typo', () => {
    // The whole point: `…d359` -> `…d352` is a real, well-formed address that
    // nobody holds the key to. A hex-shape regex accepts it and lowercasing
    // destroys the only evidence of the mistake.
    const typo = CHECKSUMMED_TREASURY.slice(0, -1) + '2';
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');
    vi.stubEnv('X402_TREASURY_ADDRESS', typo);

    const config = new AppConfigService();

    expect(config.x402TreasuryAddress).toBeUndefined();
    expect(config.x402ConfigProblem()).toMatch(/not a valid 0x address/);
  });

  it('reads a malformed treasury address as NOT CONFIGURED rather than passing it through', () => {
    // It ends up inside a SIGNED struct; a nonsense destination is a payment the
    // customer cannot make and we cannot receive.
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');
    vi.stubEnv('X402_TREASURY_ADDRESS', '0xnot-an-address');

    const config = new AppConfigService();

    expect(config.x402TreasuryAddress).toBeUndefined();
    expect(config.x402ConfigProblem()).toMatch(/not a valid 0x address/);
  });

  it('floors the authorization TTL so a typo cannot make the signing window instant', () => {
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');
    vi.stubEnv('X402_AUTHORIZATION_TTL_MS', '5');

    expect(new AppConfigService().x402AuthorizationTtlMs).toBe(1_800_000);
  });

  it('does not require CUSTOMER_JWT_SECRET or ADMIN_SECRET outside production', () => {
    // The prod checks sit after the non-prod early return, so dev/test boots
    // (and every spec that constructs AppConfigService) stay frictionless.
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', '');
    vi.stubEnv('ADMIN_SECRET', '');

    const config = new AppConfigService();

    expect(config.customerJwtSecret).toBe(PLACEHOLDER_CUSTOMER_SECRET);
    expect(config.adminSecret).toBe('');
  });
});

// ─── The request-time half of the same ADMIN_SECRET story ──────────────────
//
// `validateSecurity` above stops a PRODUCTION boot without a secret; this is
// the gate itself, which must fail CLOSED in every other environment too. It
// used to `return` on an unset secret, leaving `POST /admin/sync/run` (cursor
// reset + full rescan of every chain, loopable) reachable with no credential.

describe('AdminController legacy x-admin-secret gate', () => {
  function build(adminSecret: string | undefined, deps: { queues?: unknown; syncRepo?: unknown } = {}) {
    return new AdminController(
      { adminSecret } as unknown as AppConfigService,
      (deps.queues ?? {}) as never,
      (deps.syncRepo ?? {}) as never,
    );
  }

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('401s every ops route when ADMIN_SECRET is %s — fails CLOSED', async (_label, secret) => {
    const controller = build(secret);

    // Even a caller that guesses the header value gets nothing.
    await expect(controller.syncStatus('change-me')).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.runSync(undefined, { all: true, fromStart: true } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('keeps the existing behaviour when ADMIN_SECRET IS set: 403 on a wrong header, through on the right one', async () => {
    const controller = build(STRONG_OPS_SECRET, {
      queues: { status: async () => ({ waiting: 0 }) },
      syncRepo: { status: async () => ({ cursors: [] }) },
    });

    await expect(controller.syncStatus(undefined)).rejects.toMatchObject({ status: 403 });
    await expect(controller.syncStatus('wrong')).rejects.toMatchObject({ status: 403 });
    await expect(controller.syncStatus(STRONG_OPS_SECRET)).resolves.toMatchObject({
      queue: { waiting: 0 },
      cursors: [],
    });
  });
});

describe('leaderboard Redis snapshots', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('are on in production and off elsewhere unless LEADERBOARD_SNAPSHOT_REDIS_ENABLED says otherwise', () => {
    vi.stubEnv('LEADERBOARD_SNAPSHOT_REDIS_ENABLED', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(new AppConfigService().leaderboardSnapshotRedisEnabled).toBe(false);
    vi.stubEnv('LEADERBOARD_SNAPSHOT_REDIS_ENABLED', 'true');
    expect(new AppConfigService().leaderboardSnapshotRedisEnabled).toBe(true);
    stubProdEnv({ LEADERBOARD_SNAPSHOT_REDIS_ENABLED: '', CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });
    expect(new AppConfigService().leaderboardSnapshotRedisEnabled).toBe(true);
    stubProdEnv({ LEADERBOARD_SNAPSHOT_REDIS_ENABLED: 'false', CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });
    expect(new AppConfigService().leaderboardSnapshotRedisEnabled).toBe(false);
  });

  it('are namespaced by NODE_ENV + Mongo hosts/database, never by the credentials', () => {
    const ns = (uri: string, env = 'development') => {
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('MONGODB_URI', uri);
      return new AppConfigService().leaderboardSnapshotNamespace;
    };
    const local = ns('mongodb://localhost:27017/copypools_positions');
    expect(local).toMatch(/^[0-9a-f]{16}$/);
    expect(ns('mongodb://localhost:27017/copypools_positions?retryWrites=true')).toBe(local);
    expect(ns('mongodb+srv://u:p@cluster0.x.mongodb.net/copypools_positions')).not.toBe(local);
    expect(ns('mongodb+srv://other:secret@cluster0.x.mongodb.net/copypools_positions')).toBe(
      ns('mongodb+srv://u:p@cluster0.x.mongodb.net/copypools_positions'),
    );
    expect(ns('mongodb://localhost:27017/copypools_positions', 'test')).not.toBe(local);
  });
});

describe('QUEUE_CLEAR_ON_BOOT', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 2026-10-03: OFF by default. Obliterating the queues at boot was what lost
  // an in-flight backfill on every deploy; it is a manual reset now. It was a
  // raw `process.env` read meaning "on unless the string 'false'".
  it('defaults to false and is on only for the string "true"', () => {
    vi.stubEnv('QUEUE_CLEAR_ON_BOOT', '');
    delete process.env.QUEUE_CLEAR_ON_BOOT;
    expect(new AppConfigService().queueClearOnBoot).toBe(false);
    vi.stubEnv('QUEUE_CLEAR_ON_BOOT', 'false');
    expect(new AppConfigService().queueClearOnBoot).toBe(false);
    vi.stubEnv('QUEUE_CLEAR_ON_BOOT', 'true');
    expect(new AppConfigService().queueClearOnBoot).toBe(true);
  });
});

describe('Mongo client limits and shard autoIndex (scale plan 1.8, 2026-10-03)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const unset = (...names: string[]) => {
    for (const name of names) {
      vi.stubEnv(name, '');
      delete process.env[name];
    }
  };

  it('names the client and bounds the pool and its wait queue by default', () => {
    unset('MONGO_APP_NAME', 'MONGO_MAX_POOL_SIZE', 'MONGO_WAIT_QUEUE_TIMEOUT_MS');
    const config = new AppConfigService();
    expect(config.mongoAppName).toBe('tickwise-backend');
    expect(config.mongoMaxPoolSize).toBe(60);
    expect(config.mongoWaitQueueTimeoutMs).toBe(10_000);
  });

  it('has no "unbounded": a 0 or garbage wait reads as the default, and both are clamped', () => {
    vi.stubEnv('MONGO_WAIT_QUEUE_TIMEOUT_MS', '0');
    expect(new AppConfigService().mongoWaitQueueTimeoutMs).toBe(10_000);
    vi.stubEnv('MONGO_WAIT_QUEUE_TIMEOUT_MS', 'soon');
    expect(new AppConfigService().mongoWaitQueueTimeoutMs).toBe(10_000);
    vi.stubEnv('MONGO_WAIT_QUEUE_TIMEOUT_MS', '2000');
    expect(new AppConfigService().mongoWaitQueueTimeoutMs).toBe(2_000);
    vi.stubEnv('MONGO_WAIT_QUEUE_TIMEOUT_MS', '20');
    expect(new AppConfigService().mongoWaitQueueTimeoutMs).toBe(100);
    vi.stubEnv('MONGO_MAX_POOL_SIZE', '0');
    expect(new AppConfigService().mongoMaxPoolSize).toBe(60);
    vi.stubEnv('MONGO_MAX_POOL_SIZE', '20');
    expect(new AppConfigService().mongoMaxPoolSize).toBe(20);
    vi.stubEnv('MONGO_MAX_POOL_SIZE', '100000');
    expect(new AppConfigService().mongoMaxPoolSize).toBe(500);
    vi.stubEnv('MONGO_APP_NAME', 'tickwise-api');
    expect(new AppConfigService().mongoAppName).toBe('tickwise-api');
  });

  it('shard autoIndex is OFF in production and ON elsewhere unless MONGO_SHARD_AUTO_INDEX says otherwise', () => {
    unset('MONGO_SHARD_AUTO_INDEX');
    vi.stubEnv('NODE_ENV', 'development');
    expect(new AppConfigService().mongoShardAutoIndex).toBe(true);
    vi.stubEnv('MONGO_SHARD_AUTO_INDEX', 'false');
    expect(new AppConfigService().mongoShardAutoIndex).toBe(false);
    stubProdEnv({ MONGO_SHARD_AUTO_INDEX: '', CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });
    expect(new AppConfigService().mongoShardAutoIndex).toBe(false);
    stubProdEnv({ MONGO_SHARD_AUTO_INDEX: 'true', CUSTOMER_JWT_SECRET: STRONG_CUSTOMER_SECRET });
    expect(new AppConfigService().mongoShardAutoIndex).toBe(true);
  });
});

describe('fee ramp and budget (scale plan 1.9, 2026-10-03)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('POSITION_FEE_RAMP_MS: 5 min by default, 0 = no ramp, garbage = the default, capped at 2 h', () => {
    vi.stubEnv('POSITION_FEE_RAMP_MS', '');
    delete process.env.POSITION_FEE_RAMP_MS;
    expect(new AppConfigService().positionFeeRampMs).toBe(300_000);
    vi.stubEnv('POSITION_FEE_RAMP_MS', '0');
    expect(new AppConfigService().positionFeeRampMs).toBe(0);
    vi.stubEnv('POSITION_FEE_RAMP_MS', '-5');
    expect(new AppConfigService().positionFeeRampMs).toBe(300_000);
    vi.stubEnv('POSITION_FEE_RAMP_MS', 'later');
    expect(new AppConfigService().positionFeeRampMs).toBe(300_000);
    vi.stubEnv('POSITION_FEE_RAMP_MS', '86400000');
    expect(new AppConfigService().positionFeeRampMs).toBe(7_200_000);
  });

  it('POSITION_FEE_MAX_PER_TICK defaults to 25000; the write gate keeps 40 / 25', () => {
    for (const name of ['POSITION_FEE_MAX_PER_TICK', 'POSITION_FEE_MAX_WRITES_PER_SEC', 'POSITION_FEE_MAX_SERVED_WRITES_PER_SEC']) {
      vi.stubEnv(name, '');
      delete process.env[name];
    }
    const config = new AppConfigService();
    expect(config.positionFeeMaxPerTick).toBe(25_000);
    expect(config.positionFeeMaxWritesPerSec).toBe(40);
    expect(config.positionFeeMaxServedWritesPerSec).toBe(25);
  });
});
