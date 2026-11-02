import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

// Upgrade'ga berilgan soketga HTTP server taymerlari endi tegmaydi: yarim ochiq mijoz uni abadiy ushlab turmasin.
export function refuse(socket: Duplex, status: number, text: string): void {
  socket.once('finish', socket.destroy);
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// API HTTP server'idagi yagona 'upgrade' tinglovchisi: yo'l bo'yicha WS handler; mos kelmasa 404.
@Injectable()
export class UpgradeRouter implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #routes: { pattern: RegExp; handler: UpgradeHandler }[] = [];
  #server: ReturnType<HttpAdapterHost['httpAdapter']['getHttpServer']> | undefined;

  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  route(pattern: RegExp, handler: UpgradeHandler): () => void {
    const entry = { pattern, handler };
    this.#routes.push(entry);
    return () => {
      const i = this.#routes.indexOf(entry);
      if (i >= 0) this.#routes.splice(i, 1);
    };
  }

  onApplicationBootstrap(): void {
    this.#server = this.adapterHost.httpAdapter.getHttpServer();
    this.#server.on('upgrade', this.#dispatch);
  }

  onModuleDestroy(): void {
    this.#server?.off('upgrade', this.#dispatch);
  }

  readonly #dispatch = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => {}); // upgrade kutilayotganda uzilgan soket jarayonni yiqitmasin
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '', 'https://localhost').pathname;
    } catch {
      refuse(socket, 400, 'Bad Request');
      return;
    }
    const route = this.#routes.find((r) => r.pattern.test(pathname));
    if (!route) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    route.handler(req, socket, head);
  };
}
