import { createServer, type Socket } from 'node:net';
import { z } from 'zod';
import type { ExtensionReport, WebPolicyPush } from '../core/policy-sync.ts';

// P2c: o'quvchi sessiyasidagi named pipe (`\\.\pipe\netschool-web-<sessiya>`). Chrome/Edge native messaging host'i
// (netschool-helper.exe) shu yerga ulanib, web siyosatini extension'ga uzatadi va extension natijasini qaytaradi.
// Protokol: har xabar bitta JSON qator. Server faqat o'qish uchun ma'lumot beradi; noto'g'ri xabar ulanishni yopadi.

export const MAX_LINE_BYTES = 1024 * 1024;

const appliedSchema = z.strictObject({
  type: z.literal('applied'),
  browser: z.enum(['chrome', 'edge']),
  extensionVersion: z.string().regex(/^[0-9.]{1,32}$/),
  baselineHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  lessonHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

export function webPipeName(sessionId: number): string {
  return `\\\\.\\pipe\\netschool-web-${sessionId}`;
}

export async function startWebPipe(
  path: string,
  sync: { current(): WebPolicyPush; onExtensionReport(r: ExtensionReport): void },
  subscribe: (fn: (push: WebPolicyPush) => void) => () => void,
): Promise<{ close(): Promise<void> }> {
  const clients = new Set<Socket>();
  const send = (socket: Socket, push: WebPolicyPush) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify({ type: 'policy', ...push })}\n`);
  };
  const unsubscribe = subscribe((push) => {
    for (const socket of clients) send(socket, push);
  });

  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_LINE_BYTES && !buf.includes('\n')) {
        socket.destroy();
        return;
      }
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let parsed: z.infer<typeof appliedSchema>;
        try {
          parsed = appliedSchema.parse(JSON.parse(line));
        } catch {
          socket.destroy();
          return;
        }
        const { type: _type, ...report } = parsed;
        sync.onExtensionReport(report);
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
    send(socket, sync.current());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        unsubscribe();
        for (const socket of clients) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
