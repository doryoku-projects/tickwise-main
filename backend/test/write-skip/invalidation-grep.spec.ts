/*
 * P2.3 design §4.4: every writer of a position document either IS the hashed
 * path (it writes `wh` itself), `$unset`s `wh` in the same op (the next upsert
 * then writes the row whole), or writes only `tx*` fields (excluded from every
 * hash). A writer added later that does none of these would let a stale `wh`
 * vouch for a section it changed — so this spec reads the source and fails on
 * any write site it cannot classify.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const REPO_FILE = join(ROOT, 'src', 'database', 'positions.repository.ts');

/** Writes `wh` itself (the hashed path). */
const HASHED = new Set(['writeChunk', 'planRow', 'reissueWhole']);
/** Rewrites hashed sections outside `upsertMany`: must `$unset wh` with every write. */
const UNSET_WH = new Set(['writeRpcFeesChunk', 'markMissingStale', 'updatePerformanceMetrics']);
/** Write `tx*` fields only — excluded from every section hash. */
const TX_ONLY = new Set(['markTransactionSyncAttempt', 'markTransactionSyncSuccess', 'markTransactionSyncFailure']);

const WRITE_CALL = /\.(bulkWrite|updateMany|updateOne|findOneAndUpdate|replaceOne|insertMany|insertOne)\(|budgetedBulkWrite\(/;
const WRITE_OP = /updateOne:\s*\{/;

interface Member {
  name: string;
  kind: 'method' | 'function' | 'type';
  start: number;
  end: number;
}

/** Class members (2-space indent) and top-level declarations, with their line ranges. */
function members(lines: string[]): Member[] {
  const out: Member[] = [];
  const method = /^ {2}(?:(?:private|public|protected|static|readonly|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/;
  const fn = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
  const type = /^(?:export\s+)?(?:interface|type|const|class|enum)\s+([A-Za-z_$][\w$]*)/;
  lines.forEach((line, i) => {
    const m = method.exec(line);
    if (m && !/^ {2}(?:if|for|while|switch|return|catch)\b/.test(line)) {
      out.push({ name: m[1]!, kind: 'method', start: i, end: lines.length });
      return;
    }
    const f = fn.exec(line);
    if (f) {
      out.push({ name: f[1]!, kind: 'function', start: i, end: lines.length });
      return;
    }
    const t = type.exec(line);
    if (t) out.push({ name: t[1]!, kind: /^(?:export\s+)?class\s/.test(line) ? 'function' : 'type', start: i, end: lines.length });
  });
  for (let i = 0; i < out.length - 1; i++) out[i]!.end = out[i + 1]!.start;
  return out;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

function writeSites(source: string) {
  const lines = source.split('\n');
  const all = members(lines);
  const sites: Array<{ line: number; text: string; member: Member | undefined; call: boolean }> = [];
  lines.forEach((text, i) => {
    if (isComment(text)) return;
    const call = WRITE_CALL.test(text);
    if (!call && !WRITE_OP.test(text)) return;
    const member = [...all].reverse().find((m) => m.start <= i);
    sites.push({ line: i + 1, text: text.trim(), member, call });
  });
  return { lines, all, sites };
}

describe('every position writer invalidates or maintains wh', () => {
  const source = readFileSync(REPO_FILE, 'utf8');
  const { lines, all, sites } = writeSites(source);
  const body = (name: string) => {
    const m = all.find((x) => x.name === name && x.kind === 'method')!;
    return lines
      .slice(m.start, m.end)
      .filter((l) => !isComment(l))
      .join('\n');
  };

  it('finds the write sites it expects (the scan works)', () => {
    const names = new Set(sites.filter((s) => s.member?.kind === 'method').map((s) => s.member!.name));
    for (const name of [...HASHED, ...UNSET_WH, ...TX_ONLY]) expect(names, name).toContain(name);
  });

  it('classifies every write site', () => {
    const unknown = sites.filter((s) => {
      if (!s.member || s.member.kind === 'type') return false; // a type declaration, not a write
      return !HASHED.has(s.member.name) && !UNSET_WH.has(s.member.name) && !TX_ONLY.has(s.member.name);
    });
    expect(unknown.map((s) => `${s.member?.name}:${s.line}: ${s.text}`)).toEqual([]);
  });

  it('the hashed path writes wh (and wAt on whole writes)', () => {
    expect(body('planRow')).toMatch(/encodeWh\(/);
    expect(body('planRow')).toMatch(/wh, wAt: now/);
    expect(body('planRow')).toMatch(/wh, lastSyncedAt: now/);
    expect(body('reissueWhole')).toMatch(/\.wh = encodeWh\(/);
    expect(body('reissueWhole')).toMatch(/\.wAt = now/);
    // skip `off` drops any stored wh with today's whole write.
    expect(body('planRow')).toMatch(/\.wh = ''/);
  });

  it.each([...UNSET_WH])('%s $unsets wh with every write it sends', (name) => {
    const text = body(name);
    const calls = text.split('\n').filter((l) => WRITE_CALL.test(l)).length;
    const unsets = (text.match(/wh: ''/g) ?? []).length;
    expect(calls).toBeGreaterThan(0);
    expect(unsets).toBeGreaterThanOrEqual(calls);
  });

  it.each([...TX_ONLY])('%s writes tx* fields only', (name) => {
    const text = body(name);
    const objects = [...text.matchAll(/\$(?:set|unset):\s*\{([^{}]*)\}/g)].map((m) => m[1]!);
    expect(objects.length).toBeGreaterThan(0);
    const keys = objects.flatMap((o) => [...o.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]!));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key, `${name} writes ${key}`).toMatch(/^tx/);
    // …and the per-row count write too.
    if (name === 'markTransactionSyncSuccess') expect(text).toMatch(/\$set: \{\s*txSyncedTransactionCount/);
  });

  it('no other source file writes a positions shard', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && path !== REPO_FILE) {
          const text = readFileSync(path, 'utf8');
          if (/positionModel\(/.test(text) && WRITE_CALL.test(text.split('\n').filter((l) => !isComment(l)).join('\n'))) {
            offenders.push(relative(ROOT, path));
          }
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
