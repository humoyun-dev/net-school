import { Controller, Delete, HttpCode, Inject, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { HelpRequestsService } from './help-requests.service.ts';

@Controller('api/v1/help-requests')
export class HelpRequestsController {
  constructor(@Inject(HelpRequestsService) private readonly help: HelpRequestsService) {}

  // Idempotency-Key kerak emas: takroriy DELETE no-op (DELETE /remote-sessions/{id} kabi).
  @Delete(':helpRequestId')
  @HttpCode(204)
  async clear(@Param('helpRequestId') helpRequestId: string, @Req() req: Request): Promise<void> {
    await this.help.clear(requestContext(req), helpRequestId);
  }
}
