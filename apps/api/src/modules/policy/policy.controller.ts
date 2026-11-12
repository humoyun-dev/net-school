import { Body, Controller, Get, Headers, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { baselineDocumentSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { PolicyService, parseIfMatch, parseSiteId } from './policy.service.ts';

// Bazaviy siyosat (IT admin): versiyalar immutable, yozish `If-Match` bilan.
@Controller('api/v1/policies')
export class PolicyController {
  constructor(@Inject(PolicyService) private readonly policies: PolicyService) {}

  @Get('baseline')
  baseline(@Query('siteId') siteId: unknown, @Req() req: Request) {
    return this.policies.getBaseline(requestContext(req), parseSiteId(siteId));
  }

  @Put('baseline')
  async putBaseline(
    @Query('siteId') siteId: unknown,
    @Headers('if-match') ifMatch: unknown,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const site = parseSiteId(siteId);
    const expected = parseIfMatch(ifMatch);
    const doc = parseBody(baselineDocumentSchema, body);
    const result = await this.policies.putBaseline(requestContext(req), site, expected, doc);
    res.status(result.status);
    return result.body;
  }

  @Get('baseline/versions')
  versions(@Query('siteId') siteId: unknown, @Req() req: Request) {
    return this.policies.listBaseline(requestContext(req), parseSiteId(siteId));
  }

  @Post('baseline/versions/:id/restore')
  async restore(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.policies.restoreBaseline(requestContext(req), id, parseIfMatch(ifMatch));
    res.status(result.status);
    return result.body;
  }
}
