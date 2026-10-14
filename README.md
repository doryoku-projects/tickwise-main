# Tickwise

Position-level and pool-level data for Uniswap on several chains, served as an HTTP API and a dashboard.

- Website and dashboard: <https://tickwise.xyz>
- API: <https://api.tickwise.xyz>

The chains the backend knows about are listed in [`backend/src/config/chains.config.ts`](backend/src/config/chains.config.ts) (Ethereum, Arbitrum One, Avalanche C-Chain and Robinhood Chain at the time of this snapshot).

## Packages

| Path | What it is | Stack |
| --- | --- | --- |
| [`backend/`](backend/) | Syncs positions and pools from a GraphQL indexer into MongoDB, prices the tokens, and serves the API: keyless `/api/*` routes for the website, keyed `/v1/*` routes for customers, plus the customer portal, billing and admin routes. | NestJS 11, MongoDB, Redis, BullMQ, TypeScript (ESM) |
| [`frontend/`](frontend/) | The Explore dashboard (positions and pools), the API docs, the customer portal and the admin panel. | Next.js 15, React 19 |

## Requirements

- Node.js `>= 24.21.0`
- [pnpm](https://pnpm.io) (both packages ship a `pnpm-lock.yaml`)
- MongoDB and Redis (the backend's `docker-compose.yml` starts both)
- A GraphQL indexer URL for at least one chain. The backend reads one `*_UNISWAP_V4_SUBGRAPH_URL` variable per chain; see [`backend/.env.example`](backend/.env.example).

## Run it locally

Backend (port 3010):

```bash
cd backend
cp .env.example .env        # set at least one indexer URL
docker compose up -d mongo redis
pnpm install
pnpm dev
```

Frontend (port 3011):

```bash
cd frontend
cp .env.example .env.local  # NEXT_PUBLIC_POSITIONS_API_URL points at the backend
pnpm install
pnpm dev
```

Checks:

```bash
cd backend  && pnpm typecheck && pnpm test
cd frontend && pnpm typecheck
```

More detail on the backend's routes and settings is in [`backend/README.md`](backend/README.md) and [`backend/.env.example`](backend/.env.example). The Postman collection for the keyed `/v1` API is in [`backend/postman/`](backend/postman/).

## About this repository

This is a snapshot of a privately maintained repository, published without its commit history. Changes are made in the private repository and published here as new snapshots, so a pull request opened here cannot be merged directly. Internal planning notes and agent instructions are not part of the snapshot.

## Data and attributions

- **Token lists.** The backend gates token values on lists of tokens that CoinGecko lists (`backend/src/pricing/data/`). That data comes from the CoinGecko API, whose terms restrict copying and redistributing it, so those files are empty in this repository. Generate them with your own CoinGecko access (`node scripts/refresh-token-allowlist.mjs`, and the sibling `refresh-token-symbols.mjs` and `refresh-tokenized-equities.mjs` in `backend/scripts/`). With empty lists, tokens outside the configured anchors are valued at $0. Token data **powered by [CoinGecko](https://www.coingecko.com)**.
- **Charts.** The price and liquidity charts use TradingView's open-source [lightweight-charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0).
- **Spring animation.** `frontend/src/components/home/hero/spring.ts` is adapted from [Motion](https://github.com/motiondivision/motion) (MIT, Copyright (c) 2024 Motion B.V.); the notice is in the file.

## License

Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). In short: you may use, study, modify and redistribute the code, but if you run a modified version as a network service you must offer the source of your version to the users of that service (section 13). Read the license for the exact terms.

## Security

Please report vulnerabilities privately; see [`SECURITY.md`](SECURITY.md).
