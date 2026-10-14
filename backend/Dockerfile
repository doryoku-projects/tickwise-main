# Backend image — pnpm, installed from the committed lockfile.
#
# - Every stage is node:24.21.0-alpine: the runtime the tests and the M10 rig run on
#   (`.nvmrc`, `engines`). Keep the three in step.
# - pnpm comes from corepack at a PINNED version. Bump PNPM_VERSION deliberately; the
#   lockfile is v9. The ioredis override is in BOTH package.json `pnpm.overrides` (which
#   pnpm 10.x still reads, and which WINS) and pnpm-workspace.yaml (read by newer pnpm);
#   keep the two identical. pnpm-workspace.yaml also carries `allowBuilds`.
# - `--frozen-lockfile` fails the build when pnpm-lock.yaml does not match package.json
#   / pnpm-workspace.yaml, so prod runs exactly the dependency versions the tests ran.
# - No BuildKit cache mounts: Railway rejects a cache mount whose id is not prefixed
#   with its service id, so a portable Dockerfile cannot use them.
# - .dockerignore keeps .env*, node_modules, dist, tests and scratch out of the context.

ARG NODE_IMAGE=node:24.21.0-alpine

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=10.34.6
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable pnpm && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm --version
WORKDIR /app

# Full install (dev deps included) for the TypeScript build.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# Production dependencies only, from the same lockfile.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Operator scripts (`node scripts/<name>.mjs`). Most import only production deps or
# dist/. Two exceptions: billing-subscriptions-migration.mjs tries tsx (a dev dep) and
# falls back to dist/; positions-index-migration.mjs --drop-legacy reads
# src/database/schemas/position.schema.ts for its "legacy indexes still declared"
# check, so that ONE source file ships too (without it the check only warns and is
# skipped). It is the schema this image was built from, which is what the check needs.
COPY scripts ./scripts
COPY --from=build /app/src/database/schemas/position.schema.ts ./src/database/schemas/position.schema.ts
# node is PID 1 (no npm/pnpm wrapper), so SIGTERM reaches the app's shutdown handlers.
CMD ["node", "dist/main.js"]
