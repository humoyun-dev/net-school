import { Controller, Get } from '@nestjs/common';

@Controller('api/v1/healthz')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
