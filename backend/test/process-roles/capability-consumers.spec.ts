import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, ROLE_MATRIX, UNGATED_CAPABILITIES, type Capability } from '../../src/common/process-role.js';

/**
 * Every ROLE_MATRIX cell is either ENFORCED by a `can('<cap>')` /
 * `roleCan(…, '<cap>')` call somewhere in src/, or listed in
 * UNGATED_CAPABILITIES with its reason — so the matrix can never look fully
 * enforced while half of it gates nothing (review finding, 2026-10-04).
 */
const SRC = join(__dirname, '..', '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function consumers(): Map<Capability, string[]> {
  const out = new Map<Capability, string[]>();
  const pattern = /\b(?:can|roleCan)\([^)]*'([a-z-]+)'\)/g;
  for (const file of files(SRC)) {
    if (file.endsWith(join('common', 'process-role.ts'))) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(pattern)) {
      const cap = m[1] as Capability;
      if (!(cap in ROLE_MATRIX)) continue;
      out.set(cap, [...(out.get(cap) ?? []), file]);
    }
  }
  return out;
}

describe('ROLE_MATRIX capabilities have consumers (or a stated reason)', () => {
  const used = consumers();

  it.each(CAPABILITIES)('%s: gated in src, or listed in UNGATED_CAPABILITIES', (cap) => {
    expect(used.has(cap) || cap in UNGATED_CAPABILITIES).toBe(true);
  });

  it('no listed capability is already gated (remove it from UNGATED_CAPABILITIES when its gate lands)', () => {
    const stale = Object.keys(UNGATED_CAPABILITIES).filter((cap) => used.has(cap as Capability));
    expect(stale).toEqual([]);
  });

  it('every UNGATED_CAPABILITIES key is a real capability', () => {
    for (const cap of Object.keys(UNGATED_CAPABILITIES)) expect(CAPABILITIES).toContain(cap);
  });
});
