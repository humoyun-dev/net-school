import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { makeCert } from '@netschool/test-support';
import { type WebSocket, WebSocketServer } from 'ws';

type Handler = (socket: WebSocket, msg: Record<string, unknown>) => void;

// MeshCentral control.ashx'ning minimal o'xshashi: x-meshauth tekshiradi, serverinfo yuboradi.
export class FakeMeshServer {
  url = '';
  ca = '';
  credentials = { user: 'admin', pass: 'secret' };
  connectionCount = 0;
  silent = false; // true: serverinfo yubormaydi (osilgan server)
  mute = false; // true: ping'ga pong qaytarmaydi (o'lik ulanish)
  handle: Handler = () => {};
  readonly sockets = new Set<WebSocket>();
  #https!: Server;
  #wss!: WebSocketServer;
  #port = 0;

  static async start(): Promise<FakeMeshServer> {
    const server = new FakeMeshServer();
    const cert = await makeCert();
    server.ca = cert.cert;
    server.#https = createServer({ key: cert.key, cert: cert.cert });
    server.#wss = new WebSocketServer({ server: server.#https, path: '/control.ashx', autoPong: false });
    server.#wss.on('connection', (socket, req) =>
      server.#onConnection(socket, String(req.headers['x-meshauth'] ?? '')),
    );
    await new Promise<void>((r) => server.#https.listen(0, '127.0.0.1', r));
    server.#port = (server.#https.address() as AddressInfo).port;
    server.url = `wss://localhost:${server.#port}/control.ashx`;
    return server;
  }

  #onConnection(socket: WebSocket, auth: string) {
    this.connectionCount++;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('ping', (data) => {
      if (!this.mute) socket.pong(data);
    });
    const [user = '', pass = ''] = auth.split(',').map((p) => Buffer.from(p, 'base64').toString());
    if (user !== this.credentials.user || pass !== this.credentials.pass) {
      socket.send(JSON.stringify({ action: 'close', cause: 'noauth', msg: 'noauth-2d' }));
      socket.close();
      return;
    }
    socket.on('message', (data) => this.handle(socket, JSON.parse(String(data))));
    if (!this.silent) socket.send(JSON.stringify({ action: 'serverinfo', serverinfo: {} }));
  }

  send(msg: unknown) {
    for (const socket of this.sockets) socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  dropAll() {
    for (const socket of this.sockets) socket.terminate();
  }

  async close() {
    this.dropAll();
    await new Promise<void>((r) => this.#wss.close(() => r()));
    await new Promise<void>((r) => this.#https.close(() => r()));
  }
}
