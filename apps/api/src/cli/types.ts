import type { Db, DbDriver } from '../db/client.ts';

export interface CliEnv {
  db: Db;
  driver: DbDriver;
  stdout: { write(text: string): void };
}

// Exit kodlari: 0 muvaffaqiyat, 1 noto'g'ri foydalanish/topilmadi, 2 holat ruxsat bermaydi.
export type ExitCode = 0 | 1 | 2;
