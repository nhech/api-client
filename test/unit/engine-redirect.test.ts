import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost, isRedirectStatus, nextHop, originOf, type RedirectPolicy } from '../../src/engine/redirect';
import type { WireRequest } from '../../src/engine/types';

const POLICY: RedirectPolicy = { allowDowngrade: false, allowLocal: false };
const request = (over: { method?: string; url?: string; noBody?: boolean } = {}): WireRequest => {
  const made: WireRequest = {
    method: over.method ?? 'POST', url: over.url ?? 'https://api.example.com/v1/items',
    headers: [['Authorization', 'Bearer x'], ['Cookie', 'sid=1'], ['Content-Type', 'application/json'], ['Content-Length', '12'], ['X-Api-Key', 'k'], ['X-Trace', 't'], ['Host', 'api.example.com']],
    body: { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) }
  };
  if (over.noBody === true) delete made.body;
  return made;
};
const hop = (status: number, location: string, base: WireRequest = request(), policy: RedirectPolicy = POLICY) => nextHop(base, status, location, policy);
const followed = (result: ReturnType<typeof nextHop>): WireRequest => {
  assert.equal(result.follow, true, result.follow ? '' : result.reason);
  return result.follow ? result.request : (undefined as never);
};
const names = (r: WireRequest): string[] => r.headers.map(([name]) => name);

test('Only five statuses are redirects', () => {
  for (const status of [301, 302, 303, 307, 308]) assert.equal(isRedirectStatus(status), true, String(status));
  for (const status of [200, 204, 300, 304, 305, 306, 309, 399, 400]) assert.equal(isRedirectStatus(status), false, String(status));
});

test('301 and 302 turn a POST into a GET without a body or entity headers; other methods keep theirs', () => {
  for (const status of [301, 302]) {
    const next = followed(hop(status, '/v1/items/1'));
    assert.deepEqual([next.method, next.body, next.url], ['GET', undefined, 'https://api.example.com/v1/items/1']);
    assert.deepEqual(names(next), ['Authorization', 'Cookie', 'X-Api-Key', 'X-Trace'], 'the entity headers and Host go, the rest stays on the same origin');
    const put = followed(hop(status, '/x', request({ method: 'PUT' })));
    assert.deepEqual([put.method, put.body !== undefined], ['PUT', true]);
    assert.equal(followed(hop(status, '/x', request({ method: 'DELETE', noBody: true }))).method, 'DELETE');
  }
});

test('303 turns everything but HEAD into a GET; 307 and 308 keep the method and the body', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'GET']) assert.equal(followed(hop(303, '/x', request({ method }))).method, 'GET', method);
  assert.equal(followed(hop(303, '/x', request({ method: 'HEAD', noBody: true }))).method, 'HEAD');
  for (const status of [307, 308]) {
    const next = followed(hop(status, '/x'));
    assert.deepEqual([next.method, next.body?.kind], ['POST', 'bytes']);
    assert.ok(names(next).includes('Content-Type') && !names(next).includes('Content-Length') && !names(next).includes('Host'));
  }
});

test('To another origin the credentials and every secret-looking header are dropped; the scheme, the host and the port each make an origin', () => {
  for (const location of ['https://other.example.com/x', 'https://api.example.com:8443/x', 'https://evil.test/x']) {
    const next = followed(hop(307, location));
    assert.deepEqual(names(next), ['Content-Type', 'X-Trace'], location);
  }
  const http = nextHop(request({ url: 'http://api.example.com/x' }), 307, 'https://api.example.com/x', POLICY);
  assert.deepEqual(names(followed(http)), ['Content-Type', 'X-Trace'], 'http to https is another origin');
  assert.deepEqual(names(followed(hop(307, '//api.example.com/y'))), ['Authorization', 'Cookie', 'Content-Type', 'X-Api-Key', 'X-Trace'], 'a scheme-relative address on the same origin');
  assert.equal(originOf(new URL('https://API.example.com:443/x')), 'https://api.example.com');
});

test('A redirect from https to http is not followed unless allowed, and the reason says why', () => {
  const refused = hop(302, 'http://api.example.com/x');
  assert.deepEqual(refused, { follow: false, reason: 'redirected from https to http, which is not followed' });
  assert.equal(hop(302, 'http://api.example.com/x', request(), { ...POLICY, allowDowngrade: true }).follow, true);
  assert.equal(nextHop(request({ url: 'http://a.test/x' }), 302, 'https://a.test/y', POLICY).follow, true, 'upgrading is fine');
  assert.equal(nextHop(request({ url: 'http://a.test/x' }), 302, 'http://b.test/y', POLICY).follow, true, 'http to http is fine');
});

test('A public address cannot send the request to this machine or its network unless allowed', () => {
  for (const target of ['http://localhost/x', 'https://127.0.0.1/x', 'https://127.1.2.3/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data', 'https://service.localhost/x', 'https://[::ffff:127.0.0.1]/x', 'https://[fe80::1]/x']) {
    const result = hop(302, target, request({ method: 'GET', noBody: true }), { ...POLICY, allowDowngrade: true });
    assert.deepEqual(result, { follow: false, reason: 'redirected to an address on this machine or network, which is not followed' }, target);
    assert.equal(hop(302, target, request({ method: 'GET', noBody: true }), { allowDowngrade: true, allowLocal: true }).follow, true, target);
  }
  assert.equal(nextHop(request({ url: 'http://localhost:3000/a' }), 302, 'http://127.0.0.1:4000/b', POLICY).follow, true, 'from a local address a local target is not new');
});

test('Where a hostname is local', () => {
  for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', '127.0.0.1', '127.255.255.255', '::1', '[::1]', '169.254.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::abcd', 'FEBF::1']) assert.equal(isLocalHost(host), true, host);
  for (const host of ['example.com', '128.0.0.1', '126.0.0.1', '10.0.0.1', '192.168.1.1', '169.253.0.1', '8.8.8.8', '::2', 'fec0::1', 'notlocalhost', 'localhost.example.com', '2001:db8::1', '::ffff:8.8.8.8']) assert.equal(isLocalHost(host), false, host);
});

test('A Location that is not an address, or not http or https, is not followed', () => {
  assert.deepEqual(hop(302, 'http://[bad'), { follow: false, reason: 'the Location header is not a valid address' });
  for (const location of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://x.test/', 'gopher://x']) {
    const result = hop(302, location);
    assert.equal(result.follow, false, location);
    assert.match(result.follow ? '' : result.reason, /not followed/);
  }
  assert.deepEqual(followed(hop(302, 'next?x=1#frag', request({ url: 'https://api.example.com/a/b' }))).url, 'https://api.example.com/a/next?x=1#frag');
});

test('The hop never changes the request it was given', () => {
  const original = request();
  const copy = JSON.stringify([original.method, original.url, original.headers]);
  hop(303, 'https://other.test/x', original);
  assert.equal(JSON.stringify([original.method, original.url, original.headers]), copy);
});
