import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard against the failure that actually happened: a GraphQL client built over
 * a SUBGRAPH url with the bare global `fetch`, which sends subgraph dialect
 * straight at a Hasura endpoint and fails with
 * `field 'pools' not found in type: 'query_root'`.
 *
 * The first wiring pass hand-listed the files to change and missed the position
 * adapter — the live path. A list can be incomplete; this check cannot.
 *
 * It used to carry an exemption for a url mentioning `ponderUrl`, because a
 * Ponder endpoint spoke its own dialect and must NOT have been converted. With
 * Ponder gone there is no legitimate bare-fetch client left, so the exemption is
 * gone too — and its absence is what makes this the proof that every indexer
 * client is translated.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('subgraph client wiring', () => {
  it('never builds a client over a subgraph url with the bare global fetch', () => {
    const offenders: string[] = [];
    for (const file of walk('src')) {
      // The converter itself legitimately calls the global fetch.
      if (file.includes('subgraph/hyperindex')) continue;
      const src = readFileSync(file, 'utf8');
      const re = /new GraphQLClient\(\s*([^,]+?),\s*\{\s*fetch\s*\}/g;
      for (const m of src.matchAll(re)) {
        const url = m[1]!.trim();
        offenders.push(`${file}: new GraphQLClient(${url}, { fetch })`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('routes every subgraph-dialect POST in the pricing providers through graphqlJson', () => {
    for (const f of [
      'src/pricing/providers/subgraph-current.provider.ts',
      'src/pricing/providers/subgraph-historical.provider.ts',
    ]) {
      const src = readFileSync(f, 'utf8');
      // httpJson bypasses conversion entirely — these two files must not use it.
      expect(src, `${f} still calls httpJson directly`).not.toMatch(/this\.httpJson</);
      expect(src).toMatch(/this\.graphqlJson</);
    }
  });
});
