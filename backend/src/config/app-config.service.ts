import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { isAddress } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { z } from 'zod';
import { CHAINS, getChainConfig } from './chains.config.js';
import { buildIntegrations, parseSourceOrder, type IntegrationConfig } from './integrations.config.js';
import { getProtocolConfig, PROTOCOLS } from './protocols.config.js';
import { PAYMENT_TOKEN_REGISTRY, parseAcceptedTokens, type PaymentToken } from './payment-tokens.config.js';
// W3: type-only, so config never pulls the gateway module in at runtime.
import type { IndexerGatewayConfig, IndexerGatewayMode } from '../subgraph/hyperindex/indexer-gateway.js';
// P-R: type-only, so config never pulls the read-models modules in at runtime.
import type { ConfiguredRole as ConfiguredReadModelsRole, ReadModelMode } from '../read-models/flags.js';
import type { PositionsCapacity } from '../read-models/capacity.js';
// P2/P3. Both modules are import-free / pure (no cycle back to this file).
import {
  resolveProcessRoleSettings,
  roleCan,
  roleDefaults,
  type ProcessLeasesSetting,
  type ProcessRole,
  type ProcessRoleSettings,
} from '../common/process-role.js';
import { resolveWriteBudgetSettings, type WriteBudgetSettings } from '../common/write-budget-model.js';
// Usage write batching: the PURE module (imports only mongoose `Types`) — never
// usage-flush.service.js, which imports this file (a cycle).
import { resolveUsageFlushIntervalMs, resolveUsageWriteMode, type UsageWriteMode } from '../billing/usage-flush.js';

const DEFAULT_JWT_SECRET = 'dev-insecure-jwt-secret-change-me';
const DEFAULT_CUSTOMER_JWT_SECRET = 'dev-insecure-customer-jwt-secret-change-me';
/** The placeholder shipped in `.env.example` / `docker-compose.yml`. */
const DEFAULT_ADMIN_SECRET = 'change-me';

/** OAuth providers this backend can broker customer SSO through. */
export type OauthProviderKey = 'google' | 'github';

/** Hostnames that must never appear in a production SSO redirect/domain binding. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const optionalUrl = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  },
  z.string().url().optional(),
);

/**
 * `blank reads as unset` for the two per-integration indexer switches, so a
 * `KEY=` left in `.env` keeps the code default instead of failing the parse.
 * The values are asserted rather than coerced: `buildIntegrations` tests the
 * flag with `=== 'true'`, so `TRUE`/`1`/`yes` would silently read as OFF.
 */
const blankIsUnset = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/**
 * C-cap: `READ_MODELS_POSITIONS_CAPACITY` — a plain row count (every
 * positions table; `Number` semantics, as before) or comma-separated
 * `chainId:rows` pairs (per chain). A negative / non-numeric count, a
 * malformed pair, an unknown or repeated chain id fail the boot.
 */
function parsePositionsCapacity(raw: string): { value: PositionsCapacity } | { error: string } {
  const usage = 'READ_MODELS_POSITIONS_CAPACITY must be a row count ≥ 0 (every positions table) or chainId:rows pairs separated by commas (e.g. 4663:6000000,1:600000)';
  if (!raw.includes(':')) {
    const rows = Number(raw);
    return Number.isFinite(rows) && rows >= 0 ? { value: rows } : { error: `${usage}; got "${raw}"` };
  }
  const perChain: Record<number, number> = {};
  for (const part of raw.split(',')) {
    const match = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(part);
    if (!match) return { error: `${usage}; "${part.trim()}" is not chainId:rows` };
    const chainId = Number(match[1]);
    const rows = Number(match[2]);
    if (!CHAINS[chainId]) return { error: `${usage}; chain ${chainId} is not a known chain (${Object.keys(CHAINS).join(', ')})` };
    if (Object.hasOwn(perChain, chainId)) return { error: `${usage}; chain ${chainId} is listed twice` };
    if (!Number.isSafeInteger(rows)) return { error: `${usage}; ${match[2]} rows for chain ${chainId} is not a safe integer` };
    perChain[chainId] = rows;
  }
  return { value: { perChain } };
}

const subgraphDialect = z.preprocess(blankIsUnset, z.enum(['thegraph', 'hyperindex']).optional());

/** A `*_INDEXER_SOURCES` priority list; the same parser `buildIntegrations` uses. */
const indexerSources = z.preprocess(
  blankIsUnset,
  z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) return;
      try {
        parseSourceOrder(value, 'INDEXER_SOURCES');
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
      }
    }),
);

const optionalNonNegativeInt = z.preprocess(blankIsUnset, z.string().regex(/^\d+$/).optional());

/**
 * P2/P3: blank = unset (`blankIsUnset`) and case-insensitive, for the enum
 * switches whose values operators type by hand (`PROCESS_ROLE=API`).
 */
const blankIsUnsetLower = (value: unknown) => {
  const v = blankIsUnset(value);
  return typeof v === 'string' ? v.toLowerCase() : v;
};
/** An optional numeric env: blank/unset = `undefined` (the getter's default rule decides), else `Number(…)` (NaN for garbage). */
const optionalNumberEnv = z.preprocess(blankIsUnset, z.string().optional()).transform((v) => (v === undefined ? undefined : Number(v)));
/** A numeric env with a default; blank = the default (never `0`). Garbage reads NaN and each getter maps it to its default. */
const numberEnv = (fallback: string) => z.preprocess(blankIsUnset, z.string().default(fallback)).transform(Number);
/** A free-form string env; blank = the default. */
const stringEnv = (fallback: string) => z.preprocess(blankIsUnset, z.string().default(fallback));
/** A finite number > 0, else `fallback` (the rule `trustPolicyOf` applies to a missing getter). */
const positiveOr = (v: number, fallback: number): number => (Number.isFinite(v) && v > 0 ? v : fallback);
/** A finite number ≥ 0, else `fallback`. */
const nonNegativeOr = (v: number, fallback: number): number => (Number.isFinite(v) && v >= 0 ? v : fallback);


/**
 * A URL env that always resolves to a value: blank (`KEY=` left empty in
 * `.env`) reads as UNSET so the default applies, rather than parsing `''` as
 * a URL and failing the whole boot.
 */
const urlWithDefault = (fallback: string) =>
  z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().url().default(fallback),
  );

const boolString = z.string().transform((value) => value === 'true');

const configSchema = z.object({
  // App / storage / auth
  PORT: z.string().default('3010'),
  /**
   * Number of reverse-proxy hops in front of this app (Railway/Vercel/nginx = 1).
   *
   * Drives Express `trust proxy`, which is what makes `req.ip` the real client
   * rather than the proxy. The anonymous-signup throttle is keyed on that IP, so
   * behind a proxy with this left at 0 every visitor collapses into ONE bucket
   * and the throttle becomes a global signup cap.
   *
   * Defaults to 0 (do not trust) because the opposite mistake is worse: trusting
   * a hop that is not there lets any caller spoof `X-Forwarded-For` and mint an
   * unlimited number of buckets, which silently disables the throttle instead of
   * merely over-tightening it.
   */
  TRUST_PROXY_HOPS: z.string().default('0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017/copypools_positions'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  ADMIN_SECRET: z.string().optional(),
  /**
   * Admin-panel login (JWT). `ADMIN_EMAIL` + `ADMIN_PASSWORD` seed the first
   * admin user on boot if no admin exists. `JWT_SECRET` signs the session
   * token; in production it MUST be set to a strong random value (the default
   * is only a dev convenience). `JWT_EXPIRES_IN` is any `jsonwebtoken` duration
   * string (e.g. `12h`, `7d`).
   */
  JWT_SECRET: z.string().default(DEFAULT_JWT_SECRET),
  JWT_EXPIRES_IN: z.string().default('12h'),
  /**
   * Customer-portal login (JWT) for the self-serve API product. This is a
   * SEPARATE auth realm from the admin panel: `CUSTOMER_JWT_SECRET` must be set
   * to its own strong random value in production and MUST NOT equal
   * `JWT_SECRET` — sharing one secret collapses both realms back into one while
   * every guard still looks correct. `CUSTOMER_JWT_EXPIRES_IN` is any
   * `jsonwebtoken` duration string (e.g. `12h`, `7d`).
   */
  CUSTOMER_JWT_SECRET: z.string().default(DEFAULT_CUSTOMER_JWT_SECRET),
  CUSTOMER_JWT_EXPIRES_IN: z.string().default('12h'),
  /**
   * Gate on requiring a verified email before a customer may use the portal.
   *
   * Defaults ON: an unverified address is an unproven one, and proving it is the
   * default a signup flow should have. Opt OUT explicitly if you must.
   *
   * The hazard this creates is handled in `validateSecurity()`: production
   * deliberately refuses to log the code, so requiring verification in prod
   * WITHOUT a configured mailer would lock out every new signup with no way for
   * them to recover. Prod refuses to boot in exactly that combination — the flag
   * on AND `mailConfigured` false. With a mailer configured it boots normally.
   * In development the code is written to the server log either way, so the loop
   * is walkable with no mailer at all.
   */
  CUSTOMER_EMAIL_VERIFICATION_REQUIRED: z.string().default('true').transform((v) => v === 'true'),

  /**
   * Mail transport (Resend). BOTH `RESEND_API_KEY` and `MAIL_FROM` must be
   * present for mail to be considered configured — see `mailConfigured`, which
   * is the single source of truth every caller reads.
   *
   * Why both, and why half-configured reads as UNCONFIGURED rather than broken:
   * a key with no from-address cannot send, so treating a lone key as
   * "configured" would turn one missing env into a runtime failure on every
   * single email instead of a clean fall back to the console path. Same rule as
   * the OAuth id/secret pairs above.
   *
   * `MAIL_FROM` must be a sender Resend has VERIFIED for the account (a verified
   * domain, or `onboarding@resend.dev` while testing) — anything else is
   * accepted by config and then rejected by the provider on every send, with
   * `403 The <domain> domain is not verified`.
   *
   * The verified sending domain is NOT necessarily this backend's own host: a
   * deployment on `api.tickwise.xyz` may only have `mail.example.com`
   * verified, and setting the from-address to match the API host silently breaks
   * every signup — the code is minted, delivery fails, and the account is left
   * unverified behind a 403.
   */
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  /** Optional `Reply-To`. Blank = replies go to `MAIL_FROM`. */
  MAIL_REPLY_TO: z.string().optional(),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  /**
   * Header name carrying the public-API key on `/v1/*` requests. Defaults to
   * `KC-APIKey` (matches the Krystal/d-app convention). Case-insensitive on read.
   */
  API_KEY_HEADER: z.string().default('KC-APIKey'),
  /**
   * Comma-separated allowlist of browser origins permitted by CORS. In dev
   * (NODE_ENV !== 'production') any origin is allowed. In prod the value
   * MUST include every frontend URL that fetches this backend. Example:
   *   CORS_ORIGINS=http://localhost:3011,https://api.tickwise.xyz
   *
   * The dev default is the FRONTEND's origin (3011), not this backend's. It used
   * to be `3000`, which is neither: nothing in this repo listens there. Inert in
   * dev (any origin passes) and always overridden in prod, so this was a
   * misleading default rather than a live bug — but `FirstPartyOriginGuard` reads
   * the same list to gate `/api/top-*`, so a prod deployment that forgot to set
   * it would have 403'd its own dashboard against a port nobody serves.
   */
  CORS_ORIGINS: z.string().default('http://localhost:3011'),

  /**
   * Customer SSO — OAuth (Google/GitHub) + wallet (SIWE) sign-in for the same
   * `/account/*` realm as password login (SSO mints the identical `typ:'customer'`
   * token, so no guard/metering/ownership code changes).
   *
   * A provider is offered ONLY when BOTH its client id and secret are present —
   * mirroring how `integrations.config.ts` keys `enabled` off an env being set.
   * Half-configured must read as DISABLED, not broken: the provider list route
   * would otherwise advertise a button whose callback 400s at the token exchange.
   */
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  /**
   * This backend's PUBLIC origin — the `redirect_uri` sent to the provider is
   * built from it (`{base}/account/auth/oauth/{provider}/callback`), so it MUST
   * exactly match the URI registered in the Google/GitHub app console or the
   * provider refuses the code exchange.
   */
  /**
   * The dev default is `3010` because that is `PORT`'s default — i.e. THIS
   * process. It said `3000`, where nothing in this repo listens (the frontend is
   * 3011), so an OAuth round trip taken with the shipped defaults sent the
   * provider a `redirect_uri` pointing at a closed port and the callback simply
   * never arrived.
   */
  OAUTH_CALLBACK_BASE_URL: urlWithDefault('http://localhost:3010'),
  /**
   * The frontend origin the browser is redirected back to once a token is minted.
   * 3011 matches `frontend`'s `next dev -p 3011` and `.claude/launch.json`.
   */
  PORTAL_BASE_URL: urlWithDefault('http://localhost:3011'),
  /**
   * Domain bound into the SIWE message (`host[:port]`, no scheme — EIP-4361).
   * This binding is the only thing that stops a signature captured by another
   * site being replayed against us, so prod refuses a localhost value.
   */
  SIWE_DOMAIN: z.string().default('localhost:3011'),
  /** Human-readable line shown to the user inside the message they sign. */
  SIWE_STATEMENT: z.string().default('Sign in to the Tickwise API portal.'),
  /**
   * Wallet (SIWE) sign-in. Defaults OFF, and that default is load-bearing:
   * turning it on makes `SIWE_DOMAIN` mandatory in production, so a default of
   * `true` would hard-fail the boot of every already-deployed environment that
   * has never heard of this feature. Opt in explicitly (`.env.example` does).
   */
  WALLET_LOGIN_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  /**
   * ─── Payments ────────────────────────────────────────────────────────────
   *
   * The rail new checkouts are minted on. `x402` is the intended production rail
   * for crypto (see below); `radom` is kept as the reference HOSTED-REDIRECT
   * shape a fiat provider will take.
   *
   * The DEFAULT is deliberately a rail that needs credentials, rather than
   * something that "just works" locally: with none configured the registry logs
   * an alert at boot and every upgrade attempt is refused, which is loud and
   * harmless. A default of `fake` would be quiet and would hand out paid plans
   * for nothing the day it reached a real environment.
   *
   * For local work set `PAYMENTS_PROVIDER=fake` AND `PAYMENTS_FAKE_ENABLED=true`.
   */
  PAYMENTS_PROVIDER: z.string().default('radom'),
  /**
   * The in-development rail (`src/payments/providers/fake.provider.ts`). It
   * grants entitlement with no money, so it is refused in production
   * REGARDLESS of this flag — the flag only decides whether it is available in
   * development, and defaults off there too.
   */
  PAYMENTS_FAKE_ENABLED: z.string().default('false').transform((v) => v === 'true'),

  /**
   * ─── Shared chain settings (read by the x402 rail) ────────────────────────
   *
   * THESE ARE THE FIRST THINGS IN THIS BACKEND THAT TALK TO A NODE. the internal design notes listed RPC integration as out of scope, and that held right up to the
   * moment we took custody of payments: no aggregator can answer "did this exact
   * authorization settle on chain", which is the only question that matters here.
   * RPC use is confined to `payments/providers/x402/`.
   */

  /**
   * Which tokens we accept — an OPTIONAL OVERRIDE. Leave it EMPTY (the default)
   * and the accept-list is DERIVED as
   *
   *     every token in `PAYMENT_TOKEN_REGISTRY`  ×  every chain in `EVM_RPC_URLS`
   *
   * so adding an RPC endpoint is the single action that starts accepting that
   * chain's tokens. Two lists that had to agree — an accept-list and an endpoint
   * list — is exactly the drift that had an operator add an Arbitrum RPC and
   * wonder why only Base was offered.
   *
   * Set it explicitly only to accept LESS than that (one chain during a test, one
   * token while another is under suspicion), or to add a token the registry does
   * not carry:
   *   `USDC:8453`                     — a registry entry, by symbol+chain
   *   `MYTOK:8453:0xabc…:18`          — any token, fully specified
   * A malformed entry throws at boot rather than being skipped — see the parser.
   *
   * NOTE the registry is curated for THIS rail: every entry must implement
   * EIP-3009, which is why USDT and DAI are not in it. See its header.
   */
  PAYMENT_ACCEPTED_TOKENS: z.string().default(''),


  /**
   * Per-chain JSON-RPC endpoints, `chainId=url` comma-separated. A chain with no
   * endpoint can be neither VERIFIED (its token's EIP-712 domain is read from the
   * chain) nor watched, so its tokens are refused at boot rather than accepted
   * and silently never settled.
   */
  EVM_RPC_URLS: z.string().default(''),

  /**
   * Confirmations before a transfer is treated as settled, `chainId=n`
   * comma-separated, falling back to `PAYMENT_MIN_CONFIRMATIONS_DEFAULT`.
   *
   * This is a REORG BUDGET, not a latency knob. Granting a plan on a transfer
   * that a reorg then erases is unrecoverable — the entitlement is already
   * spent. Cheap-to-reorg chains want more; the defaults are deliberately
   * conservative.
   */
  PAYMENT_MIN_CONFIRMATIONS: z.string().default('1=12,8453=30,42161=30,10=30,137=128,43114=5'),
  PAYMENT_MIN_CONFIRMATIONS_DEFAULT: z.string().default('30').transform(Number),

  /**
   * How often the chain watcher polls for settlement logs.
   *
   * READ BY NOTHING RIGHT NOW: the deposit rail's watcher was deleted with that
   * rail and the x402 `AuthorizationUsed` watcher is Phase 3. Kept because that
   * watcher needs exactly this knob, and because removing and re-adding an env
   * var churns every deployment's config for nothing.
   */
  PAYMENT_WATCH_INTERVAL_MS: z.string().default('30000').transform(Number),
  /**
   * Blocks per `eth_getLogs` window. Most providers cap the span; 2000 is under
   * every common limit. Too large and the call is rejected, which reads as "no
   * payments are arriving".
   */
  PAYMENT_WATCH_BLOCK_RANGE: z.string().default('2000').transform(Number),

  /**
   * ─── The x402 / EIP-3009 rail (`PAYMENTS_PROVIDER=x402`) ──────────────────
   *
   * THE crypto rail. Self-custody with NO xpub, NO per-invoice address and NO
   * sweep — a deposit-address rail that needed all three was deleted on
   * 2026-08-11. The customer signs an EIP-3009
   * `transferWithAuthorization` off-chain and the token itself moves the money
   * STRAIGHT INTO THIS ADDRESS. Funds are consolidated by construction, so
   * "withdrawing" is just using the treasury wallet.
   *
   * The treasury's private key NEVER touches this server. The only key the rail
   * ever needs is a gas-only relayer (added with the submit step), and it cannot
   * redirect a cent because `to` is inside the signed struct.
   *
   * Chains and tokens come from the SHARED `PAYMENT_ACCEPTED_TOKENS` /
   * `EVM_RPC_URLS` / `PAYMENT_MIN_CONFIRMATIONS` settings above — one accept-list
   * for every crypto rail, so the two cannot drift into offering different
   * tokens. NOTE the extra constraint this rail adds: a token must implement
   * EIP-3009, which USDC and Circle's other FiatTokens do and **USDT does not**.
   * `Eip3009DomainService` verifies that per token against the chain at boot and
   * refuses to offer one that fails, so a wrong entry is a boot alert rather than
   * a customer's dead payment.
   */
  X402_TREASURY_ADDRESS: z.string().optional(),
  /**
   * How long a SIGNING window stays open — the `validBefore` stamped when a
   * specific wallet is handed a payload to sign.
   *
   * Deliberately SHORT: the token enforces it, so an abandoned signature becomes
   * unspendable on its own with nothing to revoke, and a long window is a long
   * time in which the customer's balance can move (a relay that fails for
   * insufficient funds is worse than being asked to sign again).
   *
   * THIS IS NOT THE QUOTE'S LIFETIME — see `X402_QUOTE_TTL_MS`. Conflating the
   * two is what made every sweep-raised renewal unpayable: a renewal quote is
   * minted `SUBSCRIPTION_RENEWAL_LEAD_DAYS` (7) before its period starts, so a
   * 30-minute deadline had elapsed days before the customer ever saw it.
   */
  X402_AUTHORIZATION_TTL_MS: z.string().default('1800000').transform(Number),
  /**
   * The RELAYER's private key — the only signing key this payment system holds,
   * and it is GAS-ONLY.
   *
   * It submits a customer's already-signed authorization and pays the gas. Every
   * money field (`from`, `to`, `value`, `nonce`) lives inside the CUSTOMER's
   * signature, so this key cannot redirect a cent — change any of them and the
   * token's own check fails and the call reverts. **Blast radius of a full
   * compromise: the ETH float in this one account.** Fund it small; treat it as
   * disposable.
   *
   * OPTIONAL. Unset means customers submit their own authorizations from their
   * wallet and pay their own gas — a supported deployment with NO key on the
   * server at all, at the cost of one extra wallet confirmation.
   *
   * NEVER the treasury's key. The treasury only ever RECEIVES; putting its key
   * here would be the one change that turns a gas-float leak into a treasury
   * drain, and `validateSecurity` refuses the two being equal.
   */
  X402_SUBMITTER_PRIVATE_KEY: z.string().optional(),
  /**
   * How long a QUOTE stays fresh — days, not minutes, because a renewal quote is
   * minted a week ahead of its period. Past it the next checkout RE-QUOTES
   * (new nonce, current amount) rather than handing back a stale one. Default 30
   * days, comfortably past the renewal lead window.
   */
  X402_QUOTE_TTL_MS: z.string().default('2592000000').transform(Number),

  /**
   * Radom. BOTH the API key and the webhook secret are required for the rail to
   * count as configured — same rule as the mail and OAuth pairs. A key with no
   * webhook secret can TAKE money and then cannot be told that it did, which is
   * worse than being switched off.
   *
   * KEPT as the reference HOSTED-REDIRECT adapter even though the native rail
   * supersedes it for crypto: it is the shape a fiat provider will take, and
   * deleting it would mean re-deriving that shape from scratch when one is
   * needed. It is inert unless `PAYMENTS_PROVIDER=radom`.
   */
  RADOM_API_KEY: z.string().optional(),
  RADOM_API_BASE_URL: urlWithDefault('https://api.radom.com'),
  RADOM_WEBHOOK_SECRET: z.string().optional(),
  /**
   * Accepted alongside `RADOM_WEBHOOK_SECRET` so the key can be rolled without
   * a window where in-flight deliveries are rejected. UNSET IT once the
   * rotation is done — `RadomPaymentProvider` logs an alert every time a
   * delivery is accepted on it, because a rotation nobody finishes is a secret
   * that never actually rotated.
   */
  RADOM_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),
  /**
   * Comma-separated `TOKEN:NETWORK` pairs offered at checkout. USDC on the
   * three chains the plan names; the token is what we price in, the network is
   * where the customer sends it.
   */
  RADOM_ACCEPTED_METHODS: z.string().default('USDC:Ethereum,USDC:Base,USDC:Arbitrum'),
  /**
   * How long a minted pay link is treated as live. Radom expires links on its
   * own side; this is OUR copy of that deadline, stored on
   * `Invoice.checkout.expiresAt` so the portal can mint a fresh link instead of
   * showing a dead one. Set 0 to record no expiry.
   */
  RADOM_CHECKOUT_TTL_MS: z.string().default('3600000').transform(Number),

  /**
   * Money, in MINOR units. How far short a payment may fall and still settle.
   *
   * Defaults to 100 ($1) — crypto senders round and a network fee deducted at
   * source arrives a few cents light, and refusing entitlement over four cents
   * costs more in support than the shortfall.
   *
   * TURN IT DOWN FOR A SMALL-VALUE LIVE TEST. A flat $1 is half the price of a
   * $2 plan and the whole of a $1 one, so at those amounts a payment of a cent
   * — or of nothing — settles the invoice and the test proves nothing about
   * amounts. Set it to `5` and a $2 live payment becomes a real assertion.
   * Boot logs the value whenever it is not the default, because a tolerance
   * silently left at test settings is money given away.
   */
  PAYMENTS_UNDERPAY_TOLERANCE_MINOR: z.string().default('100').transform(Number),

  /**
   * Days of continued access after a period ends unpaid. SNAPSHOTTED onto each
   * subscription at create time (`Subscription.graceDays`), so changing this
   * never retroactively shortens a window a customer already signed up under.
   */
  SUBSCRIPTION_GRACE_DAYS: z.string().default('7').transform(Number),
  /**
   * How early the renewal invoice is raised. The rail does not auto-renew, so
   * this lead time is the customer's entire window to pay before the period
   * ends — it must comfortably exceed the time a crypto transfer takes to
   * arrange, not merely to confirm.
   */
  SUBSCRIPTION_RENEWAL_LEAD_DAYS: z.string().default('7').transform(Number),
  /** The lifecycle sweep: renewals, lapses, grace expiry, scheduled plan changes. */
  SUBSCRIPTION_SWEEP_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  SUBSCRIPTION_SWEEP_INTERVAL_MS: z.string().default('3600000').transform(Number), // 1h
  /**
   * The lost-webhook backstop: re-fetches payments the rail knows about that we
   * never finished applying. Runs far more often than the sweep because the
   * window it covers is "a customer has paid and does not have their plan".
   */
  PAYMENT_RECONCILE_INTERVAL_MS: z.string().default('900000').transform(Number), // 15m

  // External data sources
  /**
   * The ONE indexer URL per chain — feeds positions, position transactions,
   * pool stats, charts AND all token pricing (current via SubgraphCurrentProvider
   * and historical via SubgraphHistoricalProvider, both reading
   * `integration.subgraphUrl`). There is NO separate `*_HISTORICAL_SUBGRAPH_URL`
   * — we price live off one deployment. (For v4, valuation is
   * current-price only — historical pricing is never invoked.)
   *
   * It is the Envio indexer, not a The Graph deployment; `validateRegistries`
   * refuses a `gateway.thegraph.com` URL outright.
   */
  ETHEREUM_UNISWAP_V3_SUBGRAPH_URL: optionalUrl,
  // Shared default for every v4 chain; per-chain keys below still override it.
  UNISWAP_V4_INDEXER_URL: optionalUrl,
  UNISWAP_V4_INDEXER_DIALECT: subgraphDialect,
  ETHEREUM_UNISWAP_V4_SUBGRAPH_URL: optionalUrl,
  AVALANCHE_UNISWAP_V4_SUBGRAPH_URL: optionalUrl,
  ARBITRUM_UNISWAP_V4_SUBGRAPH_URL: optionalUrl,
  ROBINHOOD_UNISWAP_V4_SUBGRAPH_URL: optionalUrl,
  /*
   * Which dialect each `*_SUBGRAPH_URL` speaks. Consumed by `buildIntegrations`
   * off `process.env` rather than from the parsed config, so these entries are
   * validation-only — but a typo'd VALUE fails in the SILENT direction (an
   * unconverted query against a Hasura endpoint, or vice versa, returns a
   * well-formed empty list), so `z.enum` makes it a boot failure instead. An
   * unrecognised dialect also throws in `buildIntegrations`.
   */
  ETHEREUM_UNISWAP_V4_SUBGRAPH_DIALECT: subgraphDialect,
  AVALANCHE_UNISWAP_V4_SUBGRAPH_DIALECT: subgraphDialect,
  ARBITRUM_UNISWAP_V4_SUBGRAPH_DIALECT: subgraphDialect,
  ROBINHOOD_UNISWAP_V4_SUBGRAPH_DIALECT: subgraphDialect,
  /*
   * The Ponder indexer, as a second source serving the same data. Per chain only:
   * Ponder runs one process per chain. Point it at the `/subgraph` route — the
   * root `/graphql` speaks Ponder's own dialect and fails every query.
   */
  ETHEREUM_UNISWAP_V4_PONDER_URL: optionalUrl,
  AVALANCHE_UNISWAP_V4_PONDER_URL: optionalUrl,
  ARBITRUM_UNISWAP_V4_PONDER_URL: optionalUrl,
  ROBINHOOD_UNISWAP_V4_PONDER_URL: optionalUrl,
  /*
   * Which indexers serve, in priority order: `envio`, `ponder`, `envio,ponder`
   * or `ponder,envio`. Fleet-wide, overridable per chain. Validation-only here
   * (`buildIntegrations` reads `process.env`), but an unknown name fails the boot
   * rather than silently dropping a source.
   */
  UNISWAP_V4_INDEXER_SOURCES: indexerSources,
  ETHEREUM_UNISWAP_V4_INDEXER_SOURCES: indexerSources,
  AVALANCHE_UNISWAP_V4_INDEXER_SOURCES: indexerSources,
  ARBITRUM_UNISWAP_V4_INDEXER_SOURCES: indexerSources,
  ROBINHOOD_UNISWAP_V4_INDEXER_SOURCES: indexerSources,
  // Failover tuning, read by `subgraph/indexer-failover.ts` (validated here).
  INDEXER_FAILOVER_COOLDOWN_MS: optionalNonNegativeInt,
  INDEXER_FAILOVER_PROBE_MS: optionalNonNegativeInt,
  INDEXER_FAILOVER_MAX_LAG_SECONDS: optionalNonNegativeInt,
  COINGECKO_API_KEY: z.string().optional(),

  // Positions sync
  POSITIONS_SYNC_CRON_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  // 30 min (was 5). Every refresh tick re-fetches every active position from
  // the indexer (~1.1k Envio requests per pass across chains) and rewrites it;
  // position changes already arrive through the live listener, so the cron
  // mostly re-prices. Lower it again once the refresh reprices from Mongo.
  POSITIONS_SYNC_INTERVAL_MS: z.string().default('1800000').transform(Number),
  // Obliterate positions-sync, positions-refresh and background-sweeps (every
  // job AND every repeatable) at boot. Default FALSE since 2026-10-03 (it was a
  // raw `process.env` read meaning "on unless the string 'false'"): wiping the
  // queue is what used to lose an in-flight backfill on every deploy. Boot no
  // longer needs it for hygiene — stale repeatables are removed by name, boot
  // kicks are de-duplicated, and an interrupted backfill is resumed from its
  // cursor either way. 'true' is a manual reset of a queue in a bad state.
  QUEUE_CLEAR_ON_BOOT: z.string().default('false').transform((v) => v === 'true'),

  // Pools sync. The pool-sync job rides the background-sweeps queue under the
  // 'pool-sync' job name (admin-triggered + repeatable). Default 6 h (was 1 h):
  // every run walks and rewrites every pool (~601k docs, ~12k Envio requests),
  // which was most of the M10's write load. Back to hourly once pool sync skips
  // unchanged writes and walks only referenced pools.
  POOLS_SYNC_CRON_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  POOLS_SYNC_INTERVAL_MS: z.string().default('21600000').transform(Number),
  // Token-security sweep (GoPlus) — decoupled background job, NEVER on the
  // resync hot path. Pages the indexer's token universe and rate-limit-checks
  // uncertain (non-anchor, non-allowlisted) tokens, persisting `verified`.
  TOKEN_SECURITY_SYNC_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  TOKEN_SECURITY_SYNC_INTERVAL_MS: z.string().default('21600000').transform(Number), // 6h
  // On-chain read of active positions' uncollected fees (StateView via
  // Multicall3), in tiers on a 60 s in-process tick — see the W5 block below.
  // Reads EVM_RPC_URLS: a chain is skipped until it has a URL
  // there. NOTE that list is also the payments accept-list (PAYMENT_TOKEN_REGISTRY
  // x EVM_RPC_URLS) — adding a chain with a registry token (e.g. 43114 USDC) also
  // turns its payments on, unless PAYMENT_ACCEPTED_TOKENS pins the accept-list.
  POSITION_FEE_REFRESH_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  // The BullMQ backstop that also pokes a tick (boot kick + this interval).
  POSITION_FEE_REFRESH_INTERVAL_MS: z.string().default('3600000').transform(Number), // 1h
  // Positions per Multicall3 request (2 eth_calls each, ~29k gas per position:
  // 200 ≈ 5.8M gas against a typical 50M eth_call cap). Keep it here.
  POSITION_FEE_BATCH_SIZE: z.string().default('200').transform(Number),
  // Concurrent Multicall3 requests per chain. 8 (was 4, 2026-10-03): measured
  // 8 × 200 in 1.7–2.7 s against one 200-batch in ~0.9 s, and a 2000-row page
  // is 10 batches, so 4 left the page loop waiting on RPC. The Dwellir
  // allowance is ACCOUNT-WIDE (500/s, shared with the indexer); one batch is
  // one eth_blockNumber + one eth_call.
  POSITION_FEE_CONCURRENCY: z.string().default('8').transform(Number),
  // Optional safety cap on addresses fed per sweep run. 0 = UNLIMITED (the
  // default): the sweep walks the WHOLE token universe in one run and lets the
  // GoPlus rate-limit backoff self-throttle, rather than dropping work. Set a
  // positive number only to bound a run for debugging.
  TOKEN_SECURITY_MAX_PER_RUN: z.string().default('0').transform(Number),
  // What the GoPlus sweep checks. `active` (default, 2026-10-02): the tokens of
  // ACTIVE positions, read from Mongo (two DISTINCT_SCANs, zero indexer
  // requests) — the set the leaderboard's spam filter actually has to judge.
  // `universe`: page the indexer's whole token universe (the old behaviour:
  // ~46k mainnet tokens, far more on 4663, hours of GoPlus rate-limit backoff
  // and an indexer walk on every run).
  TOKEN_SECURITY_SCOPE: z.enum(['active', 'universe']).default('active'),
  // Token-price sweep — decoupled background job that keeps every ACTIVE-
  // position token's current price fresh in `{chainId}_tokens`, so position
  // valuation reads a complete cache instead of depending on each sync's
  // provider luck (fixes real tokens flickering $0 on a provider miss).
  TOKEN_PRICE_SYNC_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  TOKEN_PRICE_SYNC_INTERVAL_MS: z.string().default('300000').transform(Number), // 5 min
  /**
   * Number of parallel time-bucket walkers during a `fromStart=true` backfill.
   * Each walker scans a non-overlapping slice of the position timestamp range
   * with its own pipelined cursor. Higher = faster, but more subgraph load.
   * Set to 1 to disable parallel buckets and use the serial cursor walk.
   */
  // 1 (was 4): on the hosted Envio endpoint parallel walkers each retry on
  // their own and trip the shared 1000 req/min limit (2026-09-14: 20 buckets
  // wrote 2.2% of mainnet before 429s; one serial walk did all 403k in ~11 min).
  POSITIONS_BACKFILL_BUCKETS: z.string().default('1').transform(Number),

  // Transactions sync. There is no standalone tx-sync cron — transaction sync
  // rides entirely on position backfill/refresh ticks (SyncService →
  // TransactionSyncService.syncTokenIdsFromPositionSync). These knobs gate the
  // shared enable flag, the reprice budget, and historical pricing.
  TRANSACTIONS_SYNC_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  TRANSACTIONS_SYNC_BATCH_SIZE: z.string().default('1000').transform(Number),
  /**
   * Parallel time-bucket count for the bulk transaction backfill (the
   * `fromStart` fast path — mirrors POSITIONS_BACKFILL_BUCKETS). Each bucket
   * walks a non-overlapping slice of the tx timestamp range. Higher = faster,
   * more subgraph + pricing pressure (bounded by TX_SYNC_GLOBAL_CONCURRENCY).
   */
  TRANSACTIONS_BACKFILL_BUCKETS: z.string().default('10').transform(Number),
  TRANSACTIONS_HISTORICAL_PRICING_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  /**
   * Recompute heal-sweep budget per refresh tick. After the source='none'
   * reprice scan, an additional N positions are walked via a rolling cursor
   * (no source filter), so `recomputeBatchPerformance`'s cache-bridge heal can
   * probe their txns for stale pool-ratio cache rows even on positions whose
   * txns are all already tagged 'historical'. Set 0 to disable the sweep.
   * Default 500; bump to drain the backlog faster, tighten to ease provider
   * rate-limit pressure.
   */
  HEAL_SWEEP_PER_TICK: z.string().default('500').transform(Number),
  /**
   * Chunk size for the heal sweep — positions are fed to
   * `recomputePerformanceForPositions` in batches of this many. Keeps each
   * cache-bridge probe + downstream pricing call bounded.
   */
  HEAL_SWEEP_CHUNK_SIZE: z.string().default('100').transform(Number),

  /**
   * Position-driven tx-sync knobs. Tx sync now rides on position
   * backfill/refresh ticks: every flushed position batch immediately enqueues
   * tx fetch + price + recompute for its tokenIds. These knobs bound the
   * per-flush concurrency + closed-position catch-up per refresh tick so the
   * combined load stays predictable.
   */
  POSITION_DRIVEN_TX_SYNC_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  POSITION_DRIVEN_TX_SYNC_CONCURRENCY: z.string().default('20').transform(Number),
  POSITION_DRIVEN_TX_SYNC_BATCH_SIZE: z.string().default('75').transform(Number),
  /**
   * Global ceiling on concurrent transaction-sync batches across ALL dispatches
   * (every backfill bucket + refresh + live-refresh share it). Caps total
   * simultaneous subgraph + pricing load so parallel backfill doesn't trip
   * provider rate-limit backoffs. Lower if a constrained connection still 429s.
   */
  TX_SYNC_GLOBAL_CONCURRENCY: z.string().default('10').transform(Number),

  // Live event listener
  LIVE_REFRESH_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  LIVE_POLL_INTERVAL_FALLBACK_MS: z.string().default('3000').transform(Number),
  // 3 s floor (was 500 ms): the 100 ms / 250 ms chains polled 120×/min each,
  // ~155–200 of Envio's 1000 req/min, for an indexer that lags head anyway.
  LIVE_POLL_MIN_MS: z.string().default('3000').transform(Number),
  LIVE_REFRESH_CONCURRENCY: z.string().default('100').transform(Number),
  /**
   * Max number of pending per-token live refresh jobs the scheduler will
   * coalesce into a single batched call. With BullMQ worker concurrency of
   * `LIVE_REFRESH_CONCURRENCY`, the scheduler caps real batches at the
   * smaller of these two values.
   */
  LIVE_REFRESH_BATCH_SIZE: z.string().default('100').transform(Number),
  /**
   * Max time the scheduler holds a partially-filled batch before flushing.
   * Lower = more responsive, more small batches; higher = better coalescing
   * under bursty load.
   */
  LIVE_REFRESH_FLUSH_MS: z.string().default('2000').transform(Number),

  // Pricing. Provider walk order (free aggregators first, PAID providers as
  // fallback for the long tail of CG-delisted / DEX-only tokens that free
  // sources miss or rate-limit, then pool-derived subgraph last). Paid
  // providers are keyed via ALCHEMY/MORALIS/CHAINBASE_API_KEY; free-first keeps
  // spend low (paid fires only on a free miss; the {chainId}_tokens cache bounds
  // repeats). `subgraph-current` is the pass-2 derivedETH fallback (gated to
  // trusted-market tokens); `subgraph-pool-ratio` MUST be last (needs anchors).
  PRICE_FALLBACK_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  PRICING_PROVIDERS: z.string().default('defillama,geckoterminal,dexscreener,coingecko,dia,alchemy,moralis,chainbase,subgraph-current,subgraph-historical,subgraph-pool-ratio'),

  // Token-listing trust gate (CoinGecko coins/list). A token is valued only if
  // CoinGecko lists it for the chain's platform ("real market only" pricing), so DeFiLlama's circular DEX-derived spam prices are zeroed.
  TOKEN_LISTING_GATE_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  TOKEN_LISTING_REFRESH_MS: z.string().default('86400000').transform(Number), // 24h
  TOKEN_LISTING_FETCH_TIMEOUT_MS: z.string().default('30000').transform(Number), // 2.6MB body

  // DEX-market value gate: a non-anchor/non-listed token's price counts as
  // value ONLY when a real ACTIVE on-chain DEX market corroborates it — the
  // consensus sweep recorded a DexScreener/GeckoTerminal source in `priceSources`
  // AND that market has real trading (24h volume ≥ DEX_MARKET_MIN_VOLUME_USD).
  // A symbol/FX-matched quote from a non-DEX aggregator (scam "EUR" at the €/$
  // fiat rate, "GOLDX" at the gold rate, "DTC" at $1) has NO DEX pair, and a
  // SEEDED/dead pool (BT77: $240M one-sided liquidity, $8/day volume) has a pair
  // but no real market — both → not valued. Fail-OPEN when no consensus record
  // exists yet so a freshly-discovered legit token is not under-valued.
  DEX_MARKET_GATE_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  // Minimum 24h DEX volume (USD) for a token's market to count as REAL/ACTIVE
  // (vs a dead seeded pool). Deliberately LOW so thin-but-traded real tokens
  // survive (RPC trades ~$1,296/day; a dead seeded pool like BT77 ~$8/day).
  DEX_MARKET_MIN_VOLUME_USD: z.string().default('50').transform(Number),
  // Minimum counter-side LIQUIDITY (USD) of a token's deepest DEX pair for that
  // market to count as REAL/ACTIVE (Layer 2). Wash volume is cheap to fake;
  // counter-side reserves are not — a seeded pool holds ~$10 of the quote token
  // (GPCG/USDC: $9.52) while a real-thin market holds orders more (RPC/USDC:
  // ~$11k). Probed live 2026-06-17: GPCG $9.52 vs RPC $10,980 vs Knicks $67k.
  // Counter UNKNOWN (e.g. GeckoTerminal supplies no counter signal) → not gated
  // (volume-only fallback) — never treat absent as 0. 0 disables.
  DEX_MARKET_MIN_COUNTER_LIQUIDITY_USD: z.string().default('1000').transform(Number),
  // Pool MARKET-EXISTENCE floor (USD), Layer 1 — provider-INDEPENDENT, no value
  // cap. A priced lower-trust (unverified/none) leg counts as value only when
  // the pool's REAL on-chain reference-side reserves (anchor/verified reserve ×
  // its trusted price) ≥ this floor. Kills seeded fantasy pools (USDC/GPCG holds
  // $24.84 of real USDC → leg $0) while keeping genuinely-backed pools at FULL
  // market value (USDC/RPC ~$11k, DHN/USDT ~$11.6k, Knicks/ETH ~$67k). The floor
  // is on the POOL's reserves (does a market exist), not the position's value.
  // Reserves unknown/corrupt for a lower-trust leg → fails CLOSED. 0 disables.
  MIN_REAL_MARKET_BACKING_USD: z.string().default('1000').transform(Number),
  // Fail CLOSED in the DEX-market value gate (Layer 3): a non-anchor/non-listed
  // leg whose DEX-market state is UNKNOWN (not yet swept) contributes $0 instead
  // of keeping its quote. A freshly-discovered non-listed token shows "price
  // unavailable" until the next consensus sweep (~5 min) confirms a real market.
  // Disable to revert to fail-OPEN during a sweep outage.
  DEX_MARKET_FAIL_CLOSED: z.string().default('true').transform((v) => v === 'true'),

  // ── Valuation fixes (docs/spam-and-pool-mismatch-2026-10-05.md) — every default = today ──
  // Read by src/pricing/token-trust.ts `trustPolicyOf` (duck-typed: the getter
  // NAMES below are the contract), PositionsRepository (`honeypotFeeFilter`)
  // and EnvioAdapter (`positionAmountsSource`).
  // Fix 1 — quote guard: drop provider quotes the provider dated older than
  // PRICE_QUOTE_MAX_AGE_MS, and DIA quotes with < PRICE_DIA_MIN_VOLUME_USD of
  // 24h volume, in the hot walk, the page walk and the consensus sweep.
  PRICE_QUOTE_GUARD: z.preprocess(blankIsUnsetLower, z.enum(['off', 'on']).default('off')),
  PRICE_QUOTE_MAX_AGE_MS: numberEnv('86400000'),
  PRICE_DIA_MIN_VOLUME_USD: numberEnv('1000'),
  // Fix 4 — token trust: `allowlist` = anchor || committed CoinGecko allowlist
  // (today); `earned` = anchor || a fresh verdict the consensus sweep earns
  // from market evidence. SHADOW=on stores the verdicts without using them.
  // `combined` = anchor || (allowlisted, with the pools sync's pool-price
  // cross-check applied to its pools) || a fresh earned verdict — the
  // allowlist keeps listed tokens a DEX market cannot vouch for (4663 stock
  // tokens, single-source by construction) while earned trust adds the real
  // tokens the committed list misses (BTC.b on Ethereum).
  TOKEN_TRUST_MODE: z.preprocess(blankIsUnsetLower, z.enum(['allowlist', 'earned', 'combined']).default('allowlist')),
  TOKEN_TRUST_SHADOW: z.preprocess(blankIsUnsetLower, z.enum(['off', 'on']).default('off')),
  // Emergency DENY (never anchors): `chainId:0x…` or bare `0x…` (every chain).
  TOKEN_TRUST_DENY: stringEnv(''),
  TOKEN_TRUST_MIN_POOLS: numberEnv('2'),
  TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD: numberEnv('10000'),
  TOKEN_TRUST_MIN_OUTSIDE_LIQUIDITY_USD: numberEnv('50000'),
  TOKEN_TRUST_DEEP_POOL_LIQUIDITY_USD: numberEnv('250000'),
  // Fix 2 — hide positions in static-fee ≥ 5% pools from ranked lists/counts.
  // NOTE: read-models/core/fields.ts also reads this variable directly
  // (trimmed, lower-cased, === 'on') to add the rank model's `fee` leaf — keep
  // this enum a subset of that rule (no 'true' / '1' aliases).
  HONEYPOT_FEE_FILTER: z.preprocess(blankIsUnsetLower, z.enum(['off', 'on']).default('off')),
  // Fix 2 exemption — a pool whose BOTH legs are config anchors (stables /
  // native / wrapped native / trusted majors) is never a honeypot-fee pool:
  // its fee is a real (if unusual) LP fee. Read by the pools sync's risky flag
  // (which applies the fee rule whatever HONEYPOT_FEE_FILTER says), the
  // positions filter and the impact report. Off = today.
  HONEYPOT_FEE_ANCHOR_EXEMPT: z.preprocess(blankIsUnsetLower, z.enum(['off', 'on']).default('off')),
  // DexScreener batch endpoint for current quotes. `latest` = today's
  // `/latest/dex/tokens/{addrs}`, which caps the WHOLE request at 30 pairs, so
  // a popular token (WAVAX) takes them all and the rest of the batch gets
  // nothing (live 2026-10-05: 30 Avalanche tokens → 30 pairs over 5 tokens).
  // `per-chain` = `/tokens/v1/{chain}/{addrs}`: one pair per token —
  // DexScreener's own activity-weighted pick among its base-side pairs, NOT
  // always the deepest (WETH: a $7.1M pool beside a $111M one) — so every
  // token in the batch is covered (same probe: 30 of 30), and a capped answer
  // no longer counts the tokens it left out as "covered".
  DEXSCREENER_BATCH_ENDPOINT: z.preprocess(blankIsUnsetLower, z.enum(['latest', 'per-chain']).default('latest')),
  // Chains whose Uniswap v4 pools DexScreener does not index (probed 2026-10-08:
  // Arbitrum 0 of 32 pool ids). A token DexScreener has no pair for there is NOT
  // known to lack a market, so its empty answer is not coverage: it never
  // becomes `dexActive:false`, and no token-pairs lookup is sent. Comma-separated
  // chain ids; `none` = DexScreener is trusted everywhere (the behaviour before
  // this knob); blank = the default.
  DEXSCREENER_BLIND_CHAINS: z.string().default('42161'),
  // Fix 3 — open positions' amounts from tick math instead of the indexer.
  POSITION_AMOUNTS_SOURCE: z.preprocess(blankIsUnsetLower, z.enum(['indexer', 'tickmath']).default('indexer')),
  // ── end valuation fixes ──

  /**
   * Max unique tokens per GraphQL query against the historical-price
   * subgraph. The Graph caps `first` at 1000 rows returned per page;
   * `SubgraphHistoricalProvider` paginates via `skip` if more rows match.
   */
  HISTORICAL_PRICE_SUBGRAPH_BATCH_SIZE: z.string().default('1000').transform(Number),
  /**
   * Secondary "nearest-hour" fallback window (in hours) for the subgraph
   * provider. When the primary `_in` query returns no `tokenHourData` row
   * for a (token, hour) pair, the provider re-queries the token across
   * `±N hours` and picks the row closest to the requested hour. Set to
   * 0 to disable. Default 12h covers low-volume tokens that don't trade
   * every hour.
   */
  HISTORICAL_PRICE_SUBGRAPH_NEAREST_WINDOW_HOURS: z.string().default('6').transform(Number),
  /**
   * Final fallback: for any (token, hour) pair still unmatched after primary
   * + nearest-window passes, the provider does a per-pair lookup of the
   * **latest row at-or-before the requested hour** (`first: 1, desc`). If
   * the returned row's age is within this many hours, accept its price.
   * Covers tokens whose latest subgraph row is older than the nearest
   * window (low-volume / sparsely-traded tokens). Set 0 to disable.
   */
  HISTORICAL_PRICE_SUBGRAPH_STALE_FALLBACK_HOURS: z.string().default('168').transform(Number),
  /**
   * Max parallel GraphQL requests to historical-price subgraphs. Gateway
   * tolerates 20+ concurrent requests without 429; tune down if you see
   * backoff in logs.
   */
  HISTORICAL_PRICE_SUBGRAPH_CONCURRENCY: z.string().default('20').transform(Number),
  /**
   * Per-provider call timeout (ms) used by the orchestrator. If a provider's
   * batched/single call doesn't return within this window, orchestrator
   * marks it backed-off via `markBackoff` and moves to the next provider.
   * Subsequent batches skip the backed-off provider until its window expires.
   */
  PRICING_PROVIDER_TIMEOUT_MS: z.string().default('30000').transform(Number),
  PRICING_MISS_TTL_MS: z.string().default(String(30 * 60 * 1000)).transform(Number),
  /**
   * Buckets within this many ms of `now` are NOT miss-cached. Reason:
   * subgraph indexing lag — a token may have traded an hour ago but the
   * `tokenHourData` row isn't visible yet. Without a grace window we'd
   * permanently miss-cache it. Default 24h covers typical indexing tail.
   */
  PRICING_MISS_INDEXING_GRACE_MS: z.string().default(String(24 * 60 * 60 * 1000)).transform(Number),
  ALCHEMY_API_KEY: z.string().optional(),
  MORALIS_API_KEY: z.string().optional(),
  CHAINBASE_API_KEY: z.string().optional(),

  // /health indexing-status badge: healthy→degraded lag threshold (blocks).
  // The chain head ("current" block) comes from DeFiLlama's keyless
  // block-by-timestamp endpoint — no RPC and no extra config.
  INDEXER_MAX_LAG_BLOCKS: z.string().default('250').transform(Number),

  // ── W3: indexer gateway + meter (src/subgraph/hyperindex/indexer-gateway.ts) ──
  // `observe` (default) only meters every indexer request by lane/job and drops
  // calls whose HTTP client hung up; `enforce` adds the per-URL token bucket,
  // strict lane priority, the in-flight cap, Retry-After pauses and timeouts.
  INDEXER_GATEWAY_MODE: z.preprocess(blankIsUnset, z.enum(['observe', 'enforce']).default('observe')),
  // Per upstream URL, per process. The hosted deployment allows ~1000/min.
  INDEXER_BUDGET_PER_MIN: z.string().default('900').transform(Number),
  // The share background lanes may use, so budget − this is always left for users.
  INDEXER_BACKGROUND_MAX_PER_MIN: z.string().default('600').transform(Number),
  // Calls in flight per process. P2.1: unset = the ROLE default (all 12 = today,
  // api 3, sync 6, fee/feeder 2 — common/process-role.ts ROLE_DEFAULTS); an
  // explicit value always wins.
  INDEXER_MAX_IN_FLIGHT: optionalNumberEnv,
  // Of INDEXER_MAX_IN_FLIGHT, slots only interactive requests may use. Unset =
  // the role default (all 4 = today, api 1, others 0); a role without
  // `http-api` ignores any reserve (every slot is a background slot).
  INDEXER_INTERACTIVE_RESERVED_IN_FLIGHT: optionalNumberEnv,
  // Total indexer budget of one /api or /v1 request: its retries stop at this
  // deadline, and (enforce mode) each call is timed out against what is left.
  INDEXER_INTERACTIVE_DEADLINE_MS: z.string().default('8000').transform(Number),
  // Per-call timeout for every non-interactive lane (enforce mode only).
  INDEXER_BACKGROUND_TIMEOUT_MS: z.string().default('30000').transform(Number),
  // ── end W3 ──

  // Provider HTTP concurrency. Defillama is the primary current+historical
  // source; bumping these increases bulk-fetch throughput at the cost of more
  // 429 risk. Ramp slowly under observation.
  PRICING_PROVIDER_MAX_CONCURRENCY: z.string().default('8').transform(Number),
  PRICING_HISTORICAL_SINGLE_CONCURRENCY: z.string().default('8').transform(Number),
  PRICING_PREFETCH_CHUNK_CONCURRENCY: z.string().default('4').transform(Number),

  // Pool-ratio derivation provider (subgraph TWAP fallback)
  PRICING_POOL_RATIO_PROVIDER_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  PRICING_POOL_RATIO_BATCH_SIZE: z.string().default('50').transform(Number),
  PRICING_POOL_RATIO_CONCURRENCY: z.string().default('10').transform(Number),
  PRICING_POOL_RATIO_MAX_LAG_SECONDS: z.string().default('86400').transform(Number),

  // ── W1: leaderboard / pools read path (src/common/cache/swr-cache.ts) ──
  // List counts stop here (`countDocuments` limit); a capped total is a floor
  // and the response says so with `pagination.totalCapped`.
  LEADERBOARD_COUNT_CAP: z.string().default('25000').transform(Number),
  // In-process byte budget for the per-shard leaderboard window cache.
  LEADERBOARD_CACHE_MAX_MB: z.string().default('64').transform(Number),
  // 60 s timer that keeps the dashboard's landing views warm. Off on a process
  // that serves no HTTP traffic.
  LEADERBOARD_WARMUP_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  // Also write the warmed views to Redis (`tw:lb:snap:v1:<deployment>:*`, gzip,
  // EX 300) and read them back at boot, so the landing page is warm right after
  // a deploy. Unset = on in production only: a dev backend pointed at a shared
  // Redis must not write into it by default (the keys are also namespaced by
  // NODE_ENV + Mongo host/database, so it could never serve them to prod).
  LEADERBOARD_SNAPSHOT_REDIS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true')),
  // ── end W1 ──

  // ── B: read-path staleness budget, deep pages, global read budget ──
  // The ONE staleness budget (the accepted trade-off: lists cached 15 s, data
  // at most ~45 s old). No unflagged list or count response is older; it also
  // caps the two windows below, the Redis snapshot EX and how long a page-ladder
  // rung is trusted. Anything older (a timeout fallback) is served only with
  // `stale: true` + `dataAsOf`.
  READ_STALENESS_BUDGET_MS: z.string().default('45000').transform(Number),
  // Positions + pools list windows, list counts and pool detail: fresh this
  // long, then served stale (one background refresh) until LEADERBOARD_LIST_STALE_MS.
  LEADERBOARD_LIST_FRESH_MS: z.string().default('15000').transform(Number),
  LEADERBOARD_LIST_STALE_MS: z.string().default('30000').transform(Number),
  // The landing-view warmup tick, and the age at which it re-reads a window.
  // The min age is optional: unset = the list fresh age (15 s), so a window is
  // re-read once it stops being fresh and never while it still is (10 s re-read
  // fresh windows: twice the Mongo work for the same ≤ 45 s guarantee).
  LEADERBOARD_WARMUP_INTERVAL_MS: z.string().default('10000').transform(Number),
  LEADERBOARD_WARMUP_MIN_AGE_MS: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v))),
  // The global Mongo read budget for every NON-page read (counts, deep-page
  // walks, window rescues, pool holder counts), in rows per second across all
  // processes (a Redis token bucket; per process when Redis is off). A read
  // reserves before it runs and waits for budget up to its own deadline.
  // 0 turns the budget off.
  READ_BUDGET_DOCS_PER_SEC: z.string().default('20000').transform(Number),
  READ_BUDGET_BURST_DOCS: z.string().default('20000').transform(Number),
  // Long deep-page walks (more than 1,000 rows from their start) at once, per process.
  LEADERBOARD_DEEP_WALK_CONCURRENCY: z.string().default('2').transform(Number),
  // How long a deep-page ladder rung is KEPT (clamped: the staleness budget –
  // 1 h). A rung older than the staleness budget is not trusted, but it can
  // still start a page that no trusted rung can reach within one request; that
  // page is served flagged `stale: true` + `dataAsOf` (its offsets are as old
  // as the rung) instead of being refused for its depth.
  LEADERBOARD_LADDER_MAX_AGE_MS: z.string().default('600000').transform(Number),
  // Share the read budget and the deep-page ladder through Redis
  // (`tw:rb:v1:*`, `tw:lad:v1:*`, every key with a TTL). Unset = on in
  // production only, like LEADERBOARD_SNAPSHOT_REDIS_ENABLED; off, each process
  // keeps its own.
  READ_PATH_REDIS_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true')),
  // `[alert] mongo.replication_lag` when a secondary's lag (from the driver's
  // own heartbeats, no extra query) exceeds this.
  MONGO_REPLICATION_LAG_ALERT_MS: z.string().default('10000').transform(Number),
  // ── end B ──

  // ── P-R: read models on Railway (src/read-models/, design tickwise-pr-design-2026-10-03) ──
  // Everything ships OFF. `off` = today's behaviour exactly (nothing loads, no
  // feeder, no Redis keys); `shadow` = build and maintain the models, serve
  // Mongo; `serve` = answer from the models (R2/R3; until then the same as
  // shadow). The per-model modes override READ_MODELS_MODE for one model.
  READ_MODELS_MODE: z.preprocess(blankIsUnset, z.enum(['off', 'shadow', 'serve']).default('off')),
  POOL_CATALOG_MODE: z.preprocess(blankIsUnset, z.enum(['off', 'shadow', 'serve']).optional()),
  RANK_ENGINE_MODE: z.preprocess(blankIsUnset, z.enum(['off', 'shadow', 'serve']).optional()),
  // In serve: the share of eligible requests the model answers (ramp 10 → 50 → 100).
  // Every numeric read-model var: blank = unset (its default), like the enums —
  // Railway allows empty values, and '' must never read as 0.
  READ_MODELS_SERVE_PERCENT: z.preprocess(blankIsUnset, z.string().default('100')).transform(Number),
  // auto | both | feeder | server | none. auto = both today (P2 maps PROCESS_ROLE).
  READ_MODELS_ROLE: z.preprocess(blankIsUnset, z.enum(['auto', 'both', 'feeder', 'server', 'none']).default('auto')),
  // The redis-models instance (noeviction, no persistence). Unset = REDIS_URL.
  REDIS_MODELS_URL: optionalUrl,
  // p1 = a degraded request takes today's P1 Mongo path. narrow = needs approval (D-2).
  READ_MODELS_DEGRADED_POLICY: z.preprocess(blankIsUnset, z.enum(['p1', 'narrow']).default('p1')),
  // Share of requests offered for a lane-A shadow check, and the hard cap across processes.
  READ_MODELS_SHADOW_SAMPLE: z.preprocess(blankIsUnset, z.string().default('0.05')).transform(Number),
  READ_MODELS_SHADOW_MAX_PER_MIN: z.preprocess(blankIsUnset, z.string().default('60')).transform(Number),
  // Pace of cold scans, shard scans and field backfills — a HARD ceiling of
  // 5000 docs/s (a larger value fails the boot). Own bucket; yields to user reads.
  READ_MODELS_SCAN_DOCS_PER_SEC: z
    .preprocess(blankIsUnset, z.string().default('5000'))
    .transform(Number)
    .refine((v) => Number.isFinite(v) && v > 0 && v <= 5000, 'READ_MODELS_SCAN_DOCS_PER_SEC must be 1–5000 (a hard ceiling)'),
  // Pace of the lane-B verification scan (0 = off), same ceiling.
  READ_MODELS_VERIFY_DOCS_PER_SEC: z
    .preprocess(blankIsUnset, z.string().default('500'))
    .transform(Number)
    .refine((v) => Number.isFinite(v) && v >= 0 && v <= 5000, 'READ_MODELS_VERIFY_DOCS_PER_SEC must be 0–5000 (a hard ceiling)'),
  READ_MODELS_GENERATION_MS: z.preprocess(blankIsUnset, z.string().default('2000')).transform(Number),
  // Full snapshot cadence; delta retention = 2 × this, never past the live manifest.
  READ_MODELS_SNAPSHOT_INTERVAL_MS: z.preprocess(blankIsUnset, z.string().default('300000')).transform(Number),
  // Abort a snapshot encode past this many ms (holder.ts `snapshotEncodeCapMs`;
  // never past half the 10-min chunk TTL used while a snapshot is written).
  // Unset/blank = 20 s, the former hard-coded cap. Clamped 5 s – 5 min. Raise it
  // above ~7.5M total rows (capacity plan: ~17 s at 6.5M rows, ~23 s at 8.8M).
  READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS: z.preprocess(blankIsUnset, z.string().default('20000')).transform(Number),
  // Model data older than this is NOT READY (between the staleness budget and this: flagged stale).
  READ_MODELS_MAX_LAG_MS: z.preprocess(blankIsUnset, z.string().default('120000')).transform(Number),
  READ_MODELS_READY_TIMEOUT_MS: z.preprocess(blankIsUnset, z.string().default('300000')).transform(Number),
  // Pass workers per process; 0 = everything in-thread (the feeder too).
  READ_MODELS_WORKERS: z.preprocess(blankIsUnset, z.string().default('2')).transform(Number),
  // Off-heap model cap per process (MB); 0 = derived from the cgroup limit.
  READ_MODELS_MAX_MB: z.preprocess(blankIsUnset, z.string().default('0')).transform(Number),
  // Rows reserved per positions table (C-cap, `read-models/capacity.ts`):
  // 0 = none (1.5 × loaded); a plain number = every positions table (as
  // before); `chainId:rows,…` = only those chains' tables. Garbage fails the boot.
  READ_MODELS_POSITIONS_CAPACITY: z.preprocess(blankIsUnset, z.string().default('0')).transform((raw, ctx) => {
    const parsed = parsePositionsCapacity(raw);
    if ('error' in parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
      return z.NEVER;
    }
    return parsed.value;
  }),
  // The EXPECTED oplog window (the app cannot read local.oplog.rs on Atlas):
  // the boot probe starts a stream half of it back and refuses to run the
  // feeder when that fails; the resume-age alert fires at half of it.
  READ_MODELS_OPLOG_WINDOW_HINT_MS: z.preprocess(blankIsUnset, z.string().default('10800000')).transform(Number),
  // Durable copy of every 6th snapshot set (file://<dir> only in this build; unset = off).
  READ_MODELS_DURABLE_SNAPSHOT_URL: z.preprocess(blankIsUnset, z.string().optional()),
  // ── end P-R ──

  // ── C: Mongo client limits (src/database/database.module.ts) ──
  // The driver's name for this process in the server log, `currentOp` and
  // Atlas's connection view. Phase 2 sets one per role (tickwise-api, …-sync,
  // …-fee, …-feeder) so a slow op names the process that sent it.
  // P2.1: unset = `tickwise-backend` in role `all` (today), `tickwise-<role>`
  // in a split role.
  MONGO_APP_NAME: z.preprocess(blankIsUnset, z.string().optional()),
  // Connections per replica-set member (the driver keeps one pool per server).
  // 60 = the api's 20 + the worker's 40, the two pools this ONE process splits
  // into in Phase 2 (api 20, sync-worker 40, fee-worker 20, feeder 5 — ≤ 150 a
  // member with api ×4). It was the driver default, 100.
  // P2.1: unset (or garbage) = the ROLE default — all 60 (today), api 12,
  // sync 30, fee 15, feeder 5.
  MONGO_MAX_POOL_SIZE: optionalNumberEnv,
  // How long an operation waits for a free connection before it fails with
  // `MongoWaitQueueTimeoutError` (a user read then answers like a `maxTimeMS`
  // timeout: stale fallback or 503 + Retry-After). It was unbounded. 10 s for
  // the all-in-one process, which hosts the api AND the workers; Phase 2: api
  // 2 s, workers 30 s.
  // P2.1: unset (or 0 / garbage) = the ROLE default — all 10 s (today), api
  // 2 s, workers 30 s.
  MONGO_WAIT_QUEUE_TIMEOUT_MS: optionalNumberEnv,
  // Mongoose autoIndex on the SHARD collections (positions, position
  // transactions, pools). Unset = OFF in production, on elsewhere: there an
  // index is built only by a script (`scripts/positions-index-migration.mjs`),
  // never by a boot on the M10 primary, and a rollback cannot rebuild an index
  // the script dropped. A shard collection that does not exist yet still gets
  // its declared indexes at boot (built against zero documents).
  MONGO_SHARD_AUTO_INDEX: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true')),
  // ── end C ──

  // ── W6: detail + charts input caches (src/charts/chart-inputs.service.ts) ──
  // In-process byte budget for the charts input cache (transaction lists, pool
  // and token day data, ticks, pool state), separate from the list cache's.
  CHART_CACHE_MAX_MB: z.string().default('64').transform(Number),
  // ── end W6 ──

  // ── W5: on-chain fee refresh tiers (src/sync/position-fee-refresh.service.ts) ──
  // Hot tier: in-range active positions worth at least this much are re-read
  // every POSITION_FEE_HOT_INTERVAL_MS (they are the ones accruing fees).
  POSITION_FEE_HOT_MIN_USD: z.string().default('50').transform(Number),
  // 0 = hot tier OFF (the default since 2026-10-03): the 45-min full pass
  // already re-reads every active position inside an hour, and a hot tier only
  // re-reads the same rows sooner at the full pass's expense. A positive value
  // (floored at 60 s) turns it back on; an `all` pass in progress for more than
  // half its interval is then served before it, so hot can never starve it.
  POSITION_FEE_HOT_INTERVAL_MS: z.string().default('0').transform(Number),
  // Full tier: one resumable pass over EVERY active position per this interval.
  // 45 min (was 1 h, 2026-10-03): the interval is measured start-to-start, so a
  // pass that takes a while still leaves no row's gap above an hour.
  POSITION_FEE_FULL_INTERVAL_MS: z.string().default('2700000').transform(Number), // 45 min
  // Positions measured per 60 s round across EVERY chain, dirty-set re-reads
  // included — the chains share it (a busy chain keeps a fair share, an idle
  // one's share goes to the others) and it ramps up from 25% over
  // POSITION_FEE_RAMP_MS after boot. 25000 (scale plan 1.9, 2026-10-03; was
  // 15000, and 8000 before that): ~338k actives today in a pass, plus the
  // dirty set. It is a READ ceiling — writes are paced separately by the two
  // per-second buckets below, which stay at 40 / 25, so a catch-up pass that
  // writes a large share of its rows is still write-bound.
  POSITION_FEE_MAX_PER_TICK: z.string().default('25000').transform(Number),
  // The read budget AND the write gate ramp from 25% to 100% over this long
  // after boot, so a deploy does not land as one burst. 5 min (it was a 30-min
  // constant, ~11 budget-minutes lost on every boot). 0 = no ramp.
  POSITION_FEE_RAMP_MS: z.string().default('300000').transform(Number), // 5 min
  // An identical re-read whose stored block is still valid (≥ lastModifyBlock)
  // is not written again until its stamp is this old, ±25% per position
  // (deterministic, from a hash of positionId) so restamps arrive spread out
  // instead of as one wave a day after a deploy. 24 h (was 6 h, 2026-10-03).
  // TRAP: 0 means ALWAYS WRITE — every re-read becomes a Mongo write.
  POSITION_FEE_RESTAMP_MS: z.string().default('86400000').transform(Number), // 24 h
  // Process-wide token buckets, shared by every chain, that pace the fee job's
  // Mongo writes per SECOND (bulkWrites of ≤100 ops, each waiting for tokens;
  // backpressure slows the page loop, writes are never dropped). Ramped with the
  // read budget for 30 min after boot. MAX_WRITES counts every fee write;
  // MAX_SERVED_WRITES counts the ones that also rewrite the served (indexed)
  // fields, which cost the most index maintenance.
  POSITION_FEE_MAX_WRITES_PER_SEC: z.string().default('40').transform(Number),
  POSITION_FEE_MAX_SERVED_WRITES_PER_SEC: z.string().default('25').transform(Number),
  // `[alert] fees.pass_overdue` once per pass still running after this long.
  POSITION_FEE_PASS_ALERT_MS: z.string().default('3000000').transform(Number), // 50 min
  // Positions opened in the detail view are re-read on-chain on the next tick
  // (5-min cooldown per position); at most this many per chain per tick. 0 = off.
  POSITION_FEE_VIEW_PER_TICK: z.string().default('200').transform(Number),
  // ── end W5 ──

  // ── P2.1: process roles + leases (src/common/process-role.ts) — every default = today ──
  // all (default: today's single process) | api | sync | fee | feeder. ONE
  // image; every side effect is gated by `can(capability)` at its start hook.
  PROCESS_ROLE: z.preprocess(blankIsUnsetLower, z.enum(['all', 'api', 'sync', 'fee', 'feeder']).default('all')),
  // auto (off in `all`, on in a split role) | on | off. `off` with a split role
  // refuses the boot (`[alert] process_role.no_leases`).
  PROCESS_LEASES: z.preprocess(blankIsUnsetLower, z.enum(['auto', 'on', 'off']).default('auto')),
  // Status fan-in (`tw:proc:v1:<ns>:…`). Unset = 10 000 whenever leases are on
  // (role `all` included), 0 (none) in `all` with leases off = today.
  PROCESS_STATUS_PUBLISH_MS: optionalNumberEnv,
  // > 1 only with WRITE_BUDGET_MODE=enforce (clamped to 1 otherwise); max 64.
  POSITIONS_REFRESH_QUEUE_CONCURRENCY: numberEnv('1'),
  // How long a backfill job re-delays while another process holds its flow lock.
  BACKFILL_HELD_MAX_WAIT_MS: numberEnv('2700000'),
  // ── end P2.1 ──

  // ── /api anti-scraping, Step 1 (src/common/api-rate-limit.guard.ts) — every default = today ──
  // off (today) | observe (count and log who WOULD be limited, never refuse) | enforce (429).
  API_LIMIT_MODE: z.preprocess(blankIsUnsetLower, z.enum(['off', 'observe', 'enforce']).default('off')),
  // memory (today) | redis: where the per-IP budgets live. Several replicas on memory = N× the limit; use redis then.
  API_LIMITER_STORE: z.preprocess(blankIsUnsetLower, z.enum(['memory', 'redis']).default('memory')),
  // Placeholders: the real values come from observe-mode data (5–10× the heaviest real visitor).
  API_LIMIT_POINTS_10S: numberEnv('100'),
  API_LIMIT_POINTS_HOUR: numberEnv('10000'),
  // Requests one IP may have running at once, per process.
  API_LIMIT_MAX_IN_FLIGHT: numberEnv('24'),
  // Count requests per IP per minute that may miss the count cache.
  API_LIMIT_COUNT_MISS_PER_MIN: numberEnv('3'),
  // (0, 1): the share of the global Mongo read budget keyless /api reads may take; 1 or unset = no bound (today).
  API_READ_SHARE: numberEnv('1'),
  // off (today) | on: GET /diag/client-ip echoes the caller's own address headers, to verify TRUST_PROXY_HOPS. Turn off again after.
  CLIENT_IP_ECHO: z.preprocess(blankIsUnsetLower, z.enum(['off', 'on']).default('off')),
  // ── end /api anti-scraping ──

  // ── P2.2: shared state in Redis (src/common/{limiter-factory,invalidation-bus,redis-gcra,rpc-budget}.ts) ──
  // memory (today) | redis: auth brute-force limiters fleet-wide; Redis down → per-process insurance.
  AUTH_LIMITER_STORE: z.preprocess(blankIsUnsetLower, z.enum(['memory', 'redis']).default('memory')),
  // off (today) | redis: API-key / origin / settings / plan cache invalidation across replicas.
  CACHE_INVALIDATION: z.preprocess(blankIsUnsetLower, z.enum(['off', 'redis']).default('off')),
  // process (today) | shared: ONE Envio token budget for the fleet (INDEXER_GATEWAY_MODE=enforce only).
  INDEXER_BUDGET_SCOPE: z.preprocess(blankIsUnsetLower, z.enum(['process', 'shared']).default('process')),
  // (0, 1]: the share of the budget a process takes alone while Redis is down. Unset = role default.
  INDEXER_BUDGET_LOCAL_SHARE: optionalNumberEnv,
  // 0 = off (today): the backend's share of the Dwellir ACCOUNT's req/s (prod 300, D-4).
  RPC_BUDGET_PER_SEC: numberEnv('0'),
  // host=account,… — every host not listed = account `default` (all chains share one bucket).
  RPC_ACCOUNT_MAP: stringEnv(''),
  // The backend's monthly share of the Dwellir quota ([alert] rpc.month_50/75/90).
  RPC_MONTHLY_CAP: numberEnv('150000000'),
  // ── end P2.2 ──

  // ── P2.3: skip unchanged position writes (src/database/position-write-hash.ts) ──
  // on (default since 2026-10-07) | shadow (decide + count, write every row + wh/wAt) | off (every row, every time).
  // The three defaults belong together: `on` alone skips only the rows that
  // hold no value, because the exact age moves APR and the ETH price moves gas
  // in USD on every valued row each cycle. Rollback: POSITIONS_WRITE_SKIP=off.
  POSITIONS_WRITE_SKIP: z.preprocess(blankIsUnsetLower, z.enum(['off', 'shadow', 'on']).default('on')),
  // bucket (default): APR from the age in ≤ 1 % / ≤ 6 h steps | refresh: the exact age.
  POSITIONS_WRITE_SKIP_AGE: z.preprocess(blankIsUnsetLower, z.enum(['refresh', 'bucket']).default('bucket')),
  POSITIONS_WRITE_SKIP_TOLERANCE: z.preprocess(blankIsUnsetLower, z.enum(['exact', 'material']).default('exact')),
  // full-write (default): gas re-valued at the current ETH price on full writes only | always: on every write.
  POSITIONS_GAS_REVALUE: z.preprocess(blankIsUnsetLower, z.enum(['always', 'full-write']).default('full-write')),
  // A full write at least this often (±25 % per position). Below 60 000 (or
  // garbage) reads as the default — never a boot failure.
  POSITIONS_FORCED_REWRITE_MS: numberEnv('21600000'),
  POSITIONS_FORCED_REWRITE_ZERO_MS: numberEnv('86400000'),
  // ── end P2.3 ──

  // ── P2.4: ONE shared write budget (src/common/write-budget*.ts) — same value on every service ──
  WRITE_BUDGET_MODE: z.preprocess(blankIsUnsetLower, z.enum(['off', 'observe', 'enforce']).default('off')),
  WRITE_BUDGET_UNITS_PER_SEC: stringEnv('300'),
  WRITE_BUDGET_MIN: stringEnv('100'),
  WRITE_BUDGET_MAX: stringEnv('450'),
  // Unset = 0.5 × MAX; above that only with MONGO_MONITOR_URI (else clamped; D-6).
  WRITE_BUDGET_HOURLY_UNITS_PER_SEC: z.preprocess(blankIsUnset, z.string().optional()),
  WRITE_BUDGET_SHARES: stringEnv('live:10,fee:25,refresh:30,backfill:25,pools:5,other:5'),
  WRITE_BUDGET_READ_UNIT: stringEnv('0.15'),
  WRITE_BUDGET_UNIT_LATENCY_RED_MS: stringEnv('2'),
  WRITE_BUDGET_LATENCY_RED_MS: stringEnv('150'),
  WRITE_BUDGET_LAG_RED_MS: stringEnv('5000'),
  WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR: stringEnv('100'),
  WRITE_BUDGET_LOCAL_DIVISOR: stringEnv('3'),
  // Read-only clusterMonitor (+ read on `local`) user: dirty % and the oplog window.
  MONGO_MONITOR_URI: z.preprocess(blankIsUnset, z.string().optional()),
  // 0 = unbounded (today); 500 in rollout; never above 500 while the budget is on.
  MONGO_BULK_WRITE_MAX_OPS: stringEnv('0'),
  // ── end P2.4 ──

  // ── Usage writes of metered /v1 calls (src/billing/usage-flush.service.ts) — default = today ──
  // direct (default) = today: one updateOne per usage snapshot + one per
  // usage_buckets row per metered request. batched = HINCRBY into redis-state
  // (REDIS_URL); ONE flusher (lease `usage-flush` with leases on) bulkWrites
  // every USAGE_FLUSH_INTERVAL_MS; portal/admin usage reads then trail by up to
  // one interval. drain = the rollback step (producers direct, the flusher
  // empties the buffer): batched → drain → direct. Any other value refuses the boot.
  USAGE_WRITE_MODE: z.preprocess(blankIsUnsetLower, z.enum(['direct', 'batched', 'drain']).default('direct')),
  // Flush period; garbage / ≤ 0 = 10 000; clamped 1 s – 5 min.
  USAGE_FLUSH_INTERVAL_MS: numberEnv('10000'),
  // ── end usage writes ──

  // ── P2.5 / P3.1: backfill throughput (src/sync/backfill-profile.ts) — every default = today ──
  BACKFILL_PAGING: z.preprocess(blankIsUnsetLower, z.enum(['offset', 'tokenid']).default('offset')),
  BACKFILL_PIPELINE: z.preprocess(blankIsUnsetLower, z.enum(['off', 'on']).default('off')),
  BACKFILL_LOOKAHEAD_PAGES: numberEnv('0'),
  BACKFILL_PRICE_WAIT_MS: numberEnv('5000'),
  BACKFILL_FEE_READ: z.preprocess(blankIsUnsetLower, z.enum(['off', 'on']).default('off')),
  PRICE_MISS_LEDGER: z.preprocess(blankIsUnsetLower, z.enum(['off', 'on']).default('off')),
  GECKOTERMINAL_BUDGET: z.preprocess(blankIsUnsetLower, z.enum(['off', 'local', 'shared']).default('off')),
  // (0, 1]: the per-process share of the 30/min GT budget on the local bucket. Unset = role default.
  GECKOTERMINAL_LOCAL_SHARE: optionalNumberEnv,
  // ── end P2.5 ──

  // ── P3.2 / P3.3: fee pass ≤ 10 min (src/sync/fee-measurer.ts) — every default = today ──
  POSITION_FEE_BATCH_SIZE_BY_CHAIN: stringEnv(''),
  POSITION_FEE_CONCURRENCY_BY_CHAIN: stringEnv(''),
  POSITION_FEE_MAX_IN_FLIGHT: numberEnv('64'),
  POSITION_FEE_HEAD_PER: z.preprocess(blankIsUnsetLower, z.enum(['batch', 'page']).default('batch')),
  POSITION_FEE_BUDGET: z.preprocess(blankIsUnsetLower, z.enum(['round', 'per-chain']).default('round')),
  POSITION_FEE_PASS_TARGET_MS: numberEnv('480000'),
  POSITION_FEE_CANDIDATES: z.preprocess(blankIsUnsetLower, z.enum(['mongo', 'memory']).default('mongo')),
  POSITION_FEE_LOAD_DOCS_PER_SEC: numberEnv('5000'),
  POSITION_FEE_RECONCILE_MS: numberEnv('21600000'),
  POSITION_FEE_RECONCILE_DOCS_PER_SEC: numberEnv('3000'),
  FEE_SIGNALS_TRANSPORT: z.preprocess(blankIsUnsetLower, z.enum(['auto', 'memory', 'redis']).default('auto')),
  // ── end P3 ──

  // Test mode
  TEST_MODE: z.string().default('false').transform((v) => v === 'true'),
  TEST_MODE_POSITION_LIMIT: z.string().default('20000').transform(Number),
});

export type RuntimeConfig = z.infer<typeof configSchema>;

@Injectable()
export class AppConfigService {
  private readonly config: RuntimeConfig;
  private readonly integrations: IntegrationConfig[];
  /** P2.1: role + leases, resolved once (a split role with leases off refused the boot). */
  private readonly roleSettings: ProcessRoleSettings;
  private writeBudgetMemo?: WriteBudgetSettings;

  constructor() {
    const parsed = configSchema.safeParse(process.env);
    if (!parsed.success) {
      console.error('positions-backend config validation failed');
      console.error(parsed.error.format());
      throw new Error('Invalid positions-backend configuration');
    }

    this.config = parsed.data;
    // P2.1: a split role with PROCESS_LEASES=off is refused here too
    // (`[alert] process_role.no_leases`) — main.ts calls `configureProcessRole`
    // with the same env before Nest builds a provider; this covers any other
    // entry point (scripts, specs) that builds the config.
    this.roleSettings = resolveProcessRoleSettings({ role: this.config.PROCESS_ROLE, leases: this.config.PROCESS_LEASES });
    /*
     * The DISABLED rows are logged, not silently dropped.
     *
     * `enabled` is `Boolean(subgraphUrl)`, and a row with no url is a legitimate
     * state — it is how a chain is staged dark. But it is also what a typo'd env
     * key produces (`ARBITRUM_UNISWAP_V4_SUBGRPAH_URL=...`), and that outcome is
     * indistinguishable from the deliberate one: the app boots clean, /health
     * shows two healthy chains instead of three, `/v1/chains` quietly drops one,
     * and nothing anywhere says a chain stopped existing. One line per dropped row
     * naming the env var it looked for is the whole fix.
     */
    const declared = buildIntegrations(process.env);
    for (const integration of declared) {
      if (!integration.enabled) {
        console.warn(
          `[config] integration ${integration.chainId}:${integration.protocol} is DISABLED — ` +
            `it has neither a *_SUBGRAPH_URL (Envio) nor a *_PONDER_URL (Ponder) for the sources ` +
            `it is allowed to use. Intentional for a chain being staged dark; if it is not, ` +
            `check the env keys for a typo.`,
        );
        continue;
      }
      // One line per chain naming who serves it, so a failover setup is visible
      // in the boot log rather than only discovered during an outage.
      const sources = integration.sources ?? [];
      console.log(
        `[config] integration ${integration.chainId}:${integration.protocol} indexer: ` +
          sources.map((s, i) => `${s.kind}${i === 0 ? ' (primary)' : ' (fallback)'}`).join(' → '),
      );
      for (const source of sources) {
        if (source.kind !== 'ponder') continue;
        let path = '';
        try {
          path = new URL(source.url).pathname.replace(/\/+$/, '');
        } catch {
          // optionalUrl already rejected an unparseable url.
        }
        if (!path.endsWith('/subgraph')) {
          console.warn(
            `[config] integration ${integration.chainId}:${integration.protocol}: the Ponder url does not end ` +
              `in /subgraph. The backend speaks the subgraph dialect, which Ponder serves only on that route.`,
          );
        }
      }
    }
    this.integrations = declared.filter((integration) => integration.enabled);
    this.validateRegistries();
    this.validateSecurity();
  }

  /**
   * Fail fast in production on insecure auth defaults. The dev fallback JWT
   * secret must never sign real admin sessions.
   */
  private validateSecurity(): void {
    if (this.config.NODE_ENV !== 'production') return;
    if (this.config.JWT_SECRET === DEFAULT_JWT_SECRET || this.config.JWT_SECRET.length < 16) {
      throw new Error('JWT_SECRET must be set to a strong (>=16 char) value in production');
    }
    if (
      this.config.CUSTOMER_JWT_SECRET === DEFAULT_CUSTOMER_JWT_SECRET ||
      this.config.CUSTOMER_JWT_SECRET.length < 16
    ) {
      throw new Error('CUSTOMER_JWT_SECRET must be set to a strong (>=16 char) value in production');
    }
    // Two realms, two secrets. Pasting the admin secret here would let a
    // customer token verify against the admin guard the moment any single
    // `typ` check is forgotten — reject it at boot rather than at breach time.
    if (this.config.CUSTOMER_JWT_SECRET === this.config.JWT_SECRET) {
      throw new Error('CUSTOMER_JWT_SECRET must differ from JWT_SECRET in production');
    }
    // The legacy `x-admin-secret` ops routes (`/admin/sync/*`)
    // authenticate on this value ALONE. An unset one
    // used to leave them wide open — and the Dockerfile sets NODE_ENV=production
    // with no ADMIN_SECRET, so the shipped image booted that way. Refuse to boot
    // rather than serve an unauthenticated full-rescan trigger.
    const adminSecret = this.config.ADMIN_SECRET ?? '';
    if (adminSecret === DEFAULT_ADMIN_SECRET || adminSecret.length < 16) {
      throw new Error('ADMIN_SECRET must be set to a strong (>=16 char) value in production');
    }
    // Customer SSO. The OAuth `redirect_uri` is built from OAUTH_CALLBACK_BASE_URL
    // and the browser is then bounced to PORTAL_BASE_URL carrying a freshly minted
    // customer token — an `http` origin puts that token on the wire in clear, and a
    // `localhost` one is an open-redirect / token-leak target (anything listening
    // on the victim's own machine receives it). Both are refused before a single
    // provider goes live; a misconfigured prod boot beats a leaked session.
    if (this.configuredOauthProviders.length > 0) {
      // OAuth-only, and correctly so: `OAUTH_CALLBACK_BASE_URL` builds the
      // provider `redirect_uri` and is read nowhere else, so a deployment with no
      // provider configured has no callback to protect.
      assertPublicHttpsOrigin('OAUTH_CALLBACK_BASE_URL', this.oauthCallbackBaseUrl);
    }
    // PORTAL_BASE_URL is asserted WIDER than the OAuth gate, because it has more
    // readers than OAuth.
    //
    // It used to be checked only when a provider was configured, yet
    // `siwe.service.ts` reads `portalBaseUrl` UNCONDITIONALLY to compose the
    // EIP-4361 message, and `CustomerAuthService.passwordResetUrl` builds the
    // emailed reset link from it. So a wallet-only production deployment — no
    // OAuth provider at all, which is a supported configuration — asked people to
    // SIGN a message naming `http://localhost:3011` as the site, and mailed reset
    // links pointing there. The first trains users to sign whatever we show them;
    // the second is a reset flow whose links are simply dead.
    //
    // Kept as one assertion per URL rather than folded together: the two are read
    // by different subsystems and a future reader has to be able to tell which
    // condition covers which.
    // Widened AGAIN, and for the third distinct reader: `SubscriptionsService`
    // builds the checkout `successUrl` / `cancelUrl` from `portalBaseUrl` and
    // hands them to the payment rail, and the billing emails link to it. A
    // localhost value there sends a paying customer to their own machine after
    // they have parted with money. Gated on WHO READS THE VALUE, as ever — so
    // this is the checkout rail being live, not "payments exist".
    if (
      this.configuredOauthProviders.length > 0 ||
      this.config.WALLET_LOGIN_ENABLED ||
      this.paymentsCheckoutConfigured
    ) {
      assertPublicHttpsOrigin('PORTAL_BASE_URL', this.portalBaseUrl);
    }

    // The fake rail grants entitlement for nothing. `FakePaymentProvider`
    // already refuses to register in production regardless of the flag, so this
    // cannot be the only guard — it is here so an operator who set the flag
    // finds out at boot rather than wondering why the rail never appears.
    if (this.config.PAYMENTS_FAKE_ENABLED) {
      throw new Error(
        'PAYMENTS_FAKE_ENABLED must not be set in production — the fake rail grants paid plans with no payment.',
      );
    }


    // ── The x402 rail's treasury ──────────────────────────────────────────
    //
    // No key material lives here at all, which is the point of the rail — but
    // there are two ways to get the ONE address wrong, and both are silent.
    //
    // GATED ON THE VALUE BEING PRESENT, not on x402 being the DEFAULT rail. The
    // on-chain rail already needed exactly this correction: a rail is LIVE
    // whenever it is configured (the registry registers every configured rail,
    // and a renewal draws on whichever rail its subscription was opened with),
    // so keying a key-material check off `PAYMENTS_PROVIDER` leaves a private key
    // sitting unexamined in the environment of any deployment that merely has
    // x402 configured alongside another default.
    if (presentValue(this.config.X402_TREASURY_ADDRESS)) {
      const raw = presentValue(this.config.X402_TREASURY_ADDRESS) ?? '';
      // A 32-byte hex string is a PRIVATE KEY, not an address. Someone pasting
      // one here has put a spending key in the environment of an internet-facing
      // process — refuse loudly rather than reading it as "not a valid address",
      // which would send them looking for a typo instead of rotating a key.
      if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(
          'X402_TREASURY_ADDRESS looks like a PRIVATE KEY, not an address. This rail never needs the ' +
            "treasury's key — it only needs the address money is paid INTO. Rotate that key: it has " +
            'been in this process environment.',
        );
      }
      if (raw.trim().split(/\s+/).length >= 12) {
        throw new Error(
          'X402_TREASURY_ADDRESS looks like a SEED PHRASE. Set the treasury ADDRESS only — never a ' +
            'mnemonic on an internet-facing server.',
        );
      }
      // A typo'd checksum reads as "not configured" further up, so say so HERE
      // rather than leaving the operator to discover an inert rail: the address
      // is well-formed hex but its EIP-55 checksum is wrong, which for a mixed-
      // case address means a character was mistyped — and money sent to it is
      // unrecoverable.
      if (!this.x402TreasuryAddress) {
        throw new Error(
          'X402_TREASURY_ADDRESS is not a valid address. If it is mixed-case, its EIP-55 checksum does ' +
            'not match — that is a typo, and funds sent to a mistyped address are unrecoverable. ' +
            'Paste it again from your wallet.',
        );
      }

      // ── THE RELAYER KEY MUST NOT CONTROL THE TREASURY. ──
      //
      // The whole custody argument for this rail is that the one key on the
      // server is gas-only. If the relayer key happens to BE the treasury's key,
      // that argument silently evaporates: a server compromise stops costing a
      // gas float and starts costing every dollar ever collected. It is an easy
      // mistake to make — reusing "the payments wallet" for both looks tidy —
      // and it is invisible in normal operation, because both roles work fine.
      const submitter = this.x402SubmitterPrivateKey;
      if (submitter) {
        const derived = privateKeyToAddress(submitter as `0x${string}`).toLowerCase();
        if (derived === this.x402TreasuryAddress) {
          throw new Error(
            'X402_SUBMITTER_PRIVATE_KEY is the TREASURY\'s key. The relayer only pays gas and must be a ' +
              'throwaway account — sharing the key means a server compromise drains everything you have ' +
              'collected instead of a few dollars of ETH. Generate a separate account for the relayer.',
          );
        }
      }
    }

    // The "rail is incomplete" refusal stays keyed to being the DEFAULT: a rail
    // merely configured-but-incomplete simply does not register (loud at boot via
    // the registry's alert, harmless), whereas the DEFAULT rail being unusable
    // means every upgrade attempt is refused and that should stop the boot.
    if (this.config.PAYMENTS_PROVIDER === 'x402') {
      const problem = this.x402ConfigProblem();
      if (problem) {
        throw new Error(`PAYMENTS_PROVIDER=x402 but the rail is incomplete: ${problem}`);
      }
    }

    // Radom's webhook authenticates on a STATIC SHARED KEY, so that key is the
    // entire boundary around an unauthenticated write path into the money code.
    // A short or placeholder value there is not a weak password, it is an open
    // endpoint that grants subscriptions.
    if (this.config.PAYMENTS_PROVIDER === 'radom' && this.radomApiKey) {
      const secret = this.radomWebhookSecret ?? '';
      if (secret.length < 16) {
        throw new Error(
          'RADOM_WEBHOOK_SECRET must be set to a strong (>=16 char) value in production — ' +
            'it is the only thing authenticating POST /webhooks/payments/radom.',
        );
      }
      if (this.radomWebhookSecretPrevious === secret) {
        throw new Error(
          'RADOM_WEBHOOK_SECRET_PREVIOUS equals RADOM_WEBHOOK_SECRET — a rotation to the same value ' +
            'rotates nothing. Unset the previous key once the rotation is complete.',
        );
      }
    }
    // The SIWE domain binding is the ONLY thing tying a signature to this site:
    // without it (or with a localhost placeholder) a signature the user produced
    // on some other dapp can be replayed against us as a login.
    if (this.config.WALLET_LOGIN_ENABLED) {
      const siweDomain = presentValue(this.config.SIWE_DOMAIN);
      if (!siweDomain) {
        throw new Error('SIWE_DOMAIN must be set in production when WALLET_LOGIN_ENABLED is true');
      }
      if (isLocalHostname(siweDomain)) {
        throw new Error('SIWE_DOMAIN must not be localhost in production — the domain binding is what stops signature replay');
      }
    }

    // Requiring a verification you cannot perform is a total signup outage, not
    // a stricter setting: the account is created, the guard 403s it out of the
    // portal, and the code that would clear it is never sent. Production also
    // refuses to log the code (deliberately), so the customer has no recovery
    // path at all and support cannot hand it to them.
    //
    // NARROWED now that `MailService` exists: the fatal combination is the flag
    // on AND no mailer, not the flag on. With RESEND_API_KEY + MAIL_FROM set,
    // prod boots and the code goes out by email. Both ways out are named because
    // this fires at boot, where the operator can act on either one.
    if (this.config.CUSTOMER_EMAIL_VERIFICATION_REQUIRED && !this.mailConfigured) {
      throw new Error(
        'CUSTOMER_EMAIL_VERIFICATION_REQUIRED is on but no mail transport is configured, ' +
          'so no customer could ever receive a code and every new signup would be locked out. ' +
          'Set RESEND_API_KEY and MAIL_FROM (both are required — a key with no verified sender ' +
          'cannot send), or set CUSTOMER_EMAIL_VERIFICATION_REQUIRED=false in production.',
      );
    }
  }

  // App / storage / auth
  get port(): number { return Number(this.config.PORT); }
  get trustProxyHops(): number { return Number(this.config.TRUST_PROXY_HOPS) || 0; }
  get customerEmailVerificationRequired(): boolean { return this.config.CUSTOMER_EMAIL_VERIFICATION_REQUIRED; }
  get nodeEnv(): string { return this.config.NODE_ENV; }
  get isProduction(): boolean { return this.config.NODE_ENV === 'production'; }
  get mongodbUri(): string { return this.config.MONGODB_URI; }
  get redisUrl(): string { return this.config.REDIS_URL; }
  get adminSecret(): string | undefined { return this.config.ADMIN_SECRET; }
  get jwtSecret(): string { return this.config.JWT_SECRET; }
  get jwtExpiresIn(): string { return this.config.JWT_EXPIRES_IN; }
  get customerJwtSecret(): string { return this.config.CUSTOMER_JWT_SECRET; }
  get customerJwtExpiresIn(): string { return this.config.CUSTOMER_JWT_EXPIRES_IN; }
  get adminEmail(): string | undefined { return this.config.ADMIN_EMAIL; }
  get adminPassword(): string | undefined { return this.config.ADMIN_PASSWORD; }
  get apiKeyHeader(): string { return this.config.API_KEY_HEADER; }
  get corsOrigins(): string[] {
    return this.config.CORS_ORIGINS
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // Mail (Resend)
  get resendApiKey(): string | undefined { return presentValue(this.config.RESEND_API_KEY); }
  get mailFrom(): string | undefined { return presentValue(this.config.MAIL_FROM); }
  get mailReplyTo(): string | undefined { return presentValue(this.config.MAIL_REPLY_TO); }

  /**
   * THE single answer to "can this backend send email?", read by `MailService`,
   * by the delivery path in `CustomerAuthService` and by the production boot
   * guard — so those three can never disagree.
   *
   * Requires BOTH halves and treats a blank value as absent (`presentValue`):
   * a key with no from-address cannot send, and a half-filled pair must degrade
   * to the console fallback rather than fail once per email.
   */
  get mailConfigured(): boolean { return Boolean(this.resendApiKey && this.mailFrom); }

  // Customer SSO (OAuth + wallet)
  get oauthGoogleClientId(): string | undefined { return presentValue(this.config.OAUTH_GOOGLE_CLIENT_ID); }
  get oauthGoogleClientSecret(): string | undefined { return presentValue(this.config.OAUTH_GOOGLE_CLIENT_SECRET); }
  get oauthGithubClientId(): string | undefined { return presentValue(this.config.OAUTH_GITHUB_CLIENT_ID); }
  get oauthGithubClientSecret(): string | undefined { return presentValue(this.config.OAUTH_GITHUB_CLIENT_SECRET); }
  get oauthCallbackBaseUrl(): string { return stripTrailingSlash(this.config.OAUTH_CALLBACK_BASE_URL); }
  get portalBaseUrl(): string { return stripTrailingSlash(this.config.PORTAL_BASE_URL); }
  get siweDomain(): string { return this.config.SIWE_DOMAIN.trim(); }
  get siweStatement(): string { return this.config.SIWE_STATEMENT; }
  get walletLoginEnabled(): boolean { return this.config.WALLET_LOGIN_ENABLED; }

  // ─── Payments ──────────────────────────────────────────────────────────────
  get paymentsProvider(): string { return this.config.PAYMENTS_PROVIDER.trim(); }
  get fakePaymentsEnabled(): boolean { return this.config.PAYMENTS_FAKE_ENABLED; }
  get radomApiKey(): string | undefined { return presentValue(this.config.RADOM_API_KEY); }
  get radomApiBaseUrl(): string { return stripTrailingSlash(this.config.RADOM_API_BASE_URL); }
  get radomWebhookSecret(): string | undefined { return presentValue(this.config.RADOM_WEBHOOK_SECRET); }
  get radomWebhookSecretPrevious(): string | undefined {
    return presentValue(this.config.RADOM_WEBHOOK_SECRET_PREVIOUS);
  }
  get radomCheckoutTtlMs(): number { return Math.max(0, this.config.RADOM_CHECKOUT_TTL_MS) || 0; }

  // ─── Native on-chain rail ──────────────────────────────────────────────────
  get paymentWatchIntervalMs(): number { return Math.max(5_000, this.config.PAYMENT_WATCH_INTERVAL_MS); }
  get paymentWatchBlockRange(): number { return Math.max(1, this.config.PAYMENT_WATCH_BLOCK_RANGE); }

  /**
   * The accepted-token list, parsed. THROWS on a malformed entry — see
   * `parseAcceptedTokens`; a payment method silently dropped by a typo is
   * discovered by a customer rather than by us.
   */
  /** Whether the accept-list is derived rather than explicitly configured. */
  get acceptedTokensAreDerived(): boolean {
    return this.config.PAYMENT_ACCEPTED_TOKENS.trim() === '';
  }

  get acceptedPaymentTokens(): PaymentToken[] {
    const explicit = this.config.PAYMENT_ACCEPTED_TOKENS.trim();
    if (explicit) return parseAcceptedTokens(explicit);

    // DERIVED: every registry token whose chain has an endpoint. A token we cannot
    // reach a node for could be offered and then never verified, relayed or
    // settled, so the endpoint list is the honest gate on what is payable.
    //
    // Order follows the registry's own insertion order, which makes
    // `selectToken`'s "first accepted" fallback deterministic rather than
    // dependent on how a Map happened to iterate.
    const rpc = this.evmRpcUrls;
    return Object.values(PAYMENT_TOKEN_REGISTRY).filter((token) => rpc.has(token.chainId));
  }

  /** `chainId=url` pairs. A chain absent here cannot be watched. */
  get evmRpcUrls(): Map<number, string> {
    const out = new Map<number, string>();
    for (const entry of this.config.EVM_RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)) {
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      const chainId = Number(entry.slice(0, eq).trim());
      const url = entry.slice(eq + 1).trim();
      if (Number.isInteger(chainId) && chainId > 0 && url) out.set(chainId, url);
    }
    return out;
  }

  /** Reorg budget for a chain. See `PAYMENT_MIN_CONFIRMATIONS`. */
  minConfirmationsFor(chainId: number): number {
    for (const entry of this.config.PAYMENT_MIN_CONFIRMATIONS.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [idRaw, nRaw] = entry.split('=').map((p) => p.trim());
      if (Number(idRaw) === chainId) {
        const n = Number(nRaw);
        if (Number.isInteger(n) && n >= 0) return n;
      }
    }
    const fallback = this.config.PAYMENT_MIN_CONFIRMATIONS_DEFAULT;
    return Number.isInteger(fallback) && fallback >= 0 ? fallback : 30;
  }

  /**
   * The treasury every x402 authorization pays into, lowercased.
   *
   * `undefined` when unset or not a valid address — a malformed value must read
   * as NOT CONFIGURED rather than being passed through, because it ends up inside
   * a signed struct and a signature naming a nonsense destination is a payment
   * the customer cannot make and we cannot receive.
   *
   * THE EIP-55 CHECKSUM IS ENFORCED when the operator supplies a mixed-case
   * address, and that check is the only thing standing between a one-character
   * typo and permanently unrecoverable funds. A hex-shape regex alone accepts
   * `…9535aC32` for `…9535aC31` — a real address nobody holds the key to — and
   * lowercasing then destroys the very evidence that would have caught it.
   * An all-lowercase or all-uppercase value carries no checksum to verify, so it
   * is accepted as-is (that is what EIP-55 says such a string means); mixed case
   * is a checksum, and a failing one is a typo.
   */
  get x402TreasuryAddress(): string | undefined {
    const raw = presentValue(this.config.X402_TREASURY_ADDRESS)?.trim();
    if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return undefined;
    const body = raw.slice(2);
    const isCaseless = body === body.toLowerCase() || body === body.toUpperCase();
    if (!isCaseless && !isAddress(raw, { strict: true })) return undefined;
    return raw.toLowerCase();
  }

  /**
   * The relayer key, normalised to `0x`-prefixed lowercase hex, or `undefined`.
   *
   * A malformed value reads as NOT CONFIGURED rather than being passed to viem:
   * the customer-submits fallback is a working deployment, so degrading to it
   * beats throwing on every relay attempt.
   */
  get x402SubmitterPrivateKey(): string | undefined {
    const raw = presentValue(this.config.X402_SUBMITTER_PRIVATE_KEY)?.trim();
    if (!raw) return undefined;
    const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
    return /^[0-9a-fA-F]{64}$/.test(hex) ? `0x${hex.toLowerCase()}` : undefined;
  }

  /** Signing-window length. Floored to a minute so a typo cannot make it instant. */
  get x402AuthorizationTtlMs(): number {
    const raw = this.config.X402_AUTHORIZATION_TTL_MS;
    return Number.isFinite(raw) && raw >= 60_000 ? Math.round(raw) : 1_800_000;
  }

  /**
   * Quote freshness window. Floored to an hour, and DEFAULTED GENEROUSLY: too
   * short here silently re-quotes a renewal on every page view, while too long
   * only means a stale amount is re-quoted a little later than ideal.
   */
  get x402QuoteTtlMs(): number {
    const raw = this.config.X402_QUOTE_TTL_MS;
    return Number.isFinite(raw) && raw >= 3_600_000 ? Math.round(raw) : 2_592_000_000;
  }

  /** Whether the x402 rail has everything it needs. See `x402ConfigProblem`. */
  get x402PaymentsConfigured(): boolean {
    return this.x402ConfigProblem() === null;
  }

  /**
   * WHY the x402 rail is not usable, as an operator sentence — or `null`.
   *
   * The checkout path
   * 503s with a clean customer message and logs THIS, so a half-configured rail
   * is diagnosable instead of surfacing as an opaque refusal.
   *
   * The RPC requirement is not pedantry here either — this rail needs a node to
   * verify each token's EIP-712 domain against the chain, and later to relay and
   * to watch. A token whose chain has no endpoint would be offered and then never
   * settle.
   */
  x402ConfigProblem(): string | null {
    if (!this.x402TreasuryAddress) {
      return presentValue(this.config.X402_TREASURY_ADDRESS)
        ? 'X402_TREASURY_ADDRESS is not a valid 0x address'
        : 'X402_TREASURY_ADDRESS is not set';
    }
    let tokens: PaymentToken[];
    try {
      tokens = this.acceptedPaymentTokens;
    } catch (err) {
      return `PAYMENT_ACCEPTED_TOKENS is invalid: ${(err as Error).message}`;
    }
    if (tokens.length === 0) {
      return this.config.PAYMENT_ACCEPTED_TOKENS.trim()
        ? 'PAYMENT_ACCEPTED_TOKENS is empty'
        : 'no accepted tokens — add an EVM_RPC_URLS entry for a chain the token registry covers ' +
          `(${[...new Set(Object.values(PAYMENT_TOKEN_REGISTRY).map((t) => t.chainId))].join(', ')})`;
    }
    const rpc = this.evmRpcUrls;
    const missing = [...new Set(tokens.filter((t) => !rpc.has(t.chainId)).map((t) => t.chainId))];
    if (missing.length > 0) {
      return `no EVM_RPC_URLS entry for chain(s) ${missing.join(', ')} — every accepted token's chain needs one`;
    }
    return null;
  }

  /**
   * Structural complaints about `EVM_RPC_URLS` — ADVISORY ONLY.
   *
   * Deliberately NOT part of `x402ConfigProblem()`. That method gates
   * `x402PaymentsConfigured`, so anything it returns switches the entire payment
   * rail off — `watchedChainIds()` returns `[]` and settlement stops — or throws
   * at boot when `PAYMENTS_PROVIDER=x402`. A typo warning must never carry that
   * blast radius, and the dangerous case is already covered by the caller's own
   * check: if an entry is mangled badly enough to drop a chain an accepted token
   * needs, `missing` catches it and fails for the right reason.
   *
   * A trailing or doubled comma is explicitly NOT reported: `evmRpcUrls` calls
   * `.filter(Boolean)` and has always tolerated it.
   *
   * Reports the ENTRY INDEX and never the value: these strings reach logs, and
   * an entry contains the provider API key.
   */
  evmRpcUrlWarnings(): string | null {
    const raw = this.config.EVM_RPC_URLS;
    if (!raw.trim()) return null;
    const seen = new Set<number>();
    const entries = raw.split(',').map((e) => e.trim());
    for (const [i, entry] of entries.entries()) {
      if (!entry) continue; // tolerated by the parser; not a problem
      const eq = entry.indexOf('=');
      if (eq <= 0) {
        return `EVM_RPC_URLS entry ${i + 1} has no "chainId=url" separator`;
      }
      const chainId = Number(entry.slice(0, eq).trim());
      if (!Number.isInteger(chainId) || chainId <= 0) {
        return `EVM_RPC_URLS entry ${i + 1} has a non-numeric chain id`;
      }
      if (seen.has(chainId)) {
        return `EVM_RPC_URLS lists chain ${chainId} more than once — the later entry silently wins`;
      }
      seen.add(chainId);
      const url = entry.slice(eq + 1).trim();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return `EVM_RPC_URLS entry ${i + 1} (chain ${chainId}) is not a valid url — if the endpoint contains a comma it was truncated by the separator`;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return `EVM_RPC_URLS entry ${i + 1} (chain ${chainId}) must be http(s), got ${parsed.protocol}`;
      }
    }
    return null;
  }

  /**
   * `TOKEN:NETWORK` pairs offered at Radom checkout. A malformed entry is
   * DROPPED rather than thrown on: this list only widens what a customer may
   * pay with, so a typo should cost that one method, not the boot.
   */
  get radomAcceptedMethods(): Array<{ token: string; network: string }> {
    return this.config.RADOM_ACCEPTED_METHODS.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [token, network] = entry.split(':').map((part) => part?.trim());
        return token && network ? { token, network } : undefined;
      })
      .filter((m): m is { token: string; network: string } => m !== undefined);
  }

  /**
   * Whether the rail named by `PAYMENTS_PROVIDER` actually has its credentials.
   *
   * Deliberately NOT "are payments enabled": it answers the question the prod
   * `PORTAL_BASE_URL` assertion needs — is anything going to build a checkout
   * return URL from it. `manual` has no credentials and mints no checkout, so
   * it is excluded; the fake rail is excluded because it never runs in prod.
   */
  get paymentsCheckoutConfigured(): boolean {
    switch (this.paymentsProvider) {
      case 'radom':
        return Boolean(this.radomApiKey && this.radomWebhookSecret);
      // BOTH self-custody rails count, and omitting them was a real gap. The
      // question this getter answers is "will anything build a customer-facing
      // URL from `PORTAL_BASE_URL`", and while neither crypto rail redirects a
      // browser, `SubscriptionsService.finishInvoice` builds success/cancel URLs
      // from it for every rail and `BillingMailService` puts it in every invoice
      // and dunning email. Left out, a production deployment selling on a crypto
      // rail could boot with the dev default and mail dead localhost links to
      // paying customers.
      case 'x402':
        return this.x402PaymentsConfigured;
      default:
        // `manual` mints no checkout; `fake` never runs in production.
        return false;
    }
  }

  /**
   * Money, minor units. Floored at 0 (exact payment required) and NaN-guarded —
   * a malformed value must tighten the rule, never widen it, because the
   * failure direction here is "grants a plan for less money than it costs".
   */
  get underpayToleranceMinor(): number {
    const raw = this.config.PAYMENTS_UNDERPAY_TOLERANCE_MINOR;
    return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  }

  get subscriptionGraceDays(): number { return Math.max(0, this.config.SUBSCRIPTION_GRACE_DAYS) || 0; }
  get subscriptionRenewalLeadDays(): number {
    return Math.max(0, this.config.SUBSCRIPTION_RENEWAL_LEAD_DAYS) || 0;
  }
  get subscriptionSweepEnabled(): boolean { return this.config.SUBSCRIPTION_SWEEP_ENABLED; }
  get subscriptionSweepIntervalMs(): number { return this.config.SUBSCRIPTION_SWEEP_INTERVAL_MS; }
  get paymentReconcileIntervalMs(): number { return this.config.PAYMENT_RECONCILE_INTERVAL_MS; }

  /**
   * The ONE source of truth for "which OAuth providers are live" — read by both
   * the public providers route and the provider registry, so a half-configured
   * provider can never be advertised by one and rejected by the other.
   */
  get configuredOauthProviders(): OauthProviderKey[] {
    const configured: OauthProviderKey[] = [];
    if (this.oauthGoogleClientId && this.oauthGoogleClientSecret) configured.push('google');
    if (this.oauthGithubClientId && this.oauthGithubClientSecret) configured.push('github');
    return configured;
  }

  /** Convenience read of the same source of truth for a raw route param. */
  isOauthProviderConfigured(provider: string): boolean {
    return this.configuredOauthProviders.includes(provider as OauthProviderKey);
  }

  // External data sources
  get coingeckoApiKey(): string | undefined { return this.config.COINGECKO_API_KEY; }
  get indexerMaxLagBlocks(): number { return this.config.INDEXER_MAX_LAG_BLOCKS; }

  // ── W3: indexer gateway + meter ──
  get indexerGatewayMode(): IndexerGatewayMode { return this.config.INDEXER_GATEWAY_MODE; }
  get indexerInteractiveDeadlineMs(): number {
    return Math.max(1_000, this.config.INDEXER_INTERACTIVE_DEADLINE_MS) || 8_000;
  }
  /** Applied once at boot (`main.ts` → `configureIndexerGateways`); clamping lives in the gateway. */
  get indexerGatewayConfig(): IndexerGatewayConfig {
    const defaults = roleDefaults(this.processRole);
    return {
      mode: this.indexerGatewayMode,
      budgetPerMin: this.config.INDEXER_BUDGET_PER_MIN,
      backgroundMaxPerMin: this.config.INDEXER_BACKGROUND_MAX_PER_MIN,
      // P2.1: unset = the role default (`all` = 12 / 4 = today); explicit wins.
      maxInFlight: this.config.INDEXER_MAX_IN_FLIGHT ?? defaults.indexerMaxInFlight,
      interactiveReservedInFlight: this.config.INDEXER_INTERACTIVE_RESERVED_IN_FLIGHT ?? defaults.indexerInteractiveReservedInFlight,
      interactiveTimeoutMs: this.indexerInteractiveDeadlineMs,
      backgroundTimeoutMs: this.config.INDEXER_BACKGROUND_TIMEOUT_MS,
      // P2.2 (enforce only): one fleet budget, and the share taken alone while Redis is down.
      scope: this.indexerBudgetScope,
      localShare: this.indexerBudgetLocalShare,
      servesInteractive: roleCan(this.processRole, 'http-api'),
    };
  }
  /** `INDEXER_BUDGET_SCOPE`: `process` (today) | `shared`. */
  get indexerBudgetScope(): 'process' | 'shared' { return this.config.INDEXER_BUDGET_SCOPE; }
  /** `INDEXER_BUDGET_LOCAL_SHARE` in (0, 1]; unset or out of range = the role default (`all` 1.0). */
  get indexerBudgetLocalShare(): number {
    const v = this.config.INDEXER_BUDGET_LOCAL_SHARE;
    return v !== undefined && Number.isFinite(v) && v > 0 && v <= 1 ? v : roleDefaults(this.processRole).indexerBudgetLocalShare;
  }
  // ── end W3 ──

  // Positions sync
  get positionsSyncCronEnabled(): boolean { return this.config.POSITIONS_SYNC_CRON_ENABLED; }
  get positionsSyncIntervalMs(): number { return this.config.POSITIONS_SYNC_INTERVAL_MS; }
  get positionsBackfillBuckets(): number { return Math.max(1, this.config.POSITIONS_BACKFILL_BUCKETS); }
  get queueClearOnBoot(): boolean { return this.config.QUEUE_CLEAR_ON_BOOT; }

  // Pools sync
  get poolsSyncCronEnabled(): boolean { return this.config.POOLS_SYNC_CRON_ENABLED; }
  get poolsSyncIntervalMs(): number { return this.config.POOLS_SYNC_INTERVAL_MS; }
  get tokenSecuritySyncEnabled(): boolean { return this.config.TOKEN_SECURITY_SYNC_ENABLED; }
  get tokenSecuritySyncIntervalMs(): number { return this.config.TOKEN_SECURITY_SYNC_INTERVAL_MS; }
  get positionFeeRefreshEnabled(): boolean { return this.config.POSITION_FEE_REFRESH_ENABLED; }
  get positionFeeRefreshIntervalMs(): number { return this.config.POSITION_FEE_REFRESH_INTERVAL_MS; }
  get positionFeeBatchSize(): number { return this.config.POSITION_FEE_BATCH_SIZE; }
  get positionFeeConcurrency(): number { return this.config.POSITION_FEE_CONCURRENCY; }
  get tokenSecurityMaxPerRun(): number { return this.config.TOKEN_SECURITY_MAX_PER_RUN; }
  get tokenSecurityScope(): 'active' | 'universe' { return this.config.TOKEN_SECURITY_SCOPE; }
  get tokenPriceSyncEnabled(): boolean { return this.config.TOKEN_PRICE_SYNC_ENABLED; }
  get tokenPriceSyncIntervalMs(): number { return this.config.TOKEN_PRICE_SYNC_INTERVAL_MS; }

  // Transactions sync (rides on position refresh ticks — no standalone cron)
  get transactionsSyncEnabled(): boolean { return this.config.TRANSACTIONS_SYNC_ENABLED; }
  get transactionsSyncBatchSize(): number { return this.config.TRANSACTIONS_SYNC_BATCH_SIZE; }
  get transactionsBackfillBuckets(): number { return Math.max(1, this.config.TRANSACTIONS_BACKFILL_BUCKETS); }
  get transactionsHistoricalPricingEnabled(): boolean { return this.config.TRANSACTIONS_HISTORICAL_PRICING_ENABLED; }
  get healSweepPerTick(): number { return Math.max(0, this.config.HEAL_SWEEP_PER_TICK); }
  get healSweepChunkSize(): number { return Math.max(1, this.config.HEAL_SWEEP_CHUNK_SIZE); }
  get positionDrivenTxSyncEnabled(): boolean { return this.config.POSITION_DRIVEN_TX_SYNC_ENABLED; }
  get positionDrivenTxSyncConcurrency(): number { return Math.max(1, this.config.POSITION_DRIVEN_TX_SYNC_CONCURRENCY); }
  get positionDrivenTxSyncBatchSize(): number { return Math.max(1, this.config.POSITION_DRIVEN_TX_SYNC_BATCH_SIZE); }
  get txSyncGlobalConcurrency(): number { return Math.max(1, this.config.TX_SYNC_GLOBAL_CONCURRENCY); }

  // Live event listener
  get liveRefreshEnabled(): boolean { return this.config.LIVE_REFRESH_ENABLED; }
  get livePollIntervalFallbackMs(): number { return this.config.LIVE_POLL_INTERVAL_FALLBACK_MS; }
  get livePollMinMs(): number { return this.config.LIVE_POLL_MIN_MS; }
  get liveRefreshConcurrency(): number { return this.config.LIVE_REFRESH_CONCURRENCY; }
  get liveRefreshBatchSize(): number { return Math.max(1, this.config.LIVE_REFRESH_BATCH_SIZE); }
  get liveRefreshFlushMs(): number { return Math.max(0, this.config.LIVE_REFRESH_FLUSH_MS); }

  // Pricing
  get priceFallbackEnabled(): boolean { return this.config.PRICE_FALLBACK_ENABLED; }
  get pricingProviders(): string { return this.config.PRICING_PROVIDERS; }
  get tokenListingGateEnabled(): boolean { return this.config.TOKEN_LISTING_GATE_ENABLED; }
  get tokenListingRefreshMs(): number { return Math.max(60_000, this.config.TOKEN_LISTING_REFRESH_MS); }
  get tokenListingFetchTimeoutMs(): number { return Math.max(5_000, this.config.TOKEN_LISTING_FETCH_TIMEOUT_MS); }
  get dexMarketGateEnabled(): boolean { return this.config.DEX_MARKET_GATE_ENABLED; }
  get dexMarketMinVolumeUsd(): number { return Math.max(0, this.config.DEX_MARKET_MIN_VOLUME_USD); }
  get dexMarketMinCounterLiquidityUsd(): number { return Math.max(0, this.config.DEX_MARKET_MIN_COUNTER_LIQUIDITY_USD); }
  get dexMarketFailClosed(): boolean { return this.config.DEX_MARKET_FAIL_CLOSED; }
  get minRealMarketBackingUsd(): number { return Math.max(0, this.config.MIN_REAL_MARKET_BACKING_USD); }
  // Valuation fixes (names are the contract `trustPolicyOf` / PositionsRepository / EnvioAdapter read).
  // Numbers follow `trustPolicyOf`'s own rules (garbage / out of range = the default).
  get priceQuoteGuard(): 'off' | 'on' { return this.config.PRICE_QUOTE_GUARD; }
  /** > 0, at least 1 minute; default 24 h. Also earned trust's (d) and its verdict lifetime. */
  get priceQuoteMaxAgeMs(): number { return Math.max(60_000, positiveOr(this.config.PRICE_QUOTE_MAX_AGE_MS, 86_400_000)); }
  /** ≥ 0 (0 disables the DIA volume check); default $1,000. */
  get priceDiaMinVolumeUsd(): number { return nonNegativeOr(this.config.PRICE_DIA_MIN_VOLUME_USD, 1_000); }
  get tokenTrustMode(): 'allowlist' | 'earned' | 'combined' { return this.config.TOKEN_TRUST_MODE; }
  get tokenTrustShadow(): 'off' | 'on' { return this.config.TOKEN_TRUST_SHADOW; }
  /** Raw deny list; `parseDenyList` (token-trust.ts) parses it and drops malformed entries. */
  get tokenTrustDeny(): string { return this.config.TOKEN_TRUST_DENY.trim(); }
  /** Integer ≥ 1; default 2. */
  get tokenTrustMinPools(): number { return Math.max(1, Math.floor(positiveOr(this.config.TOKEN_TRUST_MIN_POOLS, 2))); }
  /** ≥ 0; default $10,000 of counter-side liquidity for a pool to count toward (c). */
  get tokenTrustMinPoolLiquidityUsd(): number { return nonNegativeOr(this.config.TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD, 10_000); }
  /** ≥ 0 (0 disables the branch); default $50,000. */
  get tokenTrustMinOutsideLiquidityUsd(): number { return nonNegativeOr(this.config.TOKEN_TRUST_MIN_OUTSIDE_LIQUIDITY_USD, 50_000); }
  /** ≥ 0 (0 = strict "not one pool"); default $250,000. */
  get tokenTrustDeepPoolLiquidityUsd(): number { return nonNegativeOr(this.config.TOKEN_TRUST_DEEP_POOL_LIQUIDITY_USD, 250_000); }
  get honeypotFeeFilter(): 'off' | 'on' { return this.config.HONEYPOT_FEE_FILTER; }
  get honeypotFeeAnchorExempt(): 'off' | 'on' { return this.config.HONEYPOT_FEE_ANCHOR_EXEMPT; }
  get dexscreenerBatchEndpoint(): 'latest' | 'per-chain' { return this.config.DEXSCREENER_BATCH_ENDPOINT; }
  /** Chain ids on which DexScreener's empty answer proves nothing (`DEXSCREENER_BLIND_CHAINS`; garbage entries ignored). */
  get dexscreenerBlindChains(): ReadonlySet<number> {
    const raw = (this.config.DEXSCREENER_BLIND_CHAINS ?? '').trim();
    const text = raw === '' ? '42161' : raw;
    const out = new Set<number>();
    for (const part of text.split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
    return out;
  }
  get positionAmountsSource(): 'indexer' | 'tickmath' { return this.config.POSITION_AMOUNTS_SOURCE; }
  get pricingMissTtlMs(): number { return this.config.PRICING_MISS_TTL_MS; }
  get pricingProviderTimeoutMs(): number { return Math.max(500, this.config.PRICING_PROVIDER_TIMEOUT_MS); }
  get pricingMissIndexingGraceMs(): number { return this.config.PRICING_MISS_INDEXING_GRACE_MS; }
  get alchemyApiKeys(): string[] { return parseKeyList(this.config.ALCHEMY_API_KEY); }
  get moralisApiKeys(): string[] { return parseKeyList(this.config.MORALIS_API_KEY); }
  get chainbaseApiKeys(): string[] { return parseKeyList(this.config.CHAINBASE_API_KEY); }

  // Provider HTTP concurrency
  get pricingProviderMaxConcurrency(): number { return this.config.PRICING_PROVIDER_MAX_CONCURRENCY; }
  get pricingHistoricalSingleConcurrency(): number { return this.config.PRICING_HISTORICAL_SINGLE_CONCURRENCY; }
  get pricingPrefetchChunkConcurrency(): number { return this.config.PRICING_PREFETCH_CHUNK_CONCURRENCY; }

  // Historical-price subgraph provider (tokenHourDatas) tuning. The URL is the
  // single `integration.subgraphUrl` (no dedicated historical URL).
  get historicalPriceSubgraphBatchSize(): number { return Math.max(1, this.config.HISTORICAL_PRICE_SUBGRAPH_BATCH_SIZE); }
  get historicalPriceSubgraphConcurrency(): number { return Math.max(1, this.config.HISTORICAL_PRICE_SUBGRAPH_CONCURRENCY); }
  get historicalPriceSubgraphNearestWindowHours(): number { return Math.max(0, this.config.HISTORICAL_PRICE_SUBGRAPH_NEAREST_WINDOW_HOURS); }
  get historicalPriceSubgraphStaleFallbackHours(): number { return Math.max(0, this.config.HISTORICAL_PRICE_SUBGRAPH_STALE_FALLBACK_HOURS); }

  // Pool-ratio derivation provider
  get pricingPoolRatioProviderEnabled(): boolean { return this.config.PRICING_POOL_RATIO_PROVIDER_ENABLED; }
  get pricingPoolRatioBatchSize(): number { return this.config.PRICING_POOL_RATIO_BATCH_SIZE; }
  get pricingPoolRatioConcurrency(): number { return this.config.PRICING_POOL_RATIO_CONCURRENCY; }
  get pricingPoolRatioMaxLagSeconds(): number { return this.config.PRICING_POOL_RATIO_MAX_LAG_SECONDS; }

  // ── W1: leaderboard / pools read path ──
  get leaderboardCountCap(): number { return Math.max(1, Math.floor(this.config.LEADERBOARD_COUNT_CAP) || 25_000); }
  get leaderboardCacheMaxBytes(): number {
    return Math.max(1, this.config.LEADERBOARD_CACHE_MAX_MB || 64) * 1024 * 1024;
  }
  get leaderboardWarmupEnabled(): boolean { return this.config.LEADERBOARD_WARMUP_ENABLED; }
  get leaderboardSnapshotRedisEnabled(): boolean {
    return this.config.LEADERBOARD_SNAPSHOT_REDIS_ENABLED ?? this.isProduction;
  }
  /**
   * Who wrote a leaderboard snapshot: NODE_ENV plus the Mongo hosts and
   * database the rows were read from (never the credentials), hashed. Part of
   * the snapshot key and checked on load, so a process only ever serves
   * snapshots built from its own database.
   */
  get leaderboardSnapshotNamespace(): string {
    return createHash('sha1')
      .update(`${this.config.NODE_ENV}|${mongoDeploymentIdentity(this.config.MONGODB_URI)}`)
      .digest('hex')
      .slice(0, 16);
  }
  // ── end W1 ──

  // ── B: read-path staleness budget, deep pages, global read budget ──
  /** The end-to-end staleness budget (5 s – 5 min; default 45 s). */
  get readStalenessBudgetMs(): number {
    const v = Math.floor(this.config.READ_STALENESS_BUDGET_MS);
    return Number.isFinite(v) && v > 0 ? Math.min(300_000, Math.max(5_000, v)) : 45_000;
  }
  /** List windows / counts / pool detail fresh age (1 s – the budget). */
  get leaderboardListFreshMs(): number {
    const v = Math.floor(this.config.LEADERBOARD_LIST_FRESH_MS);
    const fresh = Number.isFinite(v) && v > 0 ? v : 15_000;
    return Math.min(this.readStalenessBudgetMs, Math.max(1_000, fresh));
  }
  /**
   * List windows / counts / pool detail stale age: at least the fresh age, and
   * at most the budget ÷ 1.1 — the list caches jitter TTLs by ±10 %, so even
   * the longest-lived entry stays inside the budget.
   */
  get leaderboardListStaleMs(): number {
    const v = Math.floor(this.config.LEADERBOARD_LIST_STALE_MS);
    const stale = Number.isFinite(v) && v > 0 ? v : 30_000;
    return Math.max(this.leaderboardListFreshMs, Math.min(Math.floor(this.readStalenessBudgetMs / 1.1), stale));
  }
  get leaderboardWarmupIntervalMs(): number {
    const v = Math.floor(this.config.LEADERBOARD_WARMUP_INTERVAL_MS);
    return Number.isFinite(v) && v > 0 ? Math.max(1_000, v) : 10_000;
  }
  /** The age at which the warmup re-reads a window; unset (or garbage) = the list fresh age. */
  get leaderboardWarmupMinAgeMs(): number {
    const raw = this.config.LEADERBOARD_WARMUP_MIN_AGE_MS;
    const v = raw === undefined ? Number.NaN : Math.floor(raw);
    return Number.isFinite(v) && v >= 0 ? v : this.leaderboardListFreshMs;
  }
  /** Rows per second of the global read budget; 0 = off. */
  get readBudgetDocsPerSec(): number {
    const v = Math.floor(this.config.READ_BUDGET_DOCS_PER_SEC);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  /** The bucket's depth: at least one second of rate. */
  get readBudgetBurstDocs(): number {
    const v = Math.floor(this.config.READ_BUDGET_BURST_DOCS);
    return Math.max(this.readBudgetDocsPerSec, Number.isFinite(v) && v > 0 ? v : 0);
  }
  get leaderboardDeepWalkConcurrency(): number {
    const v = Math.floor(this.config.LEADERBOARD_DEEP_WALK_CONCURRENCY);
    return Number.isFinite(v) && v > 0 ? v : 2;
  }
  /** How long a ladder rung is kept as an (aged, flagged) deep-page start: the budget – 1 h, default 10 min. */
  get leaderboardLadderMaxAgeMs(): number {
    const v = Math.floor(this.config.LEADERBOARD_LADDER_MAX_AGE_MS);
    const ms = Number.isFinite(v) && v > 0 ? v : 600_000;
    return Math.min(3_600_000, Math.max(this.readStalenessBudgetMs, ms));
  }
  get readPathRedisEnabled(): boolean {
    return this.config.READ_PATH_REDIS_ENABLED ?? this.isProduction;
  }
  get mongoReplicationLagAlertMs(): number {
    const v = Math.floor(this.config.MONGO_REPLICATION_LAG_ALERT_MS);
    return Number.isFinite(v) && v > 0 ? v : 10_000;
  }
  // ── end B ──

  // ── P-R: read models ──
  get readModelsMode(): ReadModelMode { return this.config.READ_MODELS_MODE; }
  get poolCatalogMode(): ReadModelMode | undefined { return this.config.POOL_CATALOG_MODE; }
  get rankEngineMode(): ReadModelMode | undefined { return this.config.RANK_ENGINE_MODE; }
  /**
   * 0–100. Garbage (`10%`, `ten`) reads as 0 — FAIL CLOSED: Mongo answers
   * everything (it used to read as 100, skipping the ramp); the read-models
   * service alerts it at boot. Blank = the default 100.
   */
  get readModelsServePercent(): number {
    const v = this.config.READ_MODELS_SERVE_PERCENT;
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
  }
  /** READ_MODELS_SERVE_PERCENT is a number (false = garbage, read as 0). */
  get readModelsServePercentValid(): boolean { return Number.isFinite(this.config.READ_MODELS_SERVE_PERCENT); }
  get readModelsRole(): ConfiguredReadModelsRole { return this.config.READ_MODELS_ROLE; }
  /** The redis-models URL: REDIS_MODELS_URL, else REDIS_URL. */
  get redisModelsUrl(): string { return this.config.REDIS_MODELS_URL ?? this.config.REDIS_URL; }
  /** True when the models have their own Redis instance. */
  get redisModelsSeparate(): boolean { return Boolean(this.config.REDIS_MODELS_URL) && this.config.REDIS_MODELS_URL !== this.config.REDIS_URL; }
  get readModelsDegradedPolicy(): 'p1' | 'narrow' { return this.config.READ_MODELS_DEGRADED_POLICY; }
  /** 0–1; garbage reads as 0.05. */
  get readModelsShadowSample(): number {
    const v = this.config.READ_MODELS_SHADOW_SAMPLE;
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.05;
  }
  get readModelsShadowMaxPerMin(): number {
    const v = Math.floor(this.config.READ_MODELS_SHADOW_MAX_PER_MIN);
    return Number.isFinite(v) && v >= 0 ? v : 60;
  }
  /** 1–5000 (the schema refuses anything else). */
  get readModelsScanDocsPerSec(): number { return Math.floor(this.config.READ_MODELS_SCAN_DOCS_PER_SEC); }
  /** 0–5000; 0 = the verification scan is off. */
  get readModelsVerifyDocsPerSec(): number { return Math.floor(this.config.READ_MODELS_VERIFY_DOCS_PER_SEC); }
  /** 250 ms – 5 s (adaptive up to 5 s at run time). */
  get readModelsGenerationMs(): number {
    const v = Math.floor(this.config.READ_MODELS_GENERATION_MS);
    return Number.isFinite(v) && v > 0 ? Math.min(5_000, Math.max(250, v)) : 2_000;
  }
  /** 30 s – 1 h. */
  get readModelsSnapshotIntervalMs(): number {
    const v = Math.floor(this.config.READ_MODELS_SNAPSHOT_INTERVAL_MS);
    return Number.isFinite(v) && v > 0 ? Math.min(3_600_000, Math.max(30_000, v)) : 300_000;
  }
  /**
   * Snapshot encode cap (ms): default 20 s (the former hard-coded value);
   * garbage / ≤ 0 = the default; clamped 5 s – 5 min (5 min = half the 10-min
   * "being written" chunk TTL). Literals, not the holder's constants, so config
   * never imports the read-models runtime; `snapshotEncodeCapMs` applies the
   * same rule again where the encode runs.
   */
  get readModelsSnapshotEncodeTimeoutMs(): number {
    const v = Math.floor(this.config.READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? Math.min(300_000, Math.max(5_000, v)) : 20_000;
  }
  /** At least the staleness budget; default 120 s. */
  get readModelsMaxLagMs(): number {
    const v = Math.floor(this.config.READ_MODELS_MAX_LAG_MS);
    return Math.max(this.readStalenessBudgetMs, Number.isFinite(v) && v > 0 ? v : 120_000);
  }
  get readModelsReadyTimeoutMs(): number {
    const v = Math.floor(this.config.READ_MODELS_READY_TIMEOUT_MS);
    return Number.isFinite(v) && v >= 0 ? v : 300_000;
  }
  /** 0–16; 0 = in-thread. */
  get readModelsWorkers(): number {
    const v = Math.floor(this.config.READ_MODELS_WORKERS);
    return Number.isFinite(v) && v >= 0 ? Math.min(16, v) : 2;
  }
  get readModelsMaxMb(): number {
    const v = Math.floor(this.config.READ_MODELS_MAX_MB);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  /** 0 = no reservation; a number = every positions table; `{ perChain }` = the listed chains only (C-cap). */
  get readModelsPositionsCapacity(): PositionsCapacity {
    const v = this.config.READ_MODELS_POSITIONS_CAPACITY;
    if (typeof v !== 'number') return v;
    const rows = Math.floor(v);
    return Number.isFinite(rows) && rows > 0 ? rows : 0;
  }
  /** At least 1 min; default 3 h. */
  get readModelsOplogWindowHintMs(): number {
    const v = Math.floor(this.config.READ_MODELS_OPLOG_WINDOW_HINT_MS);
    return Number.isFinite(v) && v > 0 ? Math.max(60_000, v) : 10_800_000;
  }
  get readModelsDurableSnapshotUrl(): string | undefined { return this.config.READ_MODELS_DURABLE_SNAPSHOT_URL; }
  // ── end P-R ──

  // ── C: Mongo client limits ──
  /** Unset = `tickwise-backend` in role `all` (today), `tickwise-<role>` in a split role (P2.1). */
  get mongoAppName(): string {
    const v = presentValue(this.config.MONGO_APP_NAME);
    if (v) return v;
    return this.processRole === 'all' ? 'tickwise-backend' : `tickwise-${this.processRole}`;
  }
  /** Connections per member (1 – 500); unset or garbage reads as the ROLE default (all 60 = today). */
  get mongoMaxPoolSize(): number {
    const raw = this.config.MONGO_MAX_POOL_SIZE;
    const v = raw === undefined ? Number.NaN : Math.floor(raw);
    return Number.isFinite(v) && v > 0 ? Math.min(500, v) : roleDefaults(this.processRole).mongoMaxPoolSize;
  }
  /**
   * The connection wait-queue limit (100 ms – 5 min). There is no "unbounded":
   * unset, 0 or garbage reads as the ROLE default (all 10 s = today), because
   * an unbounded wait is what this setting exists to remove.
   */
  get mongoWaitQueueTimeoutMs(): number {
    const raw = this.config.MONGO_WAIT_QUEUE_TIMEOUT_MS;
    const v = raw === undefined ? Number.NaN : Math.floor(raw);
    return Number.isFinite(v) && v > 0 ? Math.min(300_000, Math.max(100, v)) : roleDefaults(this.processRole).mongoWaitQueueTimeoutMs;
  }
  /** autoIndex on the shard collections: unset = off in production only. */
  get mongoShardAutoIndex(): boolean {
    return this.config.MONGO_SHARD_AUTO_INDEX ?? !this.isProduction;
  }
  // ── end C ──

  // ── W6: detail + charts input caches ──
  get chartCacheMaxBytes(): number {
    return Math.max(1, this.config.CHART_CACHE_MAX_MB || 64) * 1024 * 1024;
  }
  // ── end W6 ──

  // ── W5: on-chain fee refresh tiers ──
  get positionFeeHotMinUsd(): number {
    const v = this.config.POSITION_FEE_HOT_MIN_USD;
    return Number.isFinite(v) && v >= 0 ? v : 50;
  }
  /** 0 = hot tier disabled (the default); a positive value is floored at 60 s. */
  get positionFeeHotIntervalMs(): number {
    const v = this.config.POSITION_FEE_HOT_INTERVAL_MS;
    return Number.isFinite(v) && v > 0 ? Math.max(60_000, v) : 0;
  }
  get positionFeeFullIntervalMs(): number { return Math.max(60_000, this.config.POSITION_FEE_FULL_INTERVAL_MS || 2_700_000); }
  get positionFeeMaxPerTick(): number { return Math.max(1, Math.floor(this.config.POSITION_FEE_MAX_PER_TICK) || 25_000); }
  /** The post-boot ramp (≤ 2 h); 0 = none; negative or garbage reads as the 5-min default. */
  get positionFeeRampMs(): number {
    const v = Math.floor(this.config.POSITION_FEE_RAMP_MS);
    return Number.isFinite(v) && v >= 0 ? Math.min(7_200_000, v) : 300_000;
  }
  /** 0 = always write (a trap, see the schema comment); anything invalid reads as the 24 h default. */
  get positionFeeRestampMs(): number {
    const v = this.config.POSITION_FEE_RESTAMP_MS;
    return Number.isFinite(v) && v >= 0 ? v : 86_400_000;
  }
  /** Fee writes per second, all chains together. There is no "unlimited": 0 or garbage reads as 40. */
  get positionFeeMaxWritesPerSec(): number {
    const v = this.config.POSITION_FEE_MAX_WRITES_PER_SEC;
    return Number.isFinite(v) && v > 0 ? v : 40;
  }
  /** Of those, writes that also rewrite the served fields. 0 or garbage reads as 25. */
  get positionFeeMaxServedWritesPerSec(): number {
    const v = this.config.POSITION_FEE_MAX_SERVED_WRITES_PER_SEC;
    return Number.isFinite(v) && v > 0 ? v : 25;
  }
  get positionFeePassAlertMs(): number {
    const v = this.config.POSITION_FEE_PASS_ALERT_MS;
    return Number.isFinite(v) && v > 0 ? v : 3_000_000;
  }
  /** Detail-view re-reads per chain per tick; 0 turns them off. */
  get positionFeeViewPerTick(): number {
    const v = this.config.POSITION_FEE_VIEW_PER_TICK;
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 200;
  }
  // ── end W5 ──

  // ── P2.1: process roles + leases (common/process-role.ts) ──
  /** `PROCESS_ROLE` (validated): all (today) | api | sync | fee | feeder. */
  get processRole(): ProcessRole { return this.roleSettings.role; }
  /** `PROCESS_LEASES` as configured: auto | on | off (`auto` → off in `all`, on in a split role). */
  get processLeases(): ProcessLeasesSetting { return this.roleSettings.leasesSetting; }
  /** Leases resolved for this process. */
  get processLeasesEnabled(): boolean { return this.roleSettings.leases; }
  /**
   * `PROCESS_STATUS_PUBLISH_MS`; undefined when unset or garbage, so
   * `ProcessStatusService` applies `statusPublishMsDefault()` (10 000 whenever
   * leases are on, `all` included; 0 in `all` + leases off = today).
   */
  get processStatusPublishMs(): number | undefined {
    const v = this.config.PROCESS_STATUS_PUBLISH_MS;
    return v !== undefined && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  }
  /**
   * `POSITIONS_REFRESH_QUEUE_CONCURRENCY` as configured (1 – 64; garbage = 1).
   * The ONE clamp (> 1 only under WRITE_BUDGET_MODE=enforce) is QueueService's
   * `resolveRefreshQueueConcurrency` (it delegates to write-budget-model's
   * `refreshQueueConcurrency`).
   */
  get positionsRefreshQueueConcurrency(): number {
    const v = Math.floor(this.config.POSITIONS_REFRESH_QUEUE_CONCURRENCY);
    return Number.isFinite(v) && v >= 1 ? Math.min(64, v) : 1;
  }
  /** How long a held-elsewhere backfill job keeps re-delaying (≥ 60 s; default 45 min). */
  get backfillHeldMaxWaitMs(): number {
    const v = Math.floor(this.config.BACKFILL_HELD_MAX_WAIT_MS);
    return Number.isFinite(v) && v > 0 ? Math.max(60_000, v) : 2_700_000;
  }
  // ── end P2.1 ──

  // ── /api anti-scraping, Step 1 ──
  get apiLimitMode(): 'off' | 'observe' | 'enforce' { return this.config.API_LIMIT_MODE; }
  get apiLimiterStore(): 'memory' | 'redis' { return this.config.API_LIMITER_STORE; }
  get apiLimitPoints10s(): number { return Math.floor(positiveOr(this.config.API_LIMIT_POINTS_10S, 100)); }
  get apiLimitPointsHour(): number { return Math.floor(positiveOr(this.config.API_LIMIT_POINTS_HOUR, 10_000)); }
  get apiLimitMaxInFlight(): number { return Math.floor(positiveOr(this.config.API_LIMIT_MAX_IN_FLIGHT, 24)); }
  get apiLimitCountMissPerMin(): number { return Math.floor(positiveOr(this.config.API_LIMIT_COUNT_MISS_PER_MIN, 3)); }
  /** The share of the read budget keyless /api may take; 1 (also for garbage, 0 and anything ≥ 1) = no bound. */
  get apiReadShare(): number {
    const v = this.config.API_READ_SHARE;
    return Number.isFinite(v) && v > 0 && v < 1 ? v : 1;
  }
  get clientIpEcho(): boolean { return this.config.CLIENT_IP_ECHO === 'on'; }
  // ── end /api anti-scraping ──

  // ── P2.2: shared state in Redis ──
  get authLimiterStore(): 'memory' | 'redis' { return this.config.AUTH_LIMITER_STORE; }
  get cacheInvalidation(): 'off' | 'redis' { return this.config.CACHE_INVALIDATION; }
  /** The backend's share of the Dwellir account's req/s; 0 (or garbage / negative) = off (today). */
  get rpcBudgetPerSec(): number {
    const v = this.config.RPC_BUDGET_PER_SEC;
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  /** Raw `host=account,…` (parsed by `RpcBudget`). */
  get rpcAccountMap(): string { return this.config.RPC_ACCOUNT_MAP.trim(); }
  /** The backend's monthly request share; garbage = 150M. */
  get rpcMonthlyCap(): number {
    const v = Math.floor(this.config.RPC_MONTHLY_CAP);
    return Number.isFinite(v) && v > 0 ? v : 150_000_000;
  }
  // ── end P2.2 ──

  // ── P2.3: skip unchanged position writes (read structurally by writeSkipSettings) ──
  get positionsWriteSkip(): 'off' | 'shadow' | 'on' { return this.config.POSITIONS_WRITE_SKIP; }
  get positionsWriteSkipAge(): 'refresh' | 'bucket' { return this.config.POSITIONS_WRITE_SKIP_AGE; }
  get positionsWriteSkipTolerance(): 'exact' | 'material' { return this.config.POSITIONS_WRITE_SKIP_TOLERANCE; }
  get positionsGasRevalue(): 'always' | 'full-write' { return this.config.POSITIONS_GAS_REVALUE; }
  /** Raw; `writeSkipSettings` reads < 60 000 or garbage as the 6 h default. */
  get positionsForcedRewriteMs(): number { return this.config.POSITIONS_FORCED_REWRITE_MS; }
  /** Raw; `writeSkipSettings` reads < 60 000 or garbage as the 24 h default. */
  get positionsForcedRewriteZeroMs(): number { return this.config.POSITIONS_FORCED_REWRITE_ZERO_MS; }
  // ── end P2.3 ──

  // ── P2.4: the shared write budget ──
  /** The resolved budget settings (memoised; `WRITE_BUDGET_MODE=off` = today: nothing acquired or measured). */
  get writeBudget(): WriteBudgetSettings {
    this.writeBudgetMemo ??= resolveWriteBudgetSettings({
      WRITE_BUDGET_MODE: this.config.WRITE_BUDGET_MODE,
      WRITE_BUDGET_UNITS_PER_SEC: this.config.WRITE_BUDGET_UNITS_PER_SEC,
      WRITE_BUDGET_MIN: this.config.WRITE_BUDGET_MIN,
      WRITE_BUDGET_MAX: this.config.WRITE_BUDGET_MAX,
      WRITE_BUDGET_HOURLY_UNITS_PER_SEC: this.config.WRITE_BUDGET_HOURLY_UNITS_PER_SEC,
      WRITE_BUDGET_SHARES: this.config.WRITE_BUDGET_SHARES,
      WRITE_BUDGET_READ_UNIT: this.config.WRITE_BUDGET_READ_UNIT,
      WRITE_BUDGET_UNIT_LATENCY_RED_MS: this.config.WRITE_BUDGET_UNIT_LATENCY_RED_MS,
      WRITE_BUDGET_LATENCY_RED_MS: this.config.WRITE_BUDGET_LATENCY_RED_MS,
      WRITE_BUDGET_LAG_RED_MS: this.config.WRITE_BUDGET_LAG_RED_MS,
      WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR: this.config.WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR,
      WRITE_BUDGET_LOCAL_DIVISOR: this.config.WRITE_BUDGET_LOCAL_DIVISOR,
      MONGO_MONITOR_URI: this.config.MONGO_MONITOR_URI,
      MONGO_BULK_WRITE_MAX_OPS: this.config.MONGO_BULK_WRITE_MAX_OPS,
      PROCESS_ROLE: this.processRole,
    });
    return this.writeBudgetMemo;
  }
  /** Read-only monitor user (dirty %, oplog window); unset = those inputs are absent. */
  get mongoMonitorUri(): string | undefined { return presentValue(this.config.MONGO_MONITOR_URI); }
  // ── end P2.4 ──

  // ── Usage writes (read structurally by UsageFlushService: `UsageFlushConfigView`) ──
  /** `USAGE_WRITE_MODE`: direct (default = today) | batched | drain (rollback step: producers direct, the flusher empties the buffer). */
  get usageWriteMode(): UsageWriteMode { return resolveUsageWriteMode(this.config.USAGE_WRITE_MODE); }
  /** `USAGE_FLUSH_INTERVAL_MS`: garbage / ≤ 0 → 10 000; clamped 1 s – 5 min. */
  get usageFlushIntervalMs(): number { return resolveUsageFlushIntervalMs(this.config.USAGE_FLUSH_INTERVAL_MS); }
  // ── end usage writes ──

  // ── P2.5 / P3.1: backfill throughput (read structurally by readBackfillSettings) ──
  get backfillPaging(): 'offset' | 'tokenid' { return this.config.BACKFILL_PAGING; }
  get backfillPipeline(): boolean { return this.config.BACKFILL_PIPELINE === 'on'; }
  /** 0 – 8 (the reader clamps too). */
  get backfillLookaheadPages(): number {
    const v = Math.floor(this.config.BACKFILL_LOOKAHEAD_PAGES);
    return Number.isFinite(v) && v >= 0 ? Math.min(8, v) : 0;
  }
  /** 0 – 60 000 ms (only used with the pipeline on). */
  get backfillPriceWaitMs(): number {
    const v = Math.floor(this.config.BACKFILL_PRICE_WAIT_MS);
    return Number.isFinite(v) && v >= 0 ? Math.min(60_000, v) : 5_000;
  }
  get backfillFeeRead(): boolean { return this.config.BACKFILL_FEE_READ === 'on'; }
  get priceMissLedger(): 'off' | 'on' { return this.config.PRICE_MISS_LEDGER; }
  get geckoterminalBudget(): 'off' | 'local' | 'shared' { return this.config.GECKOTERMINAL_BUDGET; }
  /** (0, 1] override of the role's GT local share; undefined = role default. */
  get geckoterminalLocalShare(): number | undefined {
    const v = this.config.GECKOTERMINAL_LOCAL_SHARE;
    return v !== undefined && Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined;
  }
  // ── end P2.5 ──

  // ── P3.2 / P3.3: fee pass (read structurally by resolveFeeP3Settings; it parses and clamps) ──
  /** Raw `chain:size,…` (each value clamped 1 – 500 by the reader). */
  get positionFeeBatchSizeByChain(): string { return this.config.POSITION_FEE_BATCH_SIZE_BY_CHAIN.trim(); }
  /** Raw `chain:slots,…` (each value clamped 1 – 64 by the reader). */
  get positionFeeConcurrencyByChain(): string { return this.config.POSITION_FEE_CONCURRENCY_BY_CHAIN.trim(); }
  get positionFeeMaxInFlight(): number { return this.config.POSITION_FEE_MAX_IN_FLIGHT; }
  get positionFeeHeadPer(): 'batch' | 'page' { return this.config.POSITION_FEE_HEAD_PER; }
  get positionFeeBudget(): 'round' | 'per-chain' { return this.config.POSITION_FEE_BUDGET; }
  get positionFeePassTargetMs(): number { return this.config.POSITION_FEE_PASS_TARGET_MS; }
  get positionFeeCandidates(): 'mongo' | 'memory' { return this.config.POSITION_FEE_CANDIDATES; }
  get positionFeeLoadDocsPerSec(): number { return this.config.POSITION_FEE_LOAD_DOCS_PER_SEC; }
  get positionFeeReconcileMs(): number { return this.config.POSITION_FEE_RECONCILE_MS; }
  get positionFeeReconcileDocsPerSec(): number { return this.config.POSITION_FEE_RECONCILE_DOCS_PER_SEC; }
  get feeSignalsTransport(): 'auto' | 'memory' | 'redis' { return this.config.FEE_SIGNALS_TRANSPORT; }
  // ── end P3 ──

  // Test mode
  get testMode(): boolean { return this.config.TEST_MODE; }
  get testModePositionLimit(): number { return this.config.TEST_MODE_POSITION_LIMIT; }

  // Integrations
  get enabledIntegrations(): IntegrationConfig[] {
    return [...this.integrations];
  }

  getIntegration(chainId: number, protocol: string): IntegrationConfig | undefined {
    return this.integrations.find(
      (integration) => integration.chainId === chainId && integration.protocol === protocol,
    );
  }

  isSupportedChain(chainId: number): boolean {
    return Boolean(CHAINS[chainId]);
  }

  isSupportedProtocol(protocol: string): boolean {
    return Boolean(PROTOCOLS[protocol]);
  }

  private validateRegistries(): void {
    for (const integration of this.integrations) {
      if (!getChainConfig(integration.chainId)) {
        throw new Error(`Integration references unsupported chainId ${integration.chainId}`);
      }
      if (!getProtocolConfig(integration.protocol)) {
        throw new Error(`Integration references unsupported protocol ${integration.protocol}`);
      }
      // Belt-and-braces. `this.integrations` is already filtered on `enabled`,
      // which IS `Boolean(subgraphUrl)`, so this cannot fire today — it is an
      // assertion that the two definitions have not drifted apart, not a live
      // guard. The live signal for a chain with no url is the `[config]
      // integration … DISABLED` line emitted where the filter runs.
      if (!integration.subgraphUrl) {
        throw new Error(
          `Integration ${integration.chainId}:${integration.protocol} has no indexer URL`,
        );
      }
      /*
       * The Envio cutover removed The Graph's hosted service entirely: there is no
       * `GRAPH_API_KEY` and no gateway URL rewriting left, so a gateway URL would
       * go out KEYLESS and be rejected upstream — or, worse, answer a position
       * query with a GraphQL field error on a schema whose `Position` entity is a
       * different shape.
       *
       * This is the positive assertion that replaces the old per-chain
       * `*_POSITIONS_FROM_SUBGRAPH` opt-in. That flag existed to stop position
       * reads being aimed at a vanilla Uniswap subgraph by accident, but it
       * defaulted to FALSE and per-chain — so a chain whose flag was forgotten
       * served ZERO positions while `sync_runs` reported success, and the refresh
       * tick's stale-sweep then progressively marked its live positions closed.
       * Refusing the one URL that could be wrong is the same guarantee without the
       * silent-zero failure mode.
       */
      for (const url of new Set([integration.subgraphUrl, ...(integration.sources ?? []).map((s) => s.url)])) {
        if (isTheGraphHostedUrl(url)) {
          throw new Error(
            `Integration ${integration.chainId}:${integration.protocol} points at ` +
              `${url}, which is a The Graph hosted endpoint. This backend no ` +
              `longer uses The Graph's hosted service — point the URL at the Envio or Ponder indexer instead.`,
          );
        }
      }
    }
  }
}

/**
 * `host[,host…]/database` of a MongoDB connection string, lowercased, without
 * scheme, credentials or options — what identifies WHICH data a process reads.
 */
export function mongoDeploymentIdentity(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//i, '').split('?')[0] ?? '';
  const afterAuth = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1);
  const [hosts = '', database = ''] = afterAuth.split('/', 2);
  return `${hosts.toLowerCase()}/${database}`;
}

/**
 * Refused outright in `validateRegistries`; see the comment there.
 *
 * Matched on the REGISTRABLE DOMAIN, not one hostname: `gateway.thegraph.com` is
 * only the most familiar of several — `gateway-arbitrum.network.thegraph.com`,
 * `api.studio.thegraph.com` and `api.thegraph.com` are all The Graph endpoints
 * and all fail the same way, hours later, as a GraphQL field error on a
 * `Position` entity of a different shape. A non-parseable URL falls back to the
 * substring test rather than being waved through.
 */
function isTheGraphHostedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'thegraph.com' || host.endsWith('.thegraph.com');
  } catch {
    return url.toLowerCase().includes('thegraph.com');
  }
}

/**
 * Parse a comma-separated env value into a list of API keys. Trims each entry
 * and drops empties so `MORALIS_API_KEY=key1, key2,, key3` yields exactly
 * 3 keys.
 */
function parseKeyList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Read an optional env as present-or-absent. A key left BLANK in `.env`
 * (`OAUTH_GOOGLE_CLIENT_SECRET=`) must count as unset — otherwise a half-filled
 * credential marks its provider "configured" and every login attempt fails at
 * the provider instead of the button simply not being offered.
 */
function presentValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Drop a trailing `/` so callers can concatenate a path without doubling it. */
function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Is this host a loopback/local address? Accepts both a bare SIWE domain
 * (`localhost:3011`) and a URL hostname (`[::1]`); the port is dropped unless
 * the value is a bare IPv6 literal, whose colons are part of the address.
 */
function isLocalHostname(value: string): boolean {
  let host = value.trim().toLowerCase();
  const withPort = /^(.*):(\d+)$/.exec(host);
  if (withPort && (!withPort[1].includes(':') || withPort[1].endsWith(']'))) host = withPort[1];
  host = host.replace(/^\[/, '').replace(/\]$/, '');
  return LOCAL_HOSTNAMES.has(host) || host.endsWith('.localhost');
}

/**
 * Assert a production SSO origin is a real, public https origin. `URL` parsing
 * is the check: a scheme-less value (`app.example.com`) would slip past a naive
 * `startsWith('https://')` and then build a redirect_uri the provider rejects.
 */
function assertPublicHttpsOrigin(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute https URL in production`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https in production — an http redirect leaks the customer token`);
  }
  if (isLocalHostname(url.hostname)) {
    throw new Error(`${name} must not point at localhost in production`);
  }
}
