import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Starting a worker thread from TypeScript sources (dev under tsx, and the
 * specs under vitest): a worker inherits no TypeScript loader — neither from
 * the process's execArgv nor from an explicit `--import tsx` (its `.ts` entry
 * loads through Node's own type stripping, then its `.js` → `.ts` imports
 * fail). So the worker is started from an eval bootstrap that registers
 * `tsx/esm/api` first and then imports the entry. The built `dist/` path is a
 * plain `new Worker(<entry>.js)` and never comes here.
 *
 * `import.meta.resolve` is missing under vitest's module runner, so the API's
 * URL falls back to a CommonJS resolve of the same package export (its ESM
 * build sits next to it).
 */
export function tsWorkerBootstrap(entryUrl: string): string {
  return `import(${JSON.stringify(tsxApiUrl())}).then(({ register }) => { register(); return import(${JSON.stringify(entryUrl)}); });`;
}

function tsxApiUrl(): string {
  const meta = import.meta as unknown as { resolve?: (specifier: string) => string };
  if (typeof meta.resolve === 'function') return meta.resolve('tsx/esm/api');
  const cjs = createRequire(import.meta.url).resolve('tsx/esm/api');
  const mjs = cjs.replace(/\.cjs$/, '.mjs');
  return pathToFileURL(existsSync(mjs) ? mjs : cjs).href;
}
