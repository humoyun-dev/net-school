import 'reflect-metadata';
import { type INestApplication, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { correlationMiddleware } from './common/correlation.ts';
import { ErrorFilter } from './common/error-filter.ts';
import { OriginGuard } from './common/origin-guard.ts';
import { API_CONFIG, type ApiConfig } from './config/config.ts';
import { DB, type Db } from './db/client.ts';
import { AuditModule } from './modules/audit/audit.module.ts';
import { HealthController } from './modules/health/health.controller.ts';

export interface CreateAppOptions {
  db: Db;
  controllers?: Type[];
  logger?: false | ('log' | 'warn' | 'error')[];
}

export async function createApp(config: ApiConfig, opts: CreateAppOptions): Promise<INestApplication> {
  @Module({
    imports: [AuditModule],
    controllers: [HealthController, ...(opts.controllers ?? [])],
    providers: [
      { provide: API_CONFIG, useValue: config },
      { provide: DB, useValue: opts.db },
      { provide: APP_FILTER, useClass: ErrorFilter },
      { provide: APP_GUARD, useClass: OriginGuard },
    ],
  })
  class AppModule {}

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    httpsOptions: { cert: config.tls.cert, key: config.tls.key },
    bodyParser: false,
    logger: opts.logger ?? ['log', 'warn', 'error'],
  });
  app.disable('x-powered-by');
  app.use(correlationMiddleware);
  app.useBodyParser('json', { limit: '64kb' });
  return app;
}
