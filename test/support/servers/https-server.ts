import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { join } from 'node:path';

/** The test-only certificates in test/fixtures/tls (see generate.sh there). */
const dir = join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'tls');
export const pem = (name: string): string => readFileSync(join(dir, name), 'utf8');
export const p12 = (): Buffer => readFileSync(join(dir, 'client.p12'));

export interface TlsServer {
  /** `https://localhost:<port>` */
  url: string;
  ipUrl: string;
  port: number;
  /** What the server saw of each connection's client certificate. */
  seen: { authorized: boolean; clientCommonName: string | undefined; path: string; method: string; headers: string[] }[];
  close(): Promise<void>;
}

export interface TlsServerOptions {
  /** Which certificate the server presents: `server` (signed by the test CA, right names), `mismatch` (wrong name), `selfsigned`. */
  certificate?: 'server' | 'mismatch' | 'selfsigned';
  /** Ask the client for a certificate (and check it against the test CA) without refusing those that have none. */
  requestClientCertificate?: boolean;
  /** What to answer for a path; default echo. */
  handler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;
}

export async function startTlsServer(options: TlsServerOptions = {}): Promise<TlsServer> {
  const name = options.certificate ?? 'server';
  const seen: TlsServer['seen'] = [];
  const server = https.createServer({
    key: pem(`${name}-key.pem`), cert: pem(`${name}.pem`), ca: pem('ca.pem'), requestCert: options.requestClientCertificate === true, rejectUnauthorized: false
  }, (req, res) => {
    const socket = req.socket as TLSSocket;
    const certificate = socket.getPeerCertificate();
    const subject = certificate !== undefined && Object.keys(certificate).length > 0 ? (certificate.subject as unknown as Record<string, string>)['CN'] : undefined;
    seen.push({ authorized: socket.authorized, clientCommonName: subject, path: req.url ?? '', method: req.method ?? '', headers: [...req.rawHeaders] });
    if (options.handler !== undefined) { options.handler(req, res); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ protocol: socket.getProtocol(), authorized: socket.authorized, clientCommonName: subject ?? null }));
  });
  const sockets = new Set<Duplex>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://localhost:${port}`, ipUrl: `https://127.0.0.1:${port}`, port, seen,
    close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); })
  };
}
