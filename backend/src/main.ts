import "reflect-metadata";
import "dotenv/config";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import compression from "compression";
import { AppModule } from "./app.module.js";
import { AppConfigService } from "./config/app-config.service.js";
import { ClientsService } from "./billing/clients.service.js";
import { UsageBucketService } from "./billing/usage-bucket.service.js";
import { MeteringService } from "./billing/metering.service.js";
import { SettingsCacheService } from "./billing/settings-cache.service.js";
import { trackRequestUsage } from "./billing/request-usage.js";
import { refundCharge } from "./v1/metering.interceptor.js";
import type { MeteringContext } from "./v1/metering-context.js";
import {
  indexerSummary,
  installServerTiming,
  interactiveContextFor,
  runInLane,
} from "./subgraph/hyperindex/indexer-context.js";
import {
  configureIndexerGateways,
  RedisIndexerSharedBudget,
  setIndexerSharedBudget,
} from "./subgraph/hyperindex/indexer-gateway.js";
import { beginShutdown } from "./common/shutdown.js";
import { configureProcessRole, processRoleBootLine } from "./common/process-role.js";
import { roleGateMiddleware, roleGateSummary } from "./common/role-gate.middleware.js";
import { CoordinationRedis } from "./common/coordination-redis.js";
import { RedisGcra } from "./common/redis-gcra.js";

// Minimal shape of the Express req/res/next we need — avoids pulling in
// @types/express purely for the request logger middleware.
interface HttpReq {
  method: string;
  url: string;
  originalUrl?: string;
  /**
   * Stamped by `MeteringGuard` on a metered `/v1` request, and ONLY there.
   * Absent for `/health`, the portal and admin realms, the free `/v1` metadata
   * routes, and a 401 on a bad key — none of which can be attributed to a
   * customer.
   */
  metering?: MeteringContext;
}
interface HttpRes {
  statusCode: number;
  writableFinished: boolean;
  headersSent: boolean;
  on(event: "finish" | "close", listener: () => void): void;
  setHeader(name: string, value: string): void;
  writeHead(...args: unknown[]): unknown;
}
type HttpNext = () => void;

/** A `/api` or `/v1` request slower than this gets a warn line with its indexer time. */
const SLOW_REQUEST_MS = 1_000;

/**
 * Access-log URL redaction. DO NOT "simplify" this away — it exists because
 * one URL in this app is guaranteed to carry a live credential.
 *
 * The OAuth provider redirects the browser to
 *   GET /account/auth/oauth/<provider>/callback?code=<AUTHORIZATION CODE>&state=<CSRF STATE>
 * so logging `req.originalUrl` verbatim wrote a redeemable authorization code
 * (and the state it is bound to) to stdout on EVERY sign-in. That is precisely
 * what the handoff-code design exists to prevent — tokens never travel in a
 * URL — undone at the last step, in the one place (logs) that gets shipped to
 * third-party aggregators and read by people who are not the customer.
 *
 * Two deliberately dumb rules, no URL parsing:
 *  1. Anything under `/account/auth/` loses its ENTIRE query string. Every
 *     parameter in that namespace is a credential or bound to one, so a
 *     parameter added later is covered by default instead of by someone
 *     remembering to extend the list below.
 *  2. Everywhere else, values of known-sensitive parameter NAMES are replaced.
 *     Defence in depth for credentials that leak onto other routes.
 * The method, path and status are always preserved, so the log stays useful.
 */
const REDACTED = "[redacted]";
/**
 * Path prefixes whose ENTIRE query string is dropped from the access log.
 *
 * The rule is per-NAMESPACE rather than per-parameter so that a parameter added
 * later is covered by default, instead of by somebody remembering to extend the
 * list below.
 *
 *  - `/account/auth/` — the OAuth callback carries a redeemable authorization
 *    code and the state it is bound to.
 *  - `/webhooks/payments/` — a rail is free to put anything in a callback URL,
 *    and this one is the unauthenticated entry point to the billing code. The
 *    shared key travels in a HEADER (never logged), but a query string on a
 *    money route is not a thing to find out about after the fact.
 *  - `/billing/checkout-status` — carries an invoice's `returnToken` as `?t=`,
 *    which is a capability. Named by PATH rather than by adding `t` to the
 *    parameter list below, because `t` is also everybody's cache-buster and
 *    redacting it everywhere would make unrelated logs useless.
 */
const REDACTED_QUERY_PREFIXES = [
  "/account/auth/",
  "/webhooks/payments/",
  "/billing/checkout-status",
];
const SENSITIVE_QUERY_PARAMS = new Set([
  "code",
  "state",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "signature",
  "nonce",
  "secret",
  "password",
  "api_key",
  "apikey",
]);

function redactUrl(url: string): string {
  const queryAt = url.indexOf("?");
  if (queryAt === -1) return url;
  const path = url.slice(0, queryAt);
  const query = url.slice(queryAt + 1);
  if (query.length === 0) return path;
  if (REDACTED_QUERY_PREFIXES.some((prefix) => path.startsWith(prefix))) return `${path}?${REDACTED}`;
  const scrubbed = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      return SENSITIVE_QUERY_PARAMS.has(name.toLowerCase()) ? `${name}=${REDACTED}` : pair;
    })
    .join("&");
  return `${path}?${scrubbed}`;
}

async function bootstrap(): Promise<void> {
  // Safety net: this service ingests from flaky external APIs (the Graph
  // gateway, pricing providers) over long-running parallel backfills. A
  // transient socket drop must never abort the process. Log escaped rejections
  // / exceptions and keep running — the per-bucket and per-batch try/catches
  // already isolate the affected unit of work.
  const processLogger = new Logger("Process");
  process.on("unhandledRejection", (reason) => {
    const detail =
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    processLogger.error(`Unhandled promise rejection (continuing): ${detail}`);
  });
  process.on("uncaughtException", (error) => {
    processLogger.error(`Uncaught exception (continuing): ${error.stack ?? error.message}`);
  });

  // P2.1: fix this process's role BEFORE Nest builds a provider — every
  // `can()` / `leasesEnabled()` asked from a constructor or a factory (the fee
  // coordination, the lease holders) must see it. Same env, same parse as the
  // Zod schema; a split role with PROCESS_LEASES=off is refused here
  // (`[alert] process_role.no_leases`), and so is any value Zod would refuse.
  let roleSettings: ReturnType<typeof configureProcessRole>;
  try {
    roleSettings = configureProcessRole({
      processRole: process.env.PROCESS_ROLE,
      processLeases: process.env.PROCESS_LEASES,
    });
  } catch (err) {
    processLogger.error(`Refusing to boot: ${(err as Error)?.message ?? String(err)}`);
    process.exit(1);
  }
  new Logger("ProcessRole").log(`${processRoleBootLine(roleSettings)} ${roleGateSummary(roleSettings.role)}`);

  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
    /**
     * Keeps the UNPARSED request bytes on `req.rawBody` alongside the parsed
     * `req.body`.
     *
     * Required by `POST /webhooks/payments/:provider`. A webhook signature is
     * computed over the bytes the sender transmitted, and `JSON.parse` →
     * `JSON.stringify` is not the identity function — key order, unicode
     * escapes and number formatting all move — so verifying a re-serialised
     * body verifies a document the sender never signed. Without this flag the
     * handler has nothing to check and fails every delivery CLOSED, which it
     * shouts about rather than silently accepting.
     */
    rawBody: true,
  });
  const config = app.get(AppConfigService);

  // P2.1 HTTP gating, installed FIRST — before CORS, compression, the access
  // log / usage seam and the indexer lane context. In a worker role (sync,
  // fee, feeder) anything but GET|HEAD /health and /health/live answers a bare
  // 404; in `all` and `api` it is a pass-through (`all` = today).
  app.use(roleGateMiddleware());

  // Graceful shutdown (2026-10-03). Without Nest's hooks a SIGTERM killed the
  // process outright: every BullMQ job it held stayed `active` until its 30-min
  // lock lapsed and then failed as "stalled", and every open `sync_runs` row
  // stayed `running` forever. The `once` listener is registered FIRST so the
  // stop signal (`common/shutdown.ts`) is up before any module's destroy hook
  // runs. `useProcessExit`: after its hooks Nest otherwise re-sends the signal
  // to itself, and in a container node is PID 1 (`CMD ["node", …]`), which the
  // kernel never delivers a self-sent default-action signal to — the process
  // would linger until SIGKILL. Railway's default SIGTERM→SIGKILL grace is
  // 0 s: set RAILWAY_DEPLOYMENT_DRAINING_SECONDS (≥ 15) for any of this to run.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => beginShutdown(signal));
  }
  app.enableShutdownHooks(["SIGTERM", "SIGINT"], { useProcessExit: true });

  // Indexer budget, before anything can call the indexer. `create` only builds
  // providers; every `onModuleInit` (the /health warm-up, the queue boot kicks,
  // the live listener) runs inside `listen()` below, i.e. after this line.
  configureIndexerGateways(config.indexerGatewayConfig);
  // P2.2: ONE Envio budget for the fleet (enforce only), on redis-state.
  // Unbound, `shared` alerts `indexer.shared_unbound` and runs on the local share.
  if (config.indexerBudgetScope === "shared") {
    const coordination = app.get(CoordinationRedis, { strict: false });
    setIndexerSharedBudget(new RedisIndexerSharedBudget(new RedisGcra(() => coordination.client())));
  }
  const gatewayConfig = config.indexerGatewayConfig;
  new Logger("IndexerGateway").log(
    `Indexer gateway mode=${config.indexerGatewayMode}` +
      (config.indexerGatewayMode === "enforce"
        ? ` budget=${gatewayConfig.budgetPerMin}/min background=${gatewayConfig.backgroundMaxPerMin}/min` +
          ` scope=${gatewayConfig.scope} localShare=${gatewayConfig.localShare}`
        : " (metering only)") +
      ` inFlight=${gatewayConfig.maxInFlight} reserved=${gatewayConfig.interactiveReservedInFlight}`,
  );

  // `req.ip` is the socket peer unless Express is told how many proxies sit in
  // front. The anonymous-signup throttle spends budget per IP, so behind a
  // proxy an untrusted setup keys every visitor to the proxy's address — one
  // shared bucket, i.e. a global signup cap. Opt-in via TRUST_PROXY_HOPS
  // because trusting a hop that isn't there is the worse failure: the client
  // then controls X-Forwarded-For and can mint unlimited buckets.
  if (config.trustProxyHops > 0) {
    app.getHttpAdapter().getInstance().set("trust proxy", config.trustProxyHops);
  }
  // Every IP-keyed limiter (the portal's login / signup throttles and the
  // keyless /api budget) is only as good as `req.ip`. In production a proxy
  // sits in front, so a hop count of 0 collapses every visitor into one bucket:
  // say so at boot instead of letting a global signup cap read as a bug.
  if (config.isProduction && config.trustProxyHops === 0) {
    new Logger("Bootstrap").warn(
      "[alert] config.trust_proxy TRUST_PROXY_HOPS is 0 in production: req.ip is the reverse proxy's address for every visitor, so " +
        "the IP-keyed limiters share ONE bucket. Behind Railway set it to 1 and check GET /diag/client-ip (CLIENT_IP_ECHO=on).",
    );
  }
  // A development origin in the production allowlist is trusted by both the
  // first-party origin check and credentialed CORS.
  if (config.isProduction && config.corsOrigins.some((origin) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(origin))) {
    new Logger("Bootstrap").warn(
      "[alert] config.cors_localhost CORS_ORIGINS holds a localhost origin in production: the first-party origin check and " +
        "credentialed CORS both trust it. Remove it from the production env.",
    );
  }

  // CORS: in dev allow any origin; in prod allow the first-party
  // `CORS_ORIGINS` allowlist (comma-separated env var; Vercel previews can be
  // appended there) PLUS any origin registered on an ACTIVE API key
  // (`ApiKey.allowedOrigins`, managed from the admin panel) — so paying
  // customers can call `/v1` from their website's frontend while other sites
  // get no CORS headers. This only gates BROWSERS; the API key + the guard's
  // per-key origin check (api-key.guard.ts) remain the real enforcement.
  const clients = app.get(ClientsService);
  app.enableCors({
    origin: config.isProduction
      ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
          // No Origin header → not a browser CORS request (curl/server) — allow.
          if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
          clients
            .isRegisteredOrigin(origin)
            .then((ok) => cb(null, ok))
            .catch(() => cb(null, false));
        }
      : true,
    credentials: true,
    /**
     * Without this, browser JS can read NONE of the metering headers: the CORS
     * spec exposes only a handful of safelisted response headers to script, and
     * every header below is outside it. The docs page publishes them as
     * readable and the standard/pro/enterprise plans all set
     * `allowBrowserKeys`, so a customer calling `/v1` from their own frontend
     * with a browser key could see the numbers in devtools and never in code.
     *
     * This is the complete set `MeteringGuard` emits — keep the two in step.
     */
    exposedHeaders: [
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "X-RateLimit-Reason",
      "X-Quota-Limit",
      "X-Quota-Remaining",
      "X-Quota-Reset",
      "Retry-After",
    ],
  });
  // gzip/deflate for anything over 1 KB. List pages carry 25 full documents and
  // charts up to 1000 ticks plus series; there was no compression anywhere.
  app.use(compression({ threshold: 1024 }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      forbidUnknownValues: true,
    }),
  );

  // Per-request access log: METHOD URL → STATUS in Xms. Health silenced to
  // avoid spam from container/load-balancer probes. 2xx responses logged
  // only in development to keep prod logs quiet; warnings + errors always.
  // The URL goes through `redactUrl` — see its comment; an OAuth callback
  // otherwise logs a live authorization code on every sign-in.
  //
  // This is also where the per-request usage detail is written, and it is the
  // ONLY place that can be: the response events are the one hook that sees the
  // FINAL status code, and `finish` fires for the metering guard's 429
  // rejections too (the guard stamps `req.metering` BEFORE it throws). A write
  // from inside `MeteringService` would have no status to record at all. A
  // client that disconnects first gets no `finish`; `trackRequestUsage`
  // refunds it and records it as a 499 on `close` instead.
  //
  // And it is where an `/api` or `/v1` request enters the indexer's
  // `interactive` lane (`indexer-context.ts`): the AsyncLocalStorage context
  // must wrap `next()` ITSELF so it reaches the Nest handler, and its
  // AbortController fires when the client hangs up, so queued and in-flight
  // indexer calls for a response nobody will read are dropped. The same context
  // carries the indexer time into `Server-Timing` and the slow-request warn.
  const httpLogger = new Logger("Http");
  const settingsCache = app.get(SettingsCacheService);
  const metering = app.get(MeteringService);
  const usageDeps = {
    usageBuckets: app.get(UsageBucketService),
    refund: (ctx: MeteringContext) => refundCharge(ctx, settingsCache, metering),
  };
  const isDev = process.env.NODE_ENV !== "production";
  const interactiveDeadlineMs = config.indexerInteractiveDeadlineMs;
  app.use((req: HttpReq, res: HttpRes, next: HttpNext) => {
    // The deploy probes (`/health/ready` 503s on every boot until a serving
    // model loads; `/health/live` is the worker roles' healthcheck) are not
    // request traffic: no access log, no usage record.
    if (req.url === "/health" || req.url === "/health/ready" || req.url === "/health/live") return next();
    const startedAt = Date.now();
    // `undefined` for every route outside /api and /v1 — those stay untagged.
    const indexerCtx = interactiveContextFor(req, res, interactiveDeadlineMs, startedAt);
    if (indexerCtx) installServerTiming(res, indexerCtx, startedAt);
    res.on("finish", () => {
      const ms = Date.now() - startedAt;
      const line = `${req.method} ${redactUrl(req.originalUrl ?? req.url)} → ${res.statusCode} ${ms}ms`;
      // A slow /api or /v1 response is worth a line even when it is a 2xx,
      // with where the time went; an error line just gains the same detail.
      const slow = indexerCtx !== undefined && ms > SLOW_REQUEST_MS;
      const detail = slow ? ` [slow] ${indexerSummary(indexerCtx)}` : "";
      if (res.statusCode >= 500) httpLogger.error(line + detail);
      else if (res.statusCode >= 400) httpLogger.warn(line + detail);
      else if (slow) httpLogger.warn(line + detail);
      else if (isDev) httpLogger.log(line);
    });
    res.on("close", () => {
      if (res.writableFinished) return;
      const detail = indexerCtx ? ` (${indexerSummary(indexerCtx)})` : "";
      httpLogger.warn(`${req.method} ${redactUrl(req.originalUrl ?? req.url)} → client closed after ${Date.now() - startedAt}ms${detail}`);
    });
    // No context ⇒ no customer to attribute the request to, so nothing is
    // recorded. A 401 on a bad key must not invent one.
    trackRequestUsage(req, res, usageDeps);
    if (indexerCtx) return runInLane(indexerCtx, next);
    next();
  });

  await app.listen(config.port, "0.0.0.0");
  console.log(`positions-backend listening on 0.0.0.0:${config.port}`);
}

void bootstrap();
