import { Controller, Get, Header, Inject, NotFoundException, Req } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { clientLimiterKey } from './client-ip.js';

interface EchoRequest {
  ip?: string;
  ips?: string[];
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}

/**
 * `GET /diag/client-ip` — what this process makes of the caller's address, so
 * `TRUST_PROXY_HOPS` can be set from a measurement instead of a guess. Off
 * unless `CLIENT_IP_ECHO=on` (then a 404), and meant to be switched on only for
 * the minutes the check takes.
 *
 * It returns the caller's OWN request metadata to the caller, so it discloses
 * nothing about anyone else. How to read it, from two different networks, once
 * with forged headers (`-H 'X-Forwarded-For: 1.2.3.4' -H 'X-Real-IP: 5.6.7.8'`):
 *  - `ip` must be the caller's real address, and unchanged by the forged
 *    headers. If it is the proxy's address, `TRUST_PROXY_HOPS` is too low; if it
 *    follows the forged header, it is too high (or the proxy does not overwrite
 *    the header), and a client could mint any number of budgets.
 *  - `socketPeer` is the connection's other end: the proxy.
 */
@Controller('diag')
export class ClientIpEchoController {
  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  @Get('client-ip')
  @Header('Cache-Control', 'no-store')
  echo(@Req() req: EchoRequest) {
    if (!this.config.clientIpEcho) throw new NotFoundException();
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value.join(', ') : (value ?? null);
    };
    return {
      ip: req.ip ?? null,
      ips: req.ips ?? [],
      limiterKey: clientLimiterKey(req.ip) ?? null,
      socketPeer: req.socket?.remoteAddress ?? null,
      trustProxyHops: this.config.trustProxyHops,
      xForwardedFor: header('x-forwarded-for'),
      xRealIp: header('x-real-ip'),
      forwarded: header('forwarded'),
      cfConnectingIp: header('cf-connecting-ip'),
    };
  }
}
