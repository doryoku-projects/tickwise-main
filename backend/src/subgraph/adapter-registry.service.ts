import { Inject, Injectable } from '@nestjs/common';
import { getProtocolConfig } from '../config/protocols.config.js';
import { RevertCompatibleAdapter } from './adapters/revert-compatible.adapter.js';
import { EnvioAdapter } from './adapters/envio.adapter.js';
import type { PositionAdapter } from './position-adapter.js';

@Injectable()
export class AdapterRegistryService {
  constructor(
    @Inject(RevertCompatibleAdapter)
    private readonly revertCompatibleAdapter: RevertCompatibleAdapter,
    @Inject(EnvioAdapter)
    private readonly envioAdapter: EnvioAdapter,
  ) {}

  resolve(protocol: string): PositionAdapter {
    const protocolConfig = getProtocolConfig(protocol);
    if (!protocolConfig) {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }
    // The registry reads `protocols.config` and NOTHING ELSE. There used to be an
    // env short-circuit here (`PONDER_V4_ENABLED`) that routed uniswap-v4 to the
    // aggregates adapter ahead of this switch, which meant the declared adapter and
    // the resolved one could disagree — and the env var was a raw `process.env`
    // read, so it was invisible to the Zod schema, to `config.spec` and to
    // `tsx watch`'s reload. The cutover deleted it; the declaration is the answer.
    if (protocolConfig.adapter === 'envio-clmm') {
      return this.envioAdapter;
    }
    if (protocolConfig.adapter === 'revert-compatible-clmm') {
      return this.revertCompatibleAdapter;
    }
    throw new Error(`No adapter registered for protocol: ${protocol}`);
  }
}
