/**
 * The endpoint catalogue the playground offers, and the ONLY thing its proxy
 * will call.
 *
 * ONE source for two consumers that must never disagree: the picker renders
 * from it, and `/api/playground` validates against it. The proxy does not
 * accept a path from the browser at all — it takes an endpoint `id` and builds
 * the URL from the template here, so "which URLs can this server be made to
 * fetch" is answered by this file rather than by a regex on user input. A proxy
 * that forwards a caller-supplied path is an SSRF primitive pointed at whatever
 * the API host can reach.
 *
 * Kept in `lib/` rather than beside the page because the route handler runs on
 * the server and the page in the browser; a copy in each is the version that
 * drifts, and the half that drifts silently is the allow-list.
 */

export type ParamKind = 'string' | 'number' | 'boolean' | 'enum';

export interface PlaygroundParam {
  name: string;
  kind: ParamKind;
  /** `path` params are required and substituted; `query` params are optional. */
  in: 'path' | 'query';
  options?: readonly string[];
  placeholder?: string;
  help?: string;
  /**
   * Pre-filled into the form when the endpoint is selected. For an `enum` it
   * MUST be one of `options` — the form would otherwise open on a value
   * `buildRequest` rejects. Nothing enforces that at runtime here; the params
   * that carry one build the default and the option from a single constant, so
   * the two cannot drift apart.
   */
  default?: string;
}

export interface PlaygroundEndpoint {
  id: string;
  method: 'GET';
  /** `{name}` segments are filled from the `path` params below. */
  path: string;
  /** Metering key — used to show what the call costs. `null` = unmetered. */
  routeKey: string | null;
  summary: string;
  params: readonly PlaygroundParam[];
}

const CHAIN_ID: PlaygroundParam = {
  name: 'chainId',
  kind: 'number',
  in: 'query',
  placeholder: '1',
  help: 'Omit to merge every enabled chain into one ranking.',
};

/** The one protocol served. Named so the option and the default are one value. */
const UNISWAP_V4 = 'uniswap-v4';

const PROTOCOL: PlaygroundParam = {
  name: 'protocol',
  kind: 'enum',
  in: 'query',
  options: [UNISWAP_V4],
  default: UNISWAP_V4,
  help: 'The only value served; anything else is a 400.',
};

const PAGE: PlaygroundParam = { name: 'page', kind: 'number', in: 'query', placeholder: '1' };
const LIMIT: PlaygroundParam = {
  name: 'limit',
  kind: 'number',
  in: 'query',
  placeholder: '20',
  help: '1–100.',
};

const PATH_CHAIN: PlaygroundParam = {
  name: 'chainId',
  kind: 'number',
  in: 'path',
  placeholder: '1',
};
const PATH_PROTOCOL: PlaygroundParam = {
  name: 'protocol',
  kind: 'enum',
  in: 'path',
  options: [UNISWAP_V4],
  default: UNISWAP_V4,
};
const RANGE: PlaygroundParam = {
  name: 'range',
  kind: 'enum',
  in: 'query',
  options: ['30d', '60d', '90d', '180d', 'all'],
};

export const PLAYGROUND_ENDPOINTS: readonly PlaygroundEndpoint[] = [
  {
    id: 'pools.list',
    method: 'GET',
    path: '/v1/pools',
    routeKey: 'v1.pools.list',
    summary: 'Top pools, ranked.',
    params: [
      CHAIN_ID,
      PROTOCOL,
      { name: 'sort', kind: 'enum', in: 'query', options: ['tvl', 'volume', 'fees', 'fee_apr', 'age'] },
      PAGE,
      LIMIT,
      { name: 'minTvlUsd', kind: 'number', in: 'query', placeholder: '0' },
      { name: 'includeRisky', kind: 'boolean', in: 'query' },
      { name: 'search', kind: 'string', in: 'query', placeholder: 'USDC' },
    ],
  },
  {
    id: 'pools.detail',
    method: 'GET',
    path: '/v1/pools/{chainId}/{protocol}/{poolId}',
    routeKey: 'v1.pools.detail',
    summary: 'One pool by id.',
    params: [
      PATH_CHAIN,
      PATH_PROTOCOL,
      { name: 'poolId', kind: 'string', in: 'path', placeholder: '0x… (40 or 64 hex)' },
    ],
  },
  {
    id: 'pools.charts',
    method: 'GET',
    path: '/v1/pools/{chainId}/{protocol}/{poolId}/charts',
    routeKey: 'v1.pools.charts',
    summary: 'Time series for one pool.',
    params: [
      PATH_CHAIN,
      PATH_PROTOCOL,
      { name: 'poolId', kind: 'string', in: 'path', placeholder: '0x… (40 or 64 hex)' },
      RANGE,
    ],
  },
  {
    id: 'positions.list',
    method: 'GET',
    path: '/v1/positions',
    routeKey: 'v1.positions.list',
    summary: 'Positions, filterable and ranked.',
    params: [
      CHAIN_ID,
      PROTOCOL,
      {
        name: 'owner',
        kind: 'string',
        in: 'query',
        placeholder: '0x…40 hex',
        help: 'Every position held by one wallet.',
      },
      { name: 'poolId', kind: 'string', in: 'query', placeholder: '0x…' },
      { name: 'status', kind: 'enum', in: 'query', options: ['active', 'inactive', 'all'] },
      {
        name: 'sort',
        kind: 'enum',
        in: 'query',
        options: ['apr', 'fee_apr', 'roi', 'age', 'pnl', 'underlying_value', 'nft_id_asc', 'nft_id_desc'],
      },
      { name: 'range', kind: 'enum', in: 'query', options: ['all', 'in', 'out'] },
      PAGE,
      LIMIT,
      { name: 'minValueUsd', kind: 'number', in: 'query', placeholder: '0' },
      { name: 'minPoolTvl', kind: 'number', in: 'query', placeholder: '1000' },
      { name: 'includeRisky', kind: 'boolean', in: 'query' },
    ],
  },
  {
    id: 'positions.detail',
    method: 'GET',
    path: '/v1/positions/{chainId}/{protocol}/{positionId}',
    routeKey: 'v1.positions.detail',
    summary: 'One position by id.',
    params: [
      PATH_CHAIN,
      PATH_PROTOCOL,
      { name: 'positionId', kind: 'string', in: 'path', placeholder: '133302' },
    ],
  },
  {
    id: 'positions.charts',
    method: 'GET',
    path: '/v1/positions/{chainId}/{protocol}/{positionId}/charts',
    routeKey: 'v1.positions.charts',
    summary: 'Time series for one position.',
    params: [
      PATH_CHAIN,
      PATH_PROTOCOL,
      { name: 'positionId', kind: 'string', in: 'path', placeholder: '133302' },
      RANGE,
    ],
  },
  {
    id: 'chains',
    method: 'GET',
    path: '/v1/chains',
    // Free and unmetered — declared by the ABSENCE of a guard on the backend
    // controller, so there is no route key and nothing to charge.
    routeKey: null,
    summary: 'Supported chains. Free, no key needed.',
    params: [],
  },
  {
    id: 'protocols',
    method: 'GET',
    path: '/v1/protocols',
    routeKey: null,
    summary: 'Supported protocols. Free, no key needed.',
    params: [],
  },
];

export function findEndpoint(id: unknown): PlaygroundEndpoint | undefined {
  return typeof id === 'string' ? PLAYGROUND_ENDPOINTS.find((e) => e.id === id) : undefined;
}

/**
 * The form's starting values for one endpoint — only the params that declare a
 * `default`, so every other field still opens empty.
 *
 * A fresh object per call, and the whole `values` map is replaced with it when
 * the endpoint changes; seeding by merging would leave the previous endpoint's
 * entries behind, which is exactly what the picker resets to avoid.
 */
export function defaultValues(endpoint: PlaygroundEndpoint): Record<string, string> {
  const seeded: Record<string, string> = {};
  for (const param of endpoint.params) {
    if (param.default !== undefined) seeded[param.name] = param.default;
  }
  return seeded;
}

/**
 * Path segments are `encodeURIComponent`'d and then checked against a
 * conservative shape.
 *
 * Encoding alone is not enough: it stops a `../` or a `?` escaping the path,
 * but the value still reaches our own API, and a playground should not be the
 * thing that discovers how the backend handles an 8KB path segment. Anything
 * outside this alphabet is refused here rather than forwarded.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface BuiltRequest {
  path: string;
  search: string;
}

/**
 * Turn an endpoint plus user input into a path + query string, or explain why
 * not. Pure, so the browser can preview exactly what the server will send.
 */
export function buildRequest(
  endpoint: PlaygroundEndpoint,
  values: Record<string, string>,
): { ok: true; request: BuiltRequest } | { ok: false; error: string } {
  let path = endpoint.path;

  for (const param of endpoint.params.filter((p) => p.in === 'path')) {
    const raw = (values[param.name] ?? '').trim();
    if (!raw) return { ok: false, error: `${param.name} is required.` };
    if (!SAFE_SEGMENT.test(raw)) return { ok: false, error: `${param.name} has an unexpected format.` };
    if (param.options && !param.options.includes(raw)) {
      return { ok: false, error: `${param.name} must be one of: ${param.options.join(', ')}.` };
    }
    path = path.replace(`{${param.name}}`, encodeURIComponent(raw));
  }

  // A leftover placeholder means the catalogue and the template disagree — a
  // bug here rather than bad input, and it must not be forwarded as a literal.
  if (path.includes('{')) return { ok: false, error: 'This endpoint is misconfigured.' };

  const search = new URLSearchParams();
  for (const param of endpoint.params.filter((p) => p.in === 'query')) {
    const raw = (values[param.name] ?? '').trim();
    if (!raw) continue;
    if (param.options && !param.options.includes(raw)) {
      return { ok: false, error: `${param.name} must be one of: ${param.options.join(', ')}.` };
    }
    if (param.kind === 'number' && !/^-?\d+(\.\d+)?$/.test(raw)) {
      return { ok: false, error: `${param.name} must be a number.` };
    }
    if (raw.length > 256) return { ok: false, error: `${param.name} is too long.` };
    search.set(param.name, raw);
  }

  const qs = search.toString();
  return { ok: true, request: { path, search: qs ? `?${qs}` : '' } };
}
