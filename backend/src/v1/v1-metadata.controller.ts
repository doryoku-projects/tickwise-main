import { Controller, Get, Inject } from '@nestjs/common';
import { CHAINS } from '../config/chains.config.js';
import { AppConfigService } from '../config/app-config.service.js';
import { getProtocolConfig } from '../config/protocols.config.js';

/**
 * Free, unauthenticated metadata endpoints (no API key, no metering) — mirrors
 * the Krystal/d-app convention. Source of truth is the chain + protocol config
 * intersected with the enabled integrations.
 */
@Controller('v1')
export class V1MetadataController {
  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  /**
   * Only chains with AT LEAST ONE enabled integration are advertised.
   *
   * This used to map over ALL of `CHAINS`, which meant a chain present in the
   * registry but with no data source was published here with `protocols: []` —
   * and the dashboard chain picker, the coverage panel and the docs coverage
   * matrix all derive from this response, so it read as supported coverage that
   * returns nothing. It also removed the ability to stage a chain: the intended
   * rollout for a new chain is to run its indexer with the backend URLs unset,
   * which requires the chain to be invisible here until it has a source.
   */
  @Get('chains')
  chains() {
    const integrations = this.config.enabledIntegrations;
    const live = Object.values(CHAINS).filter((c) =>
      integrations.some((i) => i.chainId === c.chainId),
    );
    return live.map((c) => ({
      chainId: c.chainId,
      slug: c.slug,
      name: c.name,
      shortName: c.shortName,
      explorerUrl: c.explorerUrl,
      nativeToken: c.nativeToken,
      wrappedNativeToken: c.wrappedNativeToken,
      protocols: integrations.filter((i) => i.chainId === c.chainId).map((i) => i.protocol),
    }));
  }

  @Get('protocols')
  protocols() {
    const byProtocol = new Map<string, number[]>();
    for (const i of this.config.enabledIntegrations) {
      const list = byProtocol.get(i.protocol) ?? [];
      list.push(i.chainId);
      byProtocol.set(i.protocol, list);
    }
    return [...byProtocol.entries()].map(([key, chainIds]) => {
      const p = getProtocolConfig(key);
      return {
        key,
        displayName: p?.displayName ?? key,
        version: p?.version ?? null,
        family: p?.family ?? null,
        chains: chainIds,
        enabled: true,
      };
    });
  }
}
