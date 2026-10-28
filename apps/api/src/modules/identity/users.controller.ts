import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { createUserRequestSchema, roleInputSchema, updateUserRequestSchema } from '@netschool/contracts';
import type { Request } from 'express';
import { requestContext } from '../../common/request-context.ts';
import { parseBody } from '../../common/validation.ts';
import { UsersService } from './users.service.ts';

@Controller('api/v1/users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  async list(@Query('siteId') siteId: string | undefined, @Req() req: Request) {
    return { users: await this.users.list(requestContext(req), siteId) };
  }

  @Post()
  create(@Body() body: unknown, @Req() req: Request) {
    return this.users.create(requestContext(req), parseBody(createUserRequestSchema, body));
  }

  @Patch(':userId')
  update(@Param('userId') userId: string, @Body() body: unknown, @Req() req: Request) {
    return this.users.setDisabled(requestContext(req), userId, parseBody(updateUserRequestSchema, body).disabled);
  }

  @Post(':userId/roles')
  addRole(@Param('userId') userId: string, @Body() body: unknown, @Req() req: Request) {
    return this.users.addRole(requestContext(req), userId, parseBody(roleInputSchema, body));
  }

  @Delete(':userId/roles/:assignmentId')
  @HttpCode(204)
  async removeRole(
    @Param('userId') userId: string,
    @Param('assignmentId') assignmentId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.users.removeRole(requestContext(req), userId, assignmentId);
  }
}
