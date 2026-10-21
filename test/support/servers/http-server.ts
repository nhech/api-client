import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBrotliCompress, createDeflate, createDeflateRaw, createGzip, gzipSync } from 'node:zlib';

/** An HTTP server on the loopback for the tests of the engine. Every request it receives is recorded. */
export interface RecordedRequest {
  method: string;
  url: string;
  /** Header names and values exactly as they arrived, in order. */
  rawHeaders: string[];
  body: Buffer;
}

export interface MockServer {
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Connections that were closed by the client before the server finished. */
  aborted: number;
  close(): Promise<void>;
}

export const headerValues = (request: RecordedRequest, name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) if ((request.rawHeaders[index] as string).toLowerCase() === name.toLowerCase()) values.push(request.rawHeaders[index + 1] as string);
  return values;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The routes of the mock server; the path decides what it does. */
async function route(req: http.IncomingMessage, res: http.ServerResponse, record: RecordedRequest, server: { port: number }): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const query = url.searchParams;
  if (path === '/echo') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: record.method, url: record.url, headers: record.rawHeaders, body: record.body.toString('utf8') }));
  } else if (path === '/upload') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ length: record.body.length, sha256: createHash('sha256').update(record.body).digest('hex'), contentLength: req.headers['content-length'] ?? null, chunked: req.headers['transfer-encoding'] ?? null }));
  } else if (path.startsWith('/status/')) {
    res.statusCode = Number(path.slice('/status/'.length));
    res.end(`status ${res.statusCode}`);
  } else if (path.startsWith('/redirect/')) {
    const left = Number(path.slice('/redirect/'.length));
    if (left <= 0) { res.end('arrived'); return; }
    res.statusCode = Number(query.get('status') ?? 302);
    res.setHeader('Location', `/redirect/${left - 1}${query.has('status') ? `?status=${query.get('status')}` : ''}`);
    res.end('moving');
  } else if (path === '/to') {
    res.statusCode = Number(query.get('status') ?? 302);
    res.setHeader('Location', query.get('to') ?? '/');
    res.end('moving elsewhere');
  } else if (path === '/loop') {
    res.statusCode = 302;
    res.setHeader('Location', '/loop');
    res.end();
  } else if (path === '/slow') {
    await sleep(Number(query.get('ms') ?? 300));
    res.end('slow');
  } else if (path === '/hang') {
    // Never answers.
  } else if (path === '/stall') {
    res.write('start');
    // Sends a little and then nothing.
  } else if (path === '/gzip') {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(gzipSync('hello gzip '.repeat(100)));
  } else if (path === '/deflate' || path === '/deflate-raw' || path === '/br' || path === '/identity' || path === '/zstd') {
    const text = Buffer.from(`hello ${path.slice(1)} `.repeat(100));
    if (path === '/identity') { res.setHeader('Content-Encoding', 'identity'); res.end(text); return; }
    if (path === '/zstd') { res.setHeader('Content-Encoding', 'zstd'); res.end(text); return; }
    res.setHeader('Content-Encoding', path === '/br' ? 'br' : 'deflate');
    const stream = path === '/br' ? createBrotliCompress() : path === '/deflate' ? createDeflate() : createDeflateRaw();
    stream.pipe(res);
    stream.end(text);
  } else if (path === '/bomb') {
    res.setHeader('Content-Encoding', 'gzip');
    const gzip = createGzip();
    gzip.pipe(res);
    const chunk = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < Number(query.get('mb') ?? 300); index++) { if (!gzip.write(chunk)) await new Promise(resolve => gzip.once('drain', resolve)); if (res.destroyed) return; }
    gzip.end();
  } else if (path === '/big') {
    const total = Number(query.get('bytes') ?? 1_000_000);
    res.setHeader('Content-Length', String(total));
    const chunk = Buffer.alloc(64 * 1024, 120);
    for (let sent = 0; sent < total;) {
      const piece = chunk.subarray(0, Math.min(chunk.length, total - sent));
      sent += piece.length;
      if (!res.write(piece)) await new Promise(resolve => res.once('drain', resolve));
      if (res.destroyed) return;
    }
    res.end();
  } else if (path === '/chunked') {
    for (const part of ['one ', 'two ', 'three']) { res.write(part); await sleep(10); }
    res.end();
  } else if (path === '/bytes') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(Buffer.from(Array.from({ length: 256 }, (_, value) => value)));
  } else if (path === '/set-cookies') {
    res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
    res.end('cookies set');
  } else if (path === '/multi-header') {
    res.setHeader('X-Multi', ['first', 'second']);
    res.setHeader('x-lower', 'lower');
    res.setHeader('X-UPPER', 'UPPER');
    res.end('headers');
  } else if (path === '/reset') {
    res.write('partial');
    await sleep(20);
    req.socket.destroy();
  } else if (path === '/garbage') {
    req.socket.end('this is not http\r\n\r\n');
  } else if (path === '/no-content') {
    res.statusCode = 204;
    res.end();
  } else if (path === '/not-modified') {
    res.statusCode = 304;
    res.end();
  } else if (path === '/port') {
    res.end(String(server.port));
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
}

export async function startServer(host = '127.0.0.1'): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const state = { port: 0 };
  const result: MockServer = { url: '', port: 0, requests, aborted: 0, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    res.on('close', () => { if (!res.writableFinished) result.aborted++; });
    req.on('end', () => {
      const record: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', rawHeaders: [...req.rawHeaders], body: Buffer.concat(chunks) };
      requests.push(record);
      route(req, res, record, state).catch(() => { res.destroy(); });
    });
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => resolve()); });
  state.port = (server.address() as AddressInfo).port;
  result.port = state.port;
  result.url = `http://${host.includes(':') ? `[${host}]` : host}:${state.port}`;
  result.close = () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
  return result;
}
