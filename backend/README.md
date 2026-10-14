# Tickwise backend

NestJS service behind <https://api.tickwise.xyz>. It syncs Uniswap positions and pools from a GraphQL indexer into MongoDB, prices the tokens, ranks positions and pools, and serves them over HTTP. It also hosts the customer portal, billing and the admin routes.

## Requirements

- Node.js `>= 24.21.0` and [pnpm](https://pnpm.io)
- MongoDB and Redis
- A GraphQL indexer URL for at least one chain (see below)

## Run it locally

```bash
cp .env.example .env                  # set at least one *_UNISWAP_V4_SUBGRAPH_URL
docker compose up -d mongo redis      # MongoDB on 27017, Redis on 6379
pnpm install
pnpm dev                              # http://localhost:3010
```

`docker compose up -d` also starts the API itself in a container; pass the indexer URLs through your shell or `.env`.

```bash
pnpm build        # compile to dist/
pnpm start        # run the compiled build
pnpm typecheck
pnpm test         # vitest
```

## Indexer URLs

The backend reads positions and pools from a Uniswap v4 GraphQL indexer, one URL per chain. A chain is enabled only when its URL is set:

| Variable | Chain |
| --- | --- |
| `ETHEREUM_UNISWAP_V4_SUBGRAPH_URL` | Ethereum (1) |
| `ARBITRUM_UNISWAP_V4_SUBGRAPH_URL` | Arbitrum One (42161) |
| `AVALANCHE_UNISWAP_V4_SUBGRAPH_URL` | Avalanche C-Chain (43114) |
| `ROBINHOOD_UNISWAP_V4_SUBGRAPH_URL` | Robinhood Chain (4663) |

`UNISWAP_V4_INDEXER_URL` is a shared URL for deployments that serve several chains from one indexer. The chain registry is in [`src/config/chains.config.ts`](src/config/chains.config.ts). Uniswap v3 support exists in the code but is dormant.

## Routes

| Prefix | Auth | What it serves |
| --- | --- | --- |
| `GET /health` | none | Service health and enabled integrations |
| `/api/top-positions`, `/api/top-pools` | none (first-party website routes) | Ranked lists, counts, details and charts for the dashboard. Lists are capped at 25 rows a page, and each address has a request budget. |
| `/v1/positions`, `/v1/pools`, `/v1/chains`, `/v1/protocols`, `/v1/stats`, `/v1/plans` | `KC-APIKey` header | The metered customer API. Lists serve up to 100 rows a page. |
| `/account/*`, `/billing/*` | customer session | Sign-up, sign-in, API keys, subscriptions and payments |
| `/admin/*` | admin session or `X-Admin-Secret` | Sync control, read-model operations and the admin panel's data |
| `/webhooks/payments` | provider signature | Payment provider callbacks |

Position and pool details use `/:chainId/:protocol/:positionId` (or `:poolId`), and charts add `/charts`.

### List query parameters

These apply to `/api/top-positions` and `/v1/positions`:

| Parameter | Default | Values |
| --- | --- | --- |
| `chainId` | all chains | A chain id. Omitted: the enabled chains are merged. |
| `protocol` | `uniswap-v4` | A protocol key from `src/config/protocols.config.ts` |
| `sort` | `apr` | `apr`, `fee_apr`, `roi`, `age`, `pnl`, `underlying_value`, `nft_id_asc`, `nft_id_desc` |
| `page`, `limit` | `1`, `20` | `limit` is at most 100 (25 on `/api`) |
| `status` | active only | `active`, `inactive`, `all` |
| `range` | `all` | `all`, `in`, `out` (in range or out of range) |
| `minValueUsd` | `0` | Minimum position value in USD |
| `minPoolTvl` | `1000` | Minimum pool TVL in USD |
| `includeRisky` | `false` | Include positions in pools flagged as risky |
| `owner`, `positionId`, `poolId` | none | Exact-match filters |
| `assetClass` | none | `equity` for tokenized-equity pools |

The API documentation on the website (`/docs`) is the reference for responses, units and errors; the Postman collection for `/v1` is in [`postman/`](postman/).

## Configuration

Everything is read from the environment. [`.env.example`](.env.example) lists every variable with its default and a comment. The ones to know first:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3010` | |
| `MONGODB_URI` | `mongodb://localhost:27017/copypools_positions` | Legacy database name, kept so existing deployments keep their data |
| `REDIS_URL` | `redis://localhost:6379` | Queues, caches and the shared limiters |
| `JWT_SECRET`, `CUSTOMER_JWT_SECRET`, `ADMIN_SECRET` | development placeholders | **The backend refuses to start in production while any of these is a placeholder or shorter than 16 characters.** `CUSTOMER_JWT_SECRET` must differ from `JWT_SECRET`. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | placeholders | On a start with no admin user, the backend creates the first admin from these. **They are not checked at boot, even in production:** set your own strong password before the first production start. |
| `PROCESS_ROLE` | `all` | `all`, `api`, `sync`, `fee` or `feeder`: run everything in one process, or split the work across services |
| `PRICING_PROVIDERS` | see `.env.example` | Comma-separated price sources, in the order they are tried |
| `TRUST_PROXY_HOPS` | `0` | Number of reverse proxies in front of the app. Set it to the real count, or every visitor shares one rate-limit bucket. |

Payments use x402 (USDC on an EVM chain): see the `X402_*` and `PAYMENTS_*` variables. The development-only fake payment rail is off by default and the backend refuses to boot a production deployment with it on.

## How it fits together

1. **Sync.** A scheduled job pages positions and pools from the indexer into per-chain MongoDB collections, keeps a cursor so it can resume, and refreshes open positions on a short interval. A separate job reads uncollected fees from the chain.
2. **Pricing.** Token prices come from several sources and are cross-checked before they are used. Tokens with no trustworthy price are flagged, and positions in pools made of them are marked risky and hidden from the default lists.
3. **Serving.** Lists are ranked from per-chain shards, merged for the all-chains view, and cached with short lifetimes. Counts are cached separately. `/v1` calls are metered per key and per plan.

The code is organised by feature under `src/`: `sync/`, `pricing/`, `leaderboard/`, `pools/`, `charts/`, `v1/`, `billing/`, `payments/`, `portal/`, `admin/`, `read-models/`, `config/`.
