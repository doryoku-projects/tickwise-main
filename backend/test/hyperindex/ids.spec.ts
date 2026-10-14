import { describe, expect, it } from "vitest";

import { makeIdCodec, type IdClass } from "../../src/subgraph/hyperindex/ids.js";
import { TranslationError, UpstreamShapeError } from "../../src/subgraph/hyperindex/errors.js";

const ids = makeIdCodec(4663);

/** Deterministic pseudo-random hex, so a failure is reproducible. */
function hex(seed: number, bytes: number): string {
  let s = "0x";
  let x = seed >>> 0;
  for (let i = 0; i < bytes * 2; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    s += "0123456789abcdef"[x % 16];
  }
  return s;
}

describe("round trip", () => {
  it("outbound(inbound(x)) === x for every id class", () => {
    for (let i = 0; i < 200; i++) {
      const addr = hex(i, 20);
      const pool = hex(i + 5000, 32);
      const cases: Array<[IdClass, string]> = [
        ["pool", pool],
        ["token", addr],
        ["tick", `${pool}#${i - 100}`],
        ["interval", `${addr}-${20000 + i}`],
        ["opaque", `whatever-${i}`],
      ];
      for (const [cls, value] of cases) {
        expect(ids.outbound(ids.inbound(value, cls), cls)).toBe(value);
      }
    }
  });

  it("normalises Bundle in both directions — its Envio id is the chain id", () => {
    expect(ids.inbound("1", "bundle")).toBe("4663");
    expect(ids.outbound("4663", "bundle")).toBe("1");
  });

  it("passes the historical provider's empty page-1 cursor through untouched", () => {
    expect(ids.inbound("", "interval")).toBe("");
  });
});

describe("ordering", () => {
  /*
   * The historical pricing provider cursor-paginates with
   * `orderBy: id, orderDirection: asc` + `id_gt: $lastId`. That only terminates
   * if Envio's id ordering agrees with the subgraph's, so assert it directly.
   */
  it("preserves relative byte order across the transform", () => {
    const subgraphIds = Array.from({ length: 100 }, (_, i) => `${hex(i, 20)}-${20000 + i}`);
    const sortedBefore = [...subgraphIds].sort();
    const sortedAfter = [...subgraphIds]
      .map((v) => ids.inbound(v, "interval"))
      .sort()
      .map((v) => ids.outbound(v, "interval"));
    expect(sortedAfter).toEqual(sortedBefore);
  });
});

describe("malformed input", () => {
  it("rejects an interval id with no period suffix", () => {
    expect(() => ids.inbound("0xabc", "interval")).toThrow(TranslationError);
  });

  it("rejects an upstream id belonging to another chain", () => {
    expect(() => ids.outbound("1_0xabc", "pool")).toThrow(UpstreamShapeError);
  });
});
