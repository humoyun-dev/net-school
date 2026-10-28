import { Module } from '@nestjs/common';
import { Access } from '../../common/access.ts';
import { OrganizationService } from './organization.service.ts';
import { RoomsController } from './rooms.controller.ts';
import { SitesController } from './sites.controller.ts';

@Module({ controllers: [SitesController, RoomsController], providers: [Access, OrganizationService] })
export class OrganizationModule {}
