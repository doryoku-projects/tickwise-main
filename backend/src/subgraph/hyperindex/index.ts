/*
 * Subgraph -> HyperIndex conversion.
 *
 * Everything dialect-related lives in this folder. Outside it, the only change
 * is choosing this `fetch` for an integration whose dialect is `hyperindex`.
 */

export { makeHyperindexFetch, type HyperindexFetchOptions } from './fetch.js';
export { HyperindexUpstream } from './upstream.js';
export { translate } from './translate.js';
export { postProcess, type PostProcessCtx, type Row } from './postprocess.js';
export { makeIdCodec, type IdClass } from './ids.js';
export * from './errors.js';
