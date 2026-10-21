import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/** A small HTTP proxy for the tests: it forwards plain requests and sets up CONNECT tunnels, and it can ask for credentials. */
export interface MockProxy {
  host: string;
  port: number;
  /** The address of the proxy as a person would write it. */
  url: string;
  /** What reached the proxy: plain requests by their request line, tunnels by their authority. */
  seen: { kind: 'forward' | 'tunnel'; target: string; proxyAuthorization: string | undefined; rawHeaders: string[] }[];
  close(): Promise<void>;
}

export async function startProxy(options: { credentials?: string; refuse?: number } = {}): Promise<MockProxy> {
  const seen: MockProxy['seen'] = [];
  const expected = options.credentials === undefined ? undefined : `Basic ${Buffer.from(options.credentials).toString('base64')}`;
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    const authorization = req.headers['proxy-authorization'];
    seen.push({ kind: 'forward', target: req.url ?? '', proxyAuthorization: authorization, rawHeaders: [...req.rawHeaders] });
    if (options.refuse !== undefined) { res.statusCode = options.refuse; res.end(); return; }
    if (expected !== undefined && authorization !== expected) { res.statusCode = 407; res.setHeader('Proxy-Authenticate', 'Basic realm="test"'); res.end(); return; }
    const target = new URL(req.url ?? '');
    // The proxy forwards without the header that was meant for it.
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const upstream = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers, agent: false }, answer => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', (req, client, head) => {
    const authorization = req.headers['proxy-authorization'];
    seen.push({ kind: 'tunnel', target: req.url ?? '', proxyAuthorization: authorization, rawHeaders: [...req.rawHeaders] });
    if (options.refuse !== undefined) { client.end(`HTTP/1.1 ${options.refuse} Refused\r\n\r\n`); return; }
    if (expected !== undefined && authorization !== expected) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n'); return; }
    const [host, port] = (req.url ?? '').replace(/^\[|\](?=:)/g, '').split(/:(?=\d+$)/);
    const upstream = net.connect(Number(port), host as string, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => upstream.destroy());
    sockets.add(upstream);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  return { host: '127.0.0.1', port, url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}
