import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { correlationIdOf } from './correlation.ts';
import { ApiError, type ApiErrorCode, defaultMessage, ERROR_STATUS } from './errors.ts';

const HTTP_CODE: Record<number, ApiErrorCode> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'scope_denied',
  404: 'not_found',
  409: 'conflict',
  413: 'validation_failed',
  415: 'validation_failed',
  429: 'rate_limited',
};

// Har xato barqaror konvertga aylanadi; kutilmagan xatoning matni mijozga chiqmaydi.
@Catch()
export class ErrorFilter implements ExceptionFilter {
  readonly #logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    let code: ApiErrorCode = 'internal';
    let message = defaultMessage('internal');
    if (exception instanceof ApiError) {
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      code = HTTP_CODE[exception.getStatus()] ?? 'internal';
      message = defaultMessage(code);
    }
    // Kutilmagan xato faqat serverda log qilinadi: correlationId bo'yicha topiladi.
    const expected =
      exception instanceof ApiError || (exception instanceof HttpException && exception.getStatus() < 500);
    if (!expected) {
      const detail = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
      this.#logger.error(`Unhandled error [${correlationIdOf(req)}] ${req.method} ${req.path}`, detail);
    }
    if (res.headersSent) return;
    res.status(ERROR_STATUS[code]).json({ error: { code, message, correlationId: correlationIdOf(req) } });
  }
}
