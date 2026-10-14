/*
 * Declarative description of how one Hasura response row becomes one
 * subgraph-shaped row. Built during translation, interpreted during
 * post-processing, so the two never drift apart.
 */

import type { IdClass } from "./ids.js";

export type Coerce = "raw" | "idString" | "int" | "numericString";

export type FieldOut =
  /** A plain column. `src` is the Hasura name, `out` the subgraph name. */
  | {
      kind: "scalar";
      out: string;
      src: string;
      coerce: Coerce;
      idClass?: IdClass;
    }
  /** `token { id }` collapsed to the `token_id` FK column — no join. */
  | { kind: "refId"; out: string; src: string; idKey: string; idClass: IdClass }
  /** An object relationship traversed for more than just `id`. */
  | { kind: "object"; out: string; src: string; row: RowShape }
  /** An array relationship (@derivedFrom). */
  | { kind: "list"; out: string; src: string; row: RowShape }
  /**
   * Pool.token0 / token1: a String column the backend selects as a relation.
   * Resolved by a batched Token lookup after the main query returns.
   */
  | { kind: "stitch"; out: string; src: string; row: RowShape };

export interface RowShape {
  readonly entity: string;
  readonly fields: readonly FieldOut[];
}

export interface RootShape {
  /** Response key the backend expects, e.g. `pools`. */
  readonly out: string;
  /** Alias used in the emitted Hasura document. */
  readonly src: string;
  readonly kind: "single" | "list";
  readonly row: RowShape;
}

export type ResponseShape =
  | { kind: "roots"; roots: readonly RootShape[] }
  /**
   * `number` / `timestamp` record which halves of `_meta.block` the document
   * actually asked Hasura for, so post-processing neither reads a root that was
   * never requested nor fabricates a `0` for it.
   */
  | { kind: "meta"; number: boolean; timestamp: boolean };
