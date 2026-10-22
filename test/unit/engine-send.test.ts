import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send, type CookieStore, type SendOptions } from '../../src/engine/send';
import { EngineError, type HeaderList, type WireRequest, type WireResponse } from '../../src/engine/types';
import { headerValues, startServer, type MockServer } from '../support/servers/http-server';

const BASE: SendOptions = { timeoutMs: 10_000, followRedirects: true, maxRedirects: 10, tls: { rejectUnauthorized: true }, responseLimitBytes: 10 * 1024 * 1024 };
const get = (url: string, headers: HeaderList = []): WireRequest => ({ method: 'GET', url, headers });
const text = (response: WireResponse): string => (response.body.kind === 'memory' ? Buffer.from(response.body.bytes).toString('utf8') : readFileSync(response.body.path, 'utf8'));
const json = (response: WireResponse): { method: string; url: string; headers: string[]; body: string } => JSON.parse(text(response)) as never;
const headerOf = (headers: HeaderList, name: string): string[] => headers.filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);

/** Starts a server for the test and stops it afterwards. */
function withServer(run: (server: MockServer) => Promise<void>): () => Promise<void> {
  return async () => {
    const server = await startServer();
    try { await run(server); } finally { await server.close(); }
  };
}
const rejectsWith = async (promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<EngineError> => {
  try { await promise; } catch (error) {
    assert.ok(error instanceof EngineError, `expected an EngineError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected an EngineError with code ${code}`);
};

test('A GET sends the request as written: header names in their own spelling and order, a repeated header as two lines, and the default headers when none are given', withServer(async server => {
  const response = await send(get(`${server.url}/echo?a=1&b=two%20words`, [['X-Custom', 'one'], ['x-lower', 'l'], ['X-Dup', 'a'], ['X-Dup', 'b']]), BASE);
  assert.deepEqual([response.status, response.statusText, response.httpVersion, response.truncated], [200, 'OK', '1.1', false]);
  const echoed = json(response);
  assert.deepEqual([echoed.method, echoed.url], ['GET', '/echo?a=1&b=two%20words']);
  const seen = server.requests[0] as never as { rawHeaders: string[] };
  const names = seen.rawHeaders.filter((_, index) => index % 2 === 0);
  assert.deepEqual(names.filter(name => /^x-/i.test(name)), ['X-Custom', 'x-lower', 'X-Dup', 'X-Dup'], 'spelling and order are kept');
  assert.deepEqual(headerValues(server.requests[0] as never, 'x-dup'), ['a', 'b']);
  assert.match(headerValues(server.requests[0] as never, 'user-agent')[0] ?? '', /^api-client\//);
  assert.equal(headerValues(server.requests[0] as never, 'accept-encoding')[0], 'gzip, deflate, br');
  assert.equal(headerValues(server.requests[0] as never, 'accept')[0], '*/*');
  assert.equal(response.finalUrl, `${server.url}/echo?a=1&b=two%20words`);
  assert.deepEqual(response.redirects, []);
  assert.deepEqual([response.sent.method, response.sent.url], ['GET', `${server.url}/echo?a=1&b=two%20words`], 'the response says what was sent');
  assert.deepEqual(headerOf(response.sent.headers, 'accept-encoding'), ['gzip, deflate, br'], 'with the headers the engine added');
  assert.deepEqual(headerOf(response.sent.headers, 'x-dup'), ['a', 'b']);
}));

test('Default headers are added only when the request has none of that name, whatever its spelling, and can be switched off', withServer(async server => {
  await send(get(`${server.url}/echo`, [['user-agent', 'mine'], ['ACCEPT', 'text/plain'], ['accept-ENCODING', 'identity']]), BASE);
  const request = server.requests[0] as never;
  assert.deepEqual([headerValues(request, 'user-agent'), headerValues(request, 'accept'), headerValues(request, 'accept-encoding')], [['mine'], ['text/plain'], ['identity']]);
  await send(get(`${server.url}/echo`), { ...BASE, defaultHeaders: false });
  assert.deepEqual(headerValues(server.requests[1] as never, 'user-agent'), []);
}));

test('A body is sent with the right Content-Length, a Content-Length the person wrote is replaced, and an empty POST says so', withServer(async server => {
  const body = new TextEncoder().encode('{"name":"Rex","tags":["a"]}');
  const response = await send({ method: 'POST', url: `${server.url}/echo`, headers: [['Content-Type', 'application/json'], ['Content-Length', '999']], body: { kind: 'bytes', bytes: body } }, BASE);
  assert.equal(json(response).body, '{"name":"Rex","tags":["a"]}');
  assert.deepEqual(headerValues(server.requests[0] as never, 'content-length'), [String(body.length)]);
  await send({ method: 'POST', url: `${server.url}/echo`, headers: [] }, BASE);
  assert.deepEqual(headerValues(server.requests[1] as never, 'content-length'), ['0']);
  await send({ method: 'GET', url: `${server.url}/echo`, headers: [] }, BASE);
  assert.deepEqual(headerValues(server.requests[2] as never, 'content-length'), []);
}));

test('Binary bodies come back byte for byte', withServer(async server => {
  const response = await send(get(`${server.url}/bytes`), BASE);
  assert.deepEqual([...(response.body.kind === 'memory' ? response.body.bytes : [])], Array.from({ length: 256 }, (_, value) => value));
  assert.equal(response.size, 256);
}));

test('Response headers keep their order and spelling, and a header that came twice is two entries', withServer(async server => {
  const response = await send(get(`${server.url}/multi-header`), BASE);
  assert.deepEqual(headerOf(response.headers, 'x-multi'), ['first', 'second']);
  const names = response.headers.map(([name]) => name);
  assert.ok(names.includes('x-lower') && names.includes('X-UPPER'), names.join(','));
}));

test('The timings are measured: every phase is a number, and the total is at least the time to the first byte', withServer(async server => {
  const response = await send(get(`${server.url}/slow?ms=120`), BASE);
  const t = response.timings;
  for (const value of Object.values(t)) assert.ok(Number.isFinite(value) && value >= 0, JSON.stringify(t));
  assert.ok(t.ttfbMs >= 100, `ttfb ${t.ttfbMs}`);
  assert.ok(t.totalMs >= t.ttfbMs, JSON.stringify(t));
  assert.equal(t.tlsMs, 0, 'no handshake for http');
}));

test('Redirects are followed and listed; the method, the body and the headers follow the rules of the status', withServer(async server => {
  const chain = await send(get(`${server.url}/redirect/3`), BASE);
  assert.equal(text(chain), 'arrived');
  assert.deepEqual(chain.redirects.map(hop => [hop.status, hop.url.replace(server.url, '')]), [[302, '/redirect/3'], [302, '/redirect/2'], [302, '/redirect/1']]);
  assert.equal(chain.finalUrl, `${server.url}/redirect/0`);
  const payload = { kind: 'bytes' as const, bytes: new TextEncoder().encode('payload') };
  for (const status of [301, 302, 303]) {
    server.requests.length = 0;
    const followed = await send({ method: 'POST', url: `${server.url}/redirect/1?status=${status}`, headers: [['Content-Type', 'text/plain'], ['X-Keep', 'yes']], body: payload }, BASE);
    assert.deepEqual([followed.sent.method, followed.sent.url, followed.sent.body], ['GET', `${server.url}/redirect/0?status=${status}`, undefined], `${status}: what was sent is the last request, not the first`);
    const after = server.requests[1] as never as { method: string; body: Buffer };
    assert.equal(after.method, 'GET', `${status}`);
    assert.equal(after.body.length, 0, `${status}`);
    assert.deepEqual(headerValues(server.requests[1] as never, 'content-type'), [], `${status} drops the entity headers`);
    assert.deepEqual(headerValues(server.requests[1] as never, 'x-keep'), ['yes'], `${status} keeps the others`);
  }
  for (const status of [307, 308]) {
    server.requests.length = 0;
    await send({ method: 'POST', url: `${server.url}/redirect/1?status=${status}`, headers: [['Content-Type', 'text/plain']], body: payload }, BASE);
    const after = server.requests[1] as never as { method: string; body: Buffer };
    assert.equal(after.method, 'POST', `${status}`);
    assert.equal(after.body.toString(), 'payload', `${status}`);
  }
  server.requests.length = 0;
  await send({ method: 'HEAD', url: `${server.url}/redirect/1?status=303`, headers: [] }, BASE);
  assert.equal((server.requests[1] as never as { method: string }).method, 'HEAD', '303 keeps HEAD');
}));

test('A redirect is not followed when the request says so, and a loop or a very long chain is an error', withServer(async server => {
  const stopped = await send(get(`${server.url}/redirect/2`), { ...BASE, followRedirects: false });
  assert.deepEqual([stopped.status, headerOf(stopped.headers, 'location'), text(stopped)], [302, ['/redirect/1'], 'moving'], 'the redirect itself is the result, body included');
  assert.equal(server.requests.length, 1);
  const error = await rejectsWith(send(get(`${server.url}/loop`), { ...BASE, maxRedirects: 4 }), 'too-many-redirects');
  assert.match(error.message, /more than 4 times/);
  const long = await send(get(`${server.url}/redirect/10`), { ...BASE, maxRedirects: 10 });
  assert.equal(text(long), 'arrived');
  await rejectsWith(send(get(`${server.url}/redirect/11`), { ...BASE, maxRedirects: 10 }), 'too-many-redirects');
}));

test('Moving to another origin drops the credentials and every header whose name is secret; staying on the origin keeps them', withServer(async origin => {
  const other = await startServer();
  try {
    const headers: HeaderList = [['Authorization', 'Bearer abc'], ['Cookie', 'sid=1'], ['X-Api-Key', 'k'], ['Proxy-Authorization', 'Basic xx'], ['X-Session-Token', 't'], ['X-Custom', 'fine']];
    await send(get(`${origin.url}/to?to=${encodeURIComponent(`${other.url}/echo`)}`, headers), { ...BASE, allowLocalRedirect: true });
    const arrived = other.requests[0] as never;
    assert.deepEqual(headerValues(arrived, 'authorization').concat(headerValues(arrived, 'cookie'), headerValues(arrived, 'x-api-key'), headerValues(arrived, 'proxy-authorization'), headerValues(arrived, 'x-session-token')), []);
    assert.deepEqual(headerValues(arrived, 'x-custom'), ['fine']);
    await send(get(`${origin.url}/redirect/1`, headers), BASE);
    const same = origin.requests.find((r, index) => index > 0 && r.url === '/redirect/0') as never;
    assert.deepEqual([headerValues(same, 'authorization'), headerValues(same, 'cookie'), headerValues(same, 'x-api-key')], [['Bearer abc'], ['sid=1'], ['k']]);
  } finally { await other.close(); }
}));

test('Cancelling stops the request, and the reason can be the person or a timeout', withServer(async server => {
  const controller = new AbortController();
  const pending = send(get(`${server.url}/hang`), { ...BASE, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await rejectsWith(pending, 'aborted', /cancelled/);
  await rejectsWith(send(get(`${server.url}/hang`), { ...BASE, timeoutMs: 150 }), 'timeout', /took longer than/);
  const already = new AbortController();
  already.abort();
  await rejectsWith(send(get(`${server.url}/echo`), { ...BASE, signal: already.signal }), 'aborted');
  assert.ok(server.requests.every(request => !request.url.startsWith('/echo')), 'a request that was cancelled before it was sent is never sent');
}));

test('A server that sends a little and then nothing hits the idle timeout, and one that closes the connection is a reset', withServer(async server => {
  await rejectsWith(send(get(`${server.url}/stall`), { ...BASE, idleTimeoutMs: 150, timeoutMs: 5000 }), 'timeout', /sent nothing/);
  await rejectsWith(send(get(`${server.url}/reset`), BASE), 'reset');
  await rejectsWith(send(get(`${server.url}/garbage`), BASE), 'bad-response');
}));

test('A port nobody listens on is "refused", a name that does not exist is "dns", a bad address is "invalid-url", a bad header is "invalid-request"', withServer(async server => {
  const free = createServer();
  await new Promise<void>(resolve => free.listen(0, '127.0.0.1', () => resolve()));
  const port = (free.address() as { port: number }).port;
  await new Promise<void>(resolve => free.close(() => resolve()));
  const refused = await rejectsWith(send(get(`http://127.0.0.1:${port}/`), BASE), 'refused');
  assert.match(refused.hint, /server is running/);
  await rejectsWith(send(get('http://nonexistent-host.invalid/'), { ...BASE, timeoutMs: 8000 }), 'dns');
  await rejectsWith(send(get('not a url'), BASE), 'invalid-url');
  await rejectsWith(send(get('file:///etc/passwd'), BASE), 'invalid-url', /Only http and https/);
  await rejectsWith(send(get('ftp://x.test/'), BASE), 'invalid-url');
  await rejectsWith(send(get(`${server.url}/echo`, [['X-Bad', 'line\r\nInjected: yes']]), BASE), 'invalid-request');
  await rejectsWith(send(get(`${server.url}/echo`, [['Bad Name', 'x']]), BASE), 'invalid-request');
}));

test('Content encodings are undone: gzip, deflate (with and without the zlib header), brotli and identity; one that is not known is left and said so', withServer(async server => {
  for (const path of ['gzip', 'deflate', 'deflate-raw', 'br', 'identity']) {
    const response = await send(get(`${server.url}/${path}`), BASE);
    assert.match(text(response), /^hello /, path);
    assert.ok(text(response).length >= 600, path);
    if (path !== 'identity') assert.ok(response.wireBytes < response.size, `${path}: ${response.wireBytes} on the wire, ${response.size} decoded`);
  }
  const zstd = await send(get(`${server.url}/zstd`), BASE);
  assert.match(zstd.warnings.join(' '), /zstd encoding, which is not undone/);
  assert.match(text(zstd), /^hello zstd/);
}));

test('A decompression bomb is stopped after a few megabytes and is never held in memory', withServer(async server => {
  const started = performance.now();
  const error = await rejectsWith(send(get(`${server.url}/bomb?mb=300`), BASE), 'too-large', /decompression bomb/);
  assert.match(error.hint, /not read any further/);
  assert.ok(performance.now() - started < 30_000, 'a bomb of 300 MB is stopped after a few, whatever the speed of the machine');
  await rejectsWith(send(get(`${server.url}/bomb?mb=20`), { ...BASE, decode: { maxBytes: 5 * 1024 * 1024, maxRatio: 1_000_000, ratioFloor: 1 << 30 } }), 'too-large', /larger than 5242880 bytes/);
}));

test('A response over the memory limit is cut when there is nowhere to put it, and the rest is not downloaded', withServer(async server => {
  const response = await send(get(`${server.url}/big?bytes=3000000`), { ...BASE, responseLimitBytes: 1_000_000 });
  assert.deepEqual([response.truncated, response.size, response.body.kind], [true, 1_000_000, 'memory']);
  assert.equal(response.status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(server.aborted >= 1, 'the connection was closed before the server finished');
}));

test('A response over the memory limit goes to a file when a folder is given, whole, and is cut at the file limit', withServer(async server => {
  const dir = mkdtempSync(join(tmpdir(), 'api-client-spill-'));
  try {
    const whole = await send(get(`${server.url}/big?bytes=3000000`), { ...BASE, responseLimitBytes: 1_000_000, spill: { dir, maxBytes: 10_000_000 } });
    assert.deepEqual([whole.truncated, whole.size, whole.body.kind], [false, 3_000_000, 'file']);
    const path = whole.body.kind === 'file' ? whole.body.path : '';
    assert.equal(statSync(path).size, 3_000_000);
    assert.ok(readFileSync(path).every(byte => byte === 120));
    const cut = await send(get(`${server.url}/big?bytes=3000000`), { ...BASE, responseLimitBytes: 500_000, spill: { dir, maxBytes: 2_000_000 } });
    assert.deepEqual([cut.truncated, cut.size], [true, 2_000_000]);
    assert.equal(statSync(cut.body.kind === 'file' ? cut.body.path : '').size, 2_000_000);
    assert.equal(readdirSync(dir).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('A body that is too large for the memory limit but within it for the file is not cut when the limit is exact', withServer(async server => {
  const response = await send(get(`${server.url}/big?bytes=1000000`), { ...BASE, responseLimitBytes: 1_000_000 });
  assert.deepEqual([response.truncated, response.size], [false, 1_000_000]);
}));

test('HEAD, 204 and 304 have no body, and a chunked response arrives whole', withServer(async server => {
  const head = await send({ method: 'HEAD', url: `${server.url}/echo`, headers: [] }, BASE);
  assert.deepEqual([head.status, head.size, head.body.kind], [200, 0, 'memory']);
  const none = await send(get(`${server.url}/no-content`), BASE);
  assert.deepEqual([none.status, none.size], [204, 0]);
  assert.deepEqual([(await send(get(`${server.url}/not-modified`), BASE)).status], [304]);
  assert.equal(text(await send(get(`${server.url}/chunked`), BASE)), 'one two three');
}));

test('Cookies: what the server sets is handed to the store, and what the store holds goes with the next request and with the redirects', withServer(async server => {
  const stored: { url: string; values: string[] }[] = [];
  const store: CookieStore = { header: url => (url.pathname === '/echo' ? 'a=1; b=2' : undefined), store: (url, values) => { stored.push({ url: url.pathname, values }); } };
  await send(get(`${server.url}/set-cookies`), { ...BASE, cookies: store });
  assert.deepEqual(stored, [{ url: '/set-cookies', values: ['a=1; Path=/', 'b=2; Path=/; HttpOnly'] }]);
  const merged = await send(get(`${server.url}/echo`, [['Cookie', 'mine=x']]), { ...BASE, cookies: store });
  assert.deepEqual(headerValues(server.requests[1] as never, 'cookie'), ['mine=x; a=1; b=2']);
  assert.deepEqual(merged.sent.headers.filter(([name]) => name === 'Cookie'), [['Cookie', 'mine=x; a=1; b=2']], 'the cookie that went out is in what was sent');
  assert.equal(merged.status, 200);
  await send(get(`${server.url}/echo`), { ...BASE, cookies: store });
  assert.deepEqual(headerValues(server.requests[2] as never, 'cookie'), ['a=1; b=2']);
}));

test('A file is streamed as the body with its size as Content-Length, and a multipart body is built part by part with names that cannot end the header', withServer(async server => {
  const dir = mkdtempSync(join(tmpdir(), 'api-client-upload-'));
  try {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    writeFileSync(join(dir, 'big.bin'), big);
    const file = await send({ method: 'PUT', url: `${server.url}/upload`, headers: [], body: { kind: 'file', path: join(dir, 'big.bin') } }, BASE);
    const reported = JSON.parse(text(file)) as { length: number; sha256: string; contentLength: string; chunked: string | null };
    assert.deepEqual([reported.length, reported.contentLength, reported.chunked, reported.sha256], [big.length, String(big.length), null, createHash('sha256').update(big).digest('hex')]);

    writeFileSync(join(dir, 'a.txt'), 'file text');
    const multipart = await send({
      method: 'POST', url: `${server.url}/echo`, headers: [['Content-Type', 'multipart/form-data; boundary=XBOUNDARY']],
      body: { kind: 'multipart', boundary: 'XBOUNDARY', parts: [{ name: 'field', value: 'v\u00e9' }, { name: 'we"ird\r\nname', value: 'x' }, { name: 'doc', filePath: join(dir, 'a.txt'), filename: 'a"b.txt', contentType: 'text/plain' }] }
    }, BASE);
    const sent = json(multipart).body;
    assert.equal(sent, [
      '--XBOUNDARY', 'Content-Disposition: form-data; name="field"', '', 'v\u00e9',
      '--XBOUNDARY', 'Content-Disposition: form-data; name="we%22ird%0D%0Aname"', '', 'x',
      '--XBOUNDARY', 'Content-Disposition: form-data; name="doc"; filename="a%22b.txt"', 'Content-Type: text/plain', '', 'file text', '--XBOUNDARY--', ''
    ].join('\r\n'));
    assert.deepEqual(headerValues(server.requests[1] as never, 'content-length'), [String(Buffer.byteLength(sent))]);
    await rejectsWith(send({ method: 'PUT', url: `${server.url}/upload`, headers: [], body: { kind: 'file', path: join(dir, 'missing.bin') } }, BASE), 'file', /cannot be sent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('A 307 resends a file body and a multipart body', withServer(async server => {
  const dir = mkdtempSync(join(tmpdir(), 'api-client-resend-'));
  try {
    writeFileSync(join(dir, 'f.txt'), 'twice');
    await send({ method: 'POST', url: `${server.url}/redirect/1?status=307`, headers: [], body: { kind: 'file', path: join(dir, 'f.txt') } }, BASE);
    assert.deepEqual(server.requests.map(r => r.body.toString()), ['twice', 'twice']);
    server.requests.length = 0;
    await send({ method: 'POST', url: `${server.url}/redirect/1?status=308`, headers: [], body: { kind: 'multipart', boundary: 'B', parts: [{ name: 'f', filePath: join(dir, 'f.txt'), filename: 'f.txt' }] } }, BASE);
    assert.equal(server.requests[0]?.body.toString(), server.requests[1]?.body.toString());
    assert.match(server.requests[1]?.body.toString() ?? '', /twice/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test('Fifty requests at once all arrive and none is mixed with another', withServer(async server => {
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) => send({ method: 'POST', url: `${server.url}/echo?i=${index}`, headers: [], body: { kind: 'bytes', bytes: new TextEncoder().encode(`body ${index}`) } }, BASE)));
  results.forEach((response, index) => assert.deepEqual([json(response).url, json(response).body], [`/echo?i=${index}`, `body ${index}`]));
}));

test('The response of an IPv6 loopback address works too', async () => {
  let server: MockServer | undefined;
  try { server = await startServer('::1'); } catch { return; }
  try {
    const response = await send(get(`${server.url}/port`), BASE);
    assert.equal(text(response), String(server.port));
  } finally { await server.close(); }
});

test('Cookies on a redirect: the redirect is sent with the cookie once, not twice', withServer(async server => {
  const store: CookieStore = { header: () => 'a=1', store: () => undefined };
  await send(get(`${server.url}/redirect/2`, [['Cookie', 'mine=x']]), { ...BASE, cookies: store });
  assert.equal(server.requests.length, 3);
  assert.deepEqual(server.requests.map(request => headerValues(request, 'cookie')), [['mine=x; a=1'], ['mine=x; a=1'], ['mine=x; a=1']]);
}));
