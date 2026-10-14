import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ReadModelsService } from './read-models.service.js';

/**
 * `GET /health/ready` — the read models' deploy readiness (design §6.7 / §13;
 * `readiness.ts` has the rule). Unauthenticated like `GET /health`, because
 * Railway's health check sends no secret; it reveals only per-model modes and
 * readiness reasons. 200 / 503, never cached.
 *
 * Lives in `ReadModelsModule` (not `HealthModule`) so the health module keeps
 * no dependency on the read models; Nest mounts both controllers under
 * `/health`. Point Railway's healthcheck at it only once a model is in `serve`
 * (with every model `off` it always answers 200).
 */
@Controller('health')
export class ReadModelsReadyController {
  constructor(@Inject(ReadModelsService) private readonly readModels: ReadModelsService) {}

  @Get('ready')
  ready(@Res({ passthrough: true }) res: { status(code: number): unknown; setHeader(name: string, value: string): unknown }) {
    const result = this.readModels.healthReady();
    res.status(result.status);
    res.setHeader('Cache-Control', 'no-store');
    return result.body;
  }
}
