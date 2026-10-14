import type { NextConfig } from 'next';

/**
 * OPTIONAL peer dependencies pulled into the module graph that this app
 * deliberately does not install:
 *   - `pino-pretty` — pino's development log formatter, reached through
 *     @walletconnect/logger from the WalletConnect and Ledger wallet modules.
 *     pino `require`s it lazily and copes fine when it is missing; only the
 *     bundler minds, and it minds at build time even though the modules behind
 *     it are never loaded unless a WalletConnect project id is configured.
 *
 * `fallback` applies ONLY after normal resolution fails, so this stubs the gap
 * without shadowing the real package should anything ever install it.
 */
const ABSENT_OPTIONAL_PEERS = {
  'pino-pretty': false as const,
};

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * `next build` and `next dev` write the same directory and put incompatible
   * things in it: the dev server then holds references to manifests and chunks
   * the build replaced and fails with "Cannot read properties of undefined
   * (reading 'call')" or "Expected clientReferenceManifest to be defined", or
   * serves pages with no CSS. Setting NEXT_DIST_DIR gives a verification build
   * its own directory so it can run alongside `npm run dev` — see the
   * `build:check` script.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  outputFileTracingRoot: process.cwd(),
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.fallback = { ...config.resolve.fallback, ...ABSENT_OPTIONAL_PEERS };
    return config;
  },
};

export default nextConfig;
