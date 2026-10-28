import 'reflect-metadata';
import { Global, type INestApplication, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLOCK } from './common/clock.ts';
import { correlationMiddleware } from './common/correlation.ts';
import { ErrorFilter } from './common/error-filter.ts';
import { Idempotency } from './common/idempotency.ts';
import { OriginGuard } from './common/origin-guard.ts';
import { API_CONFIG, type ApiConfig } from './config/config.ts';
import { DB, type Db } from './db/client.ts';
import { AuditModule } from './modules/audit/audit.module.ts';
import { CommandsModule } from './modules/commands/commands.module.ts';
import { DevicesModule } from './modules/devices/devices.module.ts';
import { DEVICE_MANAGEMENT, type DeviceManagementFactory } from './modules/devices/mesh.ts';
import { EventsModule } from './modules/events/events.module.ts';
import { HealthController } from './modules/health/health.controller.ts';
import { IdentityModule } from './modules/identity/identity.module.ts';
import { LessonsModule } from './modules/lessons/lessons.module.ts';
import { OrganizationModule } from './modules/organization/organization.module.ts';

export interface CreateAppOptions {
  db: Db;
  now?: () => number;
  controllers?: Type[];
  // MeshCentral adapter; null yoki berilmasa — MeshCentral'siz rejim.
  deviceManagement?: DeviceManagementFactory | null;
  logger?: false | ('log' | 'warn' | 'error')[];
}

export async function createApp(config: ApiConfig, opts: CreateAppOptions): Promise<INestApplication> {
  // Hamma modul ko'radigan umumiy qiymatlar.
  @Global()
  @Module({
    providers: [
      { provide: API_CONFIG, useValue: config },
      { provide: DB, useValue: opts.db },
      { provide: CLOCK, useValue: opts.now ?? Date.now },
      { provide: DEVICE_MANAGEMENT, useValue: opts.deviceManagement ?? null },
      Idempotency,
    ],
    exports: [API_CONFIG, DB, CLOCK, DEVICE_MANAGEMENT, Idempotency],
  })
  class CoreModule {}

  @Module({
    imports: [
      CoreModule,
      AuditModule,
      EventsModule,
      IdentityModule,
      OrganizationModule,
      DevicesModule,
      LessonsModule,
      CommandsModule,
    ],
    controllers: [HealthController, ...(opts.controllers ?? [])],
    providers: [
      { provide: APP_FILTER, useClass: ErrorFilter },
      { provide: APP_GUARD, useClass: OriginGuard },
    ],
  })
  class AppModule {}

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    httpsOptions: { cert: config.tls.cert, key: config.tls.key },
    bodyParser: false,
    rawBody: true, // qurilma imzosi aynan kelgan baytlar ustida tekshiriladi
    logger: opts.logger ?? ['log', 'warn', 'error'],
  });
  app.disable('x-powered-by');
  app.use(correlationMiddleware);
  app.useBodyParser('json', { limit: '64kb' });
  return app;
}
