/*
 * Hasura response -> subgraph-shaped response, driven by the ResponseShape the
 * translator produced.
 *
 * Pure apart from `loadTokens`, which is injected — so a test satisfies it with
 * a Map and the whole reshaping surface is covered offline.
 */

import { UpstreamShapeError } from "./errors.js";
import type { IdCodec } from "./ids.js";
import type { FieldOut, ResponseShape, RowShape } from "./shape.js";

export interface PostProcessCtx {
  readonly ids: IdCodec;
  readonly chainId: number;
  /** Batched Token primary-key lookup for the Pool.token0/token1 stitch. */
  loadTokens(envioIds: readonly string[]): Promise<Map<string, Row>>;
  warn?(message: string): void;
}

export type Row = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Scalar coercion                                                            */
/* -------------------------------------------------------------------------- */

/*
 * The envio-managed Hasura runs with HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true,
 * so numeric columns already arrive as strings — same as The Graph serializes
 * BigInt/BigDecimal. These coercers exist to make that guarantee explicit
 * rather than assumed, and to fail loudly if the setting ever changes.
 */

function toNumericString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new UpstreamShapeError(`non-finite numeric ${v}`);
    }
    // A numeric column arriving unstringified means the Hasura setting changed.
    // Preserving it as a JS number would silently lose precision on uint256.
    if (!Number.isSafeInteger(v)) {
      throw new UpstreamShapeError(
        `numeric ${v} arrived as an unsafe JS number — HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES must be true`,
      );
    }
    return String(v);
  }
  throw new UpstreamShapeError(`expected numeric, got ${typeof v}`);
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new UpstreamShapeError(`expected Int, got ${JSON.stringify(v)}`);
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* Row reshaping                                                              */
/* -------------------------------------------------------------------------- */

/** Envio Token ids needing a batched fetch, gathered before any await. */
function collectStitchIds(
  rows: readonly Row[],
  shape: RowShape,
  acc: Set<string>,
): void {
  for (const row of rows) {
    if (row === null || row === undefined) continue;
    for (const f of shape.fields) {
      if (f.kind === "stitch") {
        const v = row[f.src];
        if (typeof v === "string" && v !== "") acc.add(v);
      } else if (f.kind === "list") {
        const nested = row[f.src];
        if (Array.isArray(nested)) collectStitchIds(nested as Row[], f.row, acc);
      } else if (f.kind === "object") {
        const nested = row[f.src];
        if (nested && typeof nested === "object") {
          collectStitchIds([nested as Row], f.row, acc);
        }
      }
    }
  }
}

function applyField(
  f: FieldOut,
  row: Row,
  ctx: PostProcessCtx,
  tokens: Map<string, Row>,
  out: Row,
): void {
  switch (f.kind) {
    case "scalar": {
      const raw = row[f.src];
      if (f.coerce === "idString") {
        out[f.out] =
          raw === null || raw === undefined
            ? null
            : ctx.ids.outbound(String(raw), f.idClass ?? "opaque");
      } else if (f.coerce === "int") {
        out[f.out] = toInt(raw);
      } else if (f.coerce === "numericString") {
        out[f.out] = toNumericString(raw);
      } else {
        out[f.out] = raw ?? null;
      }
      return;
    }
    case "refId": {
      const raw = row[f.src];
      out[f.out] =
        raw === null || raw === undefined
          ? null
          : { [f.idKey]: ctx.ids.outbound(String(raw), f.idClass) };
      return;
    }
    case "object": {
      const nested = row[f.src];
      out[f.out] =
        nested && typeof nested === "object"
          ? shapeRow(nested as Row, f.row, ctx, tokens)
          : null;
      return;
    }
    case "list": {
      const nested = row[f.src];
      out[f.out] = Array.isArray(nested)
        ? (nested as Row[]).map((r) => shapeRow(r, f.row, ctx, tokens))
        : [];
      return;
    }
    case "stitch": {
      const key = row[f.src];
      if (typeof key !== "string" || key === "") {
        out[f.out] = null;
        return;
      }
      const token = tokens.get(key);
      if (!token) {
        // A pool referencing a Token row that does not exist is an indexer
        // invariant violation, not a normal empty result. Say so.
        throw new UpstreamShapeError(
          `pool references token ${JSON.stringify(key)} which has no row`,
        );
      }
      out[f.out] = shapeRow(token, f.row, ctx, tokens);
      return;
    }
  }
}

function shapeRow(
  row: Row,
  shape: RowShape,
  ctx: PostProcessCtx,
  tokens: Map<string, Row>,
): Row {
  const out: Row = {};
  for (const f of shape.fields) applyField(f, row, ctx, tokens, out);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function postProcess(
  shape: ResponseShape,
  data: Record<string, unknown>,
  ctx: PostProcessCtx,
): Promise<Record<string, unknown>> {
  if (shape.kind === "meta") return shapeMeta(shape, data, ctx);

  // One batched Token fetch for every stitch site across every root.
  const need = new Set<string>();
  for (const root of shape.roots) {
    const rows = data[root.src];
    if (Array.isArray(rows)) collectStitchIds(rows as Row[], root.row, need);
  }
  const tokens = need.size ? await ctx.loadTokens([...need]) : new Map<string, Row>();

  const out: Record<string, unknown> = {};
  for (const root of shape.roots) {
    const rows = data[root.src];
    if (!Array.isArray(rows)) {
      throw new UpstreamShapeError(`expected a list for ${root.src}`);
    }
    const shaped = (rows as Row[]).map((r) => shapeRow(r, root.row, ctx, tokens));
    out[root.out] = root.kind === "single" ? (shaped[0] ?? null) : shaped;
  }
  return out;
}

interface MetaRaw {
  meta?: Array<{ progressBlock?: unknown }>;
  /** `sw` is still tolerated on the way in so an older cached plan cannot throw. */
  sw?: Array<{ timestamp?: unknown }>;
  ml?: Array<{ timestamp?: unknown }>;
}

function shapeMeta(
  shape: Extract<ResponseShape, { kind: "meta" }>,
  data: Record<string, unknown>,
  ctx: PostProcessCtx,
): Record<string, unknown> {
  const d = data as MetaRaw;
  // Only the halves the translator asked Hasura for are read or emitted. A half
  // that was never requested must not appear as a `0` — for `number` that would be
  // "the indexer is at genesis", and for `timestamp` "no event yet".
  const block: Record<string, unknown> = { hash: null };
  let number: number | null = null;
  if (shape.number) {
    number = toInt(d.meta?.[0]?.progressBlock ?? null) ?? 0;
    block.number = number;
  }
  if (shape.timestamp) {
    const swapTs = Number(toNumericString(d.sw?.[0]?.timestamp ?? null) ?? "0");
    const mlTs = Number(toNumericString(d.ml?.[0]?.timestamp ?? null) ?? "0");
    const timestamp = Math.max(
      Number.isFinite(swapTs) ? swapTs : 0,
      Number.isFinite(mlTs) ? mlTs : 0,
    );
    block.timestamp = timestamp;
    if (timestamp === 0) {
      ctx.warn?.(
        `_meta: no ModifyLiquidity row for chain ${ctx.chainId}; ` +
          `block.timestamp=0 — the live listener will hold its cursor until the first indexed event`,
      );
    }
  }
  return {
    _meta: {
      block,
      deployment: number === null ? `envio:${ctx.chainId}` : `envio:${ctx.chainId}:${number}`,
      hasIndexingErrors: false,
    },
  };
}

export const __test = { toNumericString, toInt };
