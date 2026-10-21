import { test } from 'node:test';
import assert from 'node:assert/strict';
import { send, type SendOptions } from '../../src/engine/send';
import { EngineError, type HeaderList, type WireRequest, type WireResponse } from '../../src/engine/types';
import { headerValues, startServer } from '../support/servers/http-server';
import { p12, pem, startTlsServer, type TlsServer, type TlsServerOptions } from '../support/servers/https-server';

const BASE: SendOptions = { timeoutMs: 10_000, followRedirects: true, maxRedirects: 10, tls: { rejectUnauthorized: true }, responseLimitBytes: 1024 * 1024 };
const get = (url: string, headers: HeaderList = []): WireRequest => ({ method: 'GET', url, headers });
const body = (response: WireResponse): { protocol: string; authorized: boolean; clientCommonName: string | null } => JSON.parse(Buffer.from(response.body.kind === 'memory' ? response.body.bytes : new Uint8Array()).toString('utf8')) as never;

function withTls(options: TlsServerOptions, run: (server: TlsServer) => Promise<void>): () => Promise<void> {
  return async () => {
    const server = await startTlsServer(options);
    try { await run(server); } finally { await server.close(); }
  };
}
const rejects = async (promise: Promise<unknown>, code: string): Promise<EngineError> => {
  try { await promise; } catch (error) {
    assert.ok(error instanceof EngineError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  return assert.fail(`expected ${code}`);
};

test('A certificate that nobody trusts is refused by default, with a hint about the certificate authority', withTls({ certificate: 'selfsigned' }, async server => {
  const error = await rejects(send(get(`${server.url}/`), BASE), 'tls');
  assert.match(error.message, /secure connection to localhost:\d+ failed/);
  assert.match(error.hint, /add it in the settings/);
  assert.equal(server.seen.length, 0, 'the request was not sent');
}));

test('A certificate signed by an authority the request trusts is accepted, and the connection is described', withTls({}, async server => {
  const response = await send(get(`${server.url}/`), { ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.warnings, []);
  assert.equal(response.tls?.authorized, true);
  assert.match(response.tls?.protocol ?? '', /^TLSv1\.[23]$/);
  assert.equal(response.tls?.subject, 'localhost');
  assert.equal(response.tls?.issuer, 'api-client test CA');
  assert.match(response.tls?.cipher ?? '', /\S/);
  assert.match(response.tls?.validTo ?? '', /20\d\d|2[1-9]\d\d/);
  assert.ok(response.timings.tlsMs >= 0 && response.timings.connectMs >= 0);
  assert.equal(body(response).authorized, false, 'the server did not ask for a certificate');
}));

test('The address can be an IP when the certificate names it', withTls({}, async server => {
  const response = await send(get(`${server.ipUrl}/`), { ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] } });
  assert.equal(response.status, 200);
}));

test('With checking off the request goes through, and the response says in a warning that the certificate was not checked', withTls({ certificate: 'selfsigned' }, async server => {
  const response = await send(get(`${server.url}/`), { ...BASE, tls: { rejectUnauthorized: false } });
  assert.equal(response.status, 200);
  assert.equal(response.tls?.authorized, false);
  assert.match(response.tls?.authorizationError ?? '', /SELF_SIGNED|self.signed|UNABLE_TO/i);
  assert.match(response.warnings.join(' '), /certificate of localhost:\d+ was not checked/);
}));

test('A certificate for another name is refused even when the authority is trusted, and accepted with checking off', withTls({ certificate: 'mismatch' }, async server => {
  const error = await rejects(send(get(`${server.url}/`), { ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] } }), 'tls');
  assert.match(error.message, /altnames|hostname|does not match|Host/i);
  const loose = await send(get(`${server.url}/`), { ...BASE, tls: { rejectUnauthorized: false } });
  assert.equal(loose.status, 200);
}));

test('The authority of one request is not trusted by the next: each request has its own trust', withTls({}, async server => {
  await send(get(`${server.url}/`), { ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] } });
  await rejects(send(get(`${server.url}/`), BASE), 'tls');
}));

test('A client certificate as PEM text is presented to a server that asks for one', withTls({ requestClientCertificate: true }, async server => {
  const response = await send(get(`${server.url}/`), { ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')], cert: pem('client.pem'), key: pem('client-key.pem') } });
  assert.deepEqual([body(response).authorized, body(response).clientCommonName], [true, 'api-client test client']);
  const anonymous = await send(get(`${server.url}/`), { ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] } });
  assert.deepEqual([body(anonymous).authorized, body(anonymous).clientCommonName], [false, null]);
}));

test('A client certificate as a PKCS#12 bundle works with its passphrase and fails clearly without it', withTls({ requestClientCertificate: true }, async server => {
  const tls = { rejectUnauthorized: true, ca: [pem('ca.pem')], pfx: new Uint8Array(p12()) };
  const response = await send(get(`${server.url}/`), { ...BASE, tls: { ...tls, passphrase: 'test' } });
  assert.deepEqual([body(response).authorized, body(response).clientCommonName], [true, 'api-client test client']);
  const wrong = await rejects(send(get(`${server.url}/`), { ...BASE, tls: { ...tls, passphrase: 'wrong' } }), 'tls');
  assert.match(wrong.message, /client certificate could not be read/);
  await rejects(send(get(`${server.url}/`), { ...BASE, tls }), 'tls');
}));

test('A redirect from https to http is not followed, and the redirect itself is the result with a reason', async () => {
  const plain = await startServer();
  const secure = await startTlsServer({ handler: (_req, res) => { res.statusCode = 302; res.setHeader('Location', `${plain.url}/echo`); res.end('moved to plain http'); } });
  try {
    const response = await send(get(`${secure.url}/`), { ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] } });
    assert.equal(response.status, 302);
    assert.match(response.warnings.join(' '), /Not followed: redirected from https to http/);
    assert.equal(Buffer.from(response.body.kind === 'memory' ? response.body.bytes : []).toString(), 'moved to plain http', 'the body of the refused redirect is kept');
    assert.equal(plain.requests.length, 0, 'nothing was sent to the plain address');
    const allowed = await send(get(`${secure.url}/`), { ...BASE, allowDowngrade: true, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] } });
    assert.equal(allowed.status, 200);
    assert.equal(plain.requests.length, 1);
  } finally { await secure.close(); await plain.close(); }
});

test('Credentials do not follow a redirect to another https origin, and the secure origin of the first request is not asked about them', async () => {
  const target = await startTlsServer();
  const origin = await startTlsServer({ handler: (_req, res) => { res.statusCode = 307; res.setHeader('Location', `https://127.0.0.1:${target.port}/landed`); res.end(); } });
  try {
    const response = await send(get(`${origin.url}/`, [['Authorization', 'Bearer secret-token'], ['Cookie', 'sid=1'], ['X-Plain', 'ok']]), { ...BASE, tls: { rejectUnauthorized: true, ca: [pem('ca.pem')] } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.redirects.map(hop => hop.status), [307]);
    const landed = target.seen[0];
    assert.equal(landed?.path, '/landed');
    const names = (landed?.headers ?? []).filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());
    assert.deepEqual([names.includes('authorization'), names.includes('cookie'), names.includes('x-plain')], [false, false, true]);
  } finally { await origin.close(); await target.close(); }
});

test('Each request uses its own connection, so a client certificate of one request is never reused by another', withTls({ requestClientCertificate: true }, async server => {
  const tls = { rejectUnauthorized: true, ca: [pem('ca.pem')] };
  const withCertificate = await send(get(`${server.url}/`), { ...BASE, tls: { ...tls, cert: pem('client.pem'), key: pem('client-key.pem') } });
  const without = await send(get(`${server.url}/`), { ...BASE, tls });
  assert.equal(body(withCertificate).clientCommonName, 'api-client test client');
  assert.equal(body(without).clientCommonName, null);
  assert.equal(headerValues({ method: 'GET', url: '/', rawHeaders: server.seen[1]?.headers ?? [], body: Buffer.alloc(0) }, 'host').length, 1);
}));
