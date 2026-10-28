import type { z } from 'zod';
import { ApiError } from './errors.ts';

// zod xatosining tafsiloti mijozga chiqmaydi — faqat barqaror kod.
export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError('validation_failed');
  return result.data;
}
