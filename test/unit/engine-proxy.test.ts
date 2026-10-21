import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bypassesProxy, parseProxy, proxyAuthorization, proxyConfigFromEnv, resolveProxy, type ProxyConfig } from '../../src/engine/proxy';
import { send, type SendOptions } from '../../src/engine/send';
import { EngineError, type HeaderList, type WireRequest, type WireResponse } from '../../src/engine/types';
import { headerValues, startServer } from '../support/servers/http-server';
import { pem, startTlsServer } from '../support/servers/https-server';
import { startProxy } from '../support/servers/proxy-server';

const BASE: SendOptions = { timeoutMs: 10_000, followRedirects: true, maxRedirects: 10, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] }, responseLimitBytes: 1024 * 1024 };
const get = (url: string, headers: HeaderList = []): WireRequest => ({ method: 'GET', url, headers });
const text = (response: WireResponse): string => Buffer.from(response.body.kind === 'memory' ? response.body.bytes : new Uint8Array()).toString('utf8');
const rejects = async (promise: Promise<unknown>, code: string): Promise<EngineError> => {
  try { await promise; } catch (error) {
    assert.ok(error instanceof EngineError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  return assert.fail(`expected ${code}`);
};

test('A proxy address is read with or without a scheme and with credentials; an https proxy and nonsense are refused', () => {
  assert.deepEqual(parseProxy('proxy.corp:8080'), { host: 'proxy.corp', port: 8080 });
  assert.deepEqual(parseProxy('http://proxy.corp'), { host: 'proxy.corp', port: 80 });
  assert.deepEqual(parseProxy('http://us%40er:p%3Ass@10.0.0.1:3128'), { host: '10.0.0.1', port: 3128, auth: 'us@er:p:ss' });
  assert.deepEqual(parseProxy('http://[::1]:3128'), { host: '::1', port: 3128 });
  assert.throws(() => parseProxy('https://proxy.corp:8080'), /only http proxies/);
  assert.throws(() => parseProxy('socks5://proxy.corp:1080'), /not supported/);
  assert.throws(() => parseProxy('http://'), /not valid/);
  assert.equal(proxyAuthorization({ host: 'h', port: 1 }), undefined);
  assert.equal(proxyAuthorization({ host: 'h', port: 1, auth: 'aladdin:opensesame' }), 'Basic YWxhZGRpbjpvcGVuc2VzYW1l');
  assert.equal(proxyAuthorization({ host: 'h', port: 1, auth: 'only-name' }), `Basic ${Buffer.from('only-name:').toString('base64')}`);
});

test('The no-proxy list: names, suffixes, wildcards, ports, addresses and everything', () => {
  const cases: [string, string, string, boolean][] = [
    ['example.com', '443', 'example.com', true], ['api.example.com', '443', 'example.com', true], ['api.example.com', '443', '.example.com', true], ['example.com', '443', '.example.com', true],
    ['api.example.com', '443', '*.example.com', true], ['badexample.com', '443', 'example.com', false], ['example.com', '443', 'api.example.com', false],
    ['example.com', '8080', 'example.com:8080', true], ['example.com', '443', 'example.com:8080', false], ['10.1.2.3', '80', '10.1.2.3', true], ['10.1.2.4', '80', '10.1.2.3', false],
    ['anything.test', '80', '*', true], ['a.test', '80', 'x.test, a.test ,y.test', true], ['a.test', '80', 'x.test y.test', false], ['A.TEST', '80', 'a.test', true], ['a.test', '80', '', false], ['::1', '80', '[::1]', true]
  ];
  for (const [host, port, list, expected] of cases) assert.equal(bypassesProxy(host, port, list), expected, `${host}:${port} in "${list}"`);
  assert.equal(bypassesProxy('a.test', '80', undefined), false);
});

test('The proxy for an address: by scheme, then the common one, with loopback and the no-proxy list going direct', () => {
  const config: ProxyConfig = { all: 'all.corp:1', http: 'http.corp:2', noProxy: 'internal.test' };
  const at = (url: string, over: ProxyConfig = config) => resolveProxy(new URL(url), over);
  assert.deepEqual(at('http://x.test/'), { host: 'http.corp', port: 2 });
  assert.deepEqual(at('https://x.test/'), { host: 'all.corp', port: 1 });
  assert.deepEqual(at('https://x.test/', { https: 'secure.corp:3', all: 'all.corp:1' }), { host: 'secure.corp', port: 3 });
  assert.equal(at('https://internal.test/'), undefined);
  assert.equal(at('http://localhost:3000/'), undefined);
  assert.equal(at('http://127.0.0.1/'), undefined);
  assert.deepEqual(at('http://127.0.0.1/', { ...config, proxyLoopback: true }), { host: 'http.corp', port: 2 });
  assert.equal(at('http://x.test/', {}), undefined);
  assert.equal(resolveProxy(new URL('http://x.test/'), undefined), undefined);
  assert.equal(at('http://x.test/', { all: '' }), undefined);
});

test('The environment names a proxy and a no-proxy list in either case', () => {
  assert.deepEqual(proxyConfigFromEnv({ HTTP_PROXY: 'a:1', https_proxy: 'b:2', NO_PROXY: 'x.test', no_proxy: 'ignored' }), { http: 'a:1', https: 'b:2', noProxy: 'x.test' });
  assert.deepEqual(proxyConfigFromEnv({ http_proxy: 'c:3', HTTPS_PROXY: '' }), { http: 'c:3' });
  assert.deepEqual(proxyConfigFromEnv({}), {});
});

test('A plain request through a proxy names the whole address, the proxy gets its credentials and the server never does', async () => {
  const server = await startServer();
  const proxy = await startProxy({ credentials: 'aladdin:opensesame' });
  try {
    const response = await send(get(`${server.url}/echo?x=1`, [['X-Custom', 'kept']]), { ...BASE, proxy: { all: `http://aladdin:opensesame@127.0.0.1:${proxy.port}`, proxyLoopback: true } });
    assert.equal(response.status, 200);
    assert.deepEqual(proxy.seen.map(item => [item.kind, item.target]), [['forward', `${server.url}/echo?x=1`]]);
    assert.equal(proxy.seen[0]?.proxyAuthorization, 'Basic YWxhZGRpbjpvcGVuc2VzYW1l');
    assert.deepEqual(headerValues(server.requests[0] as never, 'proxy-authorization'), [], 'the credentials stopped at the proxy');
    assert.deepEqual(headerValues(server.requests[0] as never, 'x-custom'), ['kept']);
    assert.deepEqual(headerValues(server.requests[0] as never, 'host'), [`127.0.0.1:${server.port}`], 'the Host header names the server, not the proxy');
  } finally { await proxy.close(); await server.close(); }
});

test('A proxy that wants credentials and does not get them is a "proxy" error that says how to give them', async () => {
  const server = await startServer();
  const proxy = await startProxy({ credentials: 'aladdin:opensesame' });
  try {
    const response = await send(get(`${server.url}/echo`), { ...BASE, proxy: { all: proxy.url, proxyLoopback: true } });
    assert.equal(response.status, 407, 'a plain request gets the proxy answer as it is');
    const tls = await startTlsServer();
    try {
      const error = await rejects(send(get(`${tls.url}/`), { ...BASE, proxy: { all: proxy.url, proxyLoopback: true } }), 'proxy');
      assert.match(error.message, /asks for a user name and password/);
      assert.match(error.hint, /http:\/\/user:password@host:port/);
      const refused = await startProxy({ refuse: 403 });
      try {
        const denied = await rejects(send(get(`${tls.url}/`), { ...BASE, proxy: { all: refused.url, proxyLoopback: true } }), 'proxy');
        assert.match(denied.message, /refused the tunnel to localhost:\d+ \(403 Refused\)/);
      } finally { await refused.close(); }
    } finally { await tls.close(); }
  } finally { await proxy.close(); await server.close(); }
});

test('An https request goes through a tunnel, the handshake happens inside it with the real server, and the proxy sees only the address', async () => {
  const tls = await startTlsServer({ requestClientCertificate: true });
  const proxy = await startProxy({ credentials: 'user:pw' });
  try {
    const response = await send(get(`${tls.url}/secret-path`, [['Authorization', 'Bearer never-seen-by-proxy']]), {
      ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')], cert: pem('client.pem'), key: pem('client-key.pem') }, proxy: { all: `http://user:pw@127.0.0.1:${proxy.port}`, proxyLoopback: true }
    });
    assert.equal(response.status, 200);
    assert.equal(response.tls?.authorized, true);
    assert.equal(response.tls?.subject, 'localhost');
    assert.deepEqual(proxy.seen.map(item => [item.kind, item.target]), [['tunnel', `localhost:${tls.port}`]]);
    assert.equal(JSON.stringify(proxy.seen[0]?.rawHeaders).includes('never-seen-by-proxy'), false, 'the request never reached the proxy in the clear');
    assert.equal(JSON.stringify(proxy.seen[0]?.rawHeaders).includes('secret-path'), false);
    assert.equal(tls.seen[0]?.clientCommonName, 'api-client test client', 'the client certificate went to the real server through the tunnel');
    assert.deepEqual(JSON.parse(text(response)) as unknown, { protocol: response.tls?.protocol, authorized: true, clientCommonName: 'api-client test client' });
  } finally { await proxy.close(); await tls.close(); }
});

test('A certificate that is not trusted is refused through the tunnel as well', async () => {
  const tls = await startTlsServer({ certificate: 'selfsigned' });
  const proxy = await startProxy();
  try {
    await rejects(send(get(`${tls.url}/`), { ...BASE, tls: { rejectUnauthorized: true }, proxy: { all: proxy.url, proxyLoopback: true } }), 'tls');
    const loose = await send(get(`${tls.url}/`), { ...BASE, tls: { rejectUnauthorized: false }, proxy: { all: proxy.url, proxyLoopback: true } });
    assert.equal(loose.status, 200);
    assert.match(loose.warnings.join(' '), /was not checked/);
  } finally { await proxy.close(); await tls.close(); }
});

test('Addresses on the no-proxy list, and loopback, go direct even when a proxy is set', async () => {
  const server = await startServer();
  const proxy = await startProxy();
  try {
    await send(get(`${server.url}/echo`), { ...BASE, proxy: { all: proxy.url } });
    await send(get(`${server.url}/echo`), { ...BASE, proxy: { all: proxy.url, proxyLoopback: true, noProxy: '127.0.0.1' } });
    assert.equal(proxy.seen.length, 0);
    assert.equal(server.requests.length, 2);
    await send(get(`${server.url}/echo`), { ...BASE, proxy: { all: proxy.url, proxyLoopback: true } });
    assert.equal(proxy.seen.length, 1);
  } finally { await proxy.close(); await server.close(); }
});

test('A proxy that is not there is a "proxy" error naming it, and a bad proxy setting is one too', async () => {
  const server = await startServer();
  try {
    const error = await rejects(send(get(`${server.url}/echo`), { ...BASE, proxy: { all: 'http://127.0.0.1:1', proxyLoopback: true } }), 'proxy');
    assert.match(error.message, /Could not reach the proxy 127.0.0.1:1/);
    assert.ok(error.message.length > 0);
    await rejects(send(get('https://127.0.0.1:1/'), { ...BASE, proxy: { all: 'http://127.0.0.1:1', proxyLoopback: true } }), 'proxy');
    await rejects(send(get(`${server.url}/echo`), { ...BASE, proxy: { all: 'socks5://x:1', proxyLoopback: true } }), 'proxy');
  } finally { await server.close(); }
});

test('A redirect through a proxy goes through the proxy again, and credentials still stop at the origin', async () => {
  const server = await startServer();
  const proxy = await startProxy();
  try {
    const response = await send(get(`${server.url}/redirect/2`, [['Authorization', 'Bearer abc']]), { ...BASE, proxy: { all: proxy.url, proxyLoopback: true } });
    assert.equal(text(response), 'arrived');
    assert.equal(proxy.seen.length, 3);
    assert.deepEqual(headerValues(server.requests[2] as never, 'authorization'), ['Bearer abc'], 'the same origin keeps its credentials');
  } finally { await proxy.close(); await server.close(); }
});
