import { isIP } from 'node:net';

/**
 * The key one client is budgeted under: an IPv4 address as itself, an IPv6
 * address by its /64 (one household or one carrier customer holds a whole /64,
 * so a per-address key would give a scraper 2^64 buckets). An IPv4-mapped IPv6
 * address (`::ffff:1.2.3.4`, what a dual-stack socket reports) is the IPv4.
 *
 * `undefined` for anything that is not an address: the caller cannot attribute
 * the request and must not invent a bucket.
 *
 * This is only as truthful as `req.ip`. Behind a reverse proxy that needs
 * `TRUST_PROXY_HOPS` set to the number of hops, or `req.ip` is the proxy's own
 * address and every visitor shares one key.
 */
export function clientLimiterKey(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let ip = raw.trim();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version === 6) {
    const groups = expandIpv6(ip);
    return groups ? `${groups.slice(0, 4).join(':')}::/64` : undefined;
  }
  return undefined;
}

/** The 8 hextets of an IPv6 address, lower-case and without leading zeros. */
function expandIpv6(ip: string): string[] | undefined {
  // An embedded IPv4 tail (`::1.2.3.4`) is two hextets.
  let text = ip.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const octets = tail.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return undefined;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, text.length - tail[0].length)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return undefined;
  const all = halves.length === 1 ? head : [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (all.length !== 8) return undefined;
  return all.map((h) => h.replace(/^0+(?=.)/, ''));
}
