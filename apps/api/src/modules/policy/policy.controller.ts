import { Body, Controller, Get, Headers, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { baselineDocumentSchema, lessonDocumentSchema } from '@netschool/contracts';
import type { Request, Response } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { PolicyService, parseIfMatch, parseSiteId } from './policy.service.ts';

// Bazaviy (IT admin) va dars (o'qituvchi) siyosati: versiyalar immutable, yozish `If-Match` bilan.
@Controller('api/v1')
export class PolicyController {
  constructor(@Inject(PolicyService) private readonly policies: PolicyService) {}

  @Get('policies/baseline')
  baseline(@Query('siteId') siteId: unknown, @Req() req: Request) {
    return this.policies.getBaseline(requestContext(req), parseSiteId(siteId));
  }

  @Put('policies/baseline')
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

  @Get('policies/baseline/versions')
  versions(@Query('siteId') siteId: unknown, @Req() req: Request) {
    return this.policies.listBaseline(requestContext(req), parseSiteId(siteId));
  }

  @Post('policies/baseline/versions/:id/restore')
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

  @Get('lessons/:lessonId/policy')
  lesson(@Param('lessonId') lessonId: string, @Req() req: Request) {
    return this.policies.getLesson(requestContext(req), lessonId);
  }

  @Put('lessons/:lessonId/policy')
  async putLesson(
    @Param('lessonId') lessonId: string,
    @Headers('if-match') ifMatch: unknown,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const expected = parseIfMatch(ifMatch);
    const doc = parseBody(lessonDocumentSchema, body);
    const result = await this.policies.putLesson(requestContext(req), lessonId, expected, doc);
    res.status(result.status);
    return result.body;
  }
}
