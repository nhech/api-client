import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { refuseLocalAddresses } from '../../src/engine/lookup';
import { connectedToLocal, mustRefuseLocalAddresses, send, type SendOptions } from '../../src/engine/send';
import { EngineError, type WireRequest } from '../../src/engine/types';
import { startServer } from '../support/servers/http-server';
import { startProxy } from '../support/servers/proxy-server';

/** A name is not an address: after a redirect from a public address, a name that resolves to this machine is not connected to. */

type Answer = { error: NodeJS.ErrnoException | null; address: unknown; family?: number };
const lookupOf = (answer: Answer) => refuseLocalAddresses((_host, _options, callback) => { callback(answer.error, answer.address, answer.family); });
const ask = (answer: Answer, options: unknown = {}): Promise<Answer> => new Promise(resolve => { lookupOf(answer)('x.example', options, (error, address, family) => { resolve({ error, address, ...(family === undefined ? {} : { family }) }); }); });

test('An address on this machine, a private one or a link-local one is refused, a public one is passed on as it came, and an error is passed on', async () => {
  for (const address of ['127.0.0.1', '127.9.9.9', '::1', '0.0.0.0', '::', '169.254.169.254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:0.0.0.0']) {
    const result = await ask({ error: null, address, family: address.includes(':') ? 6 : 4 });
    assert.ok(result.error instanceof EngineError, address);
    assert.equal((result.error as unknown as EngineError).code, 'network');
    assert.match((result.error as unknown as EngineError).message, /The name x\.example leads to .* an address on this machine or network, after a redirect from a public address, which is not followed/, address);
  }
  assert.deepEqual(await ask({ error: null, address: '93.184.216.34', family: 4 }), { error: null, address: '93.184.216.34', family: 4 });
  assert.deepEqual(await ask({ error: null, address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }), { error: null, address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 });
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', 'fd00::1', 'fc00::1']) assert.ok((await ask({ error: null, address, family: address.includes(':') ? 6 : 4 })).error instanceof EngineError, address);
  for (const address of ['172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.167.1.1', '2001:db8::1']) assert.equal((await ask({ error: null, address, family: address.includes(':') ? 6 : 4 })).error, null, address);
  const failure = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  assert.equal((await ask({ error: failure, address: '' })).error, failure);
});

test('When the lookup asks for all addresses, one that is local among them refuses the whole answer', async () => {
  const mixed = [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  const refused = await ask({ error: null, address: mixed }, { all: true });
  assert.ok(refused.error instanceof EngineError);
  const fine = [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];
  assert.deepEqual(await ask({ error: null, address: fine }, { all: true }), { error: null, address: fine });
});

const get = (url: string): WireRequest => ({ method: 'GET', url, headers: [] });

/** Makes the names of the test resolve to the address of the server of the test, as a server that owns its DNS could. */
async function withNames<T>(names: readonly string[], run: () => Promise<T>): Promise<T> {
  const original = dns.lookup;
  const fake = ((host: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void) => {
    const done = typeof options === 'function' ? options as typeof callback : callback;
    const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (names.includes(host)) { if (wantsAll) done(null, [{ address: '127.0.0.1', family: 4 }]); else done(null, '127.0.0.1', 4); return; }
    (original as unknown as (host: string, options: unknown, callback: unknown) => void)(host, options, callback);
  }) as unknown as typeof dns.lookup;
  (dns as { lookup: typeof dns.lookup }).lookup = fake;
  try { return await run(); } finally { (dns as { lookup: typeof dns.lookup }).lookup = original; }
}

test('What was connected to is the address of the socket, and the text of the host only behind a proxy or when no address was seen', () => {
  assert.equal(connectedToLocal('https://public.example/a', '93.184.216.34', false), false);
  assert.equal(connectedToLocal('https://public.example/a', '127.0.0.1', false), true, 'a name that pointed at this machine');
  assert.equal(connectedToLocal('https://internal.corp.example/a', '10.1.2.3', false), true, 'an internal name');
  assert.equal(connectedToLocal('https://public.example/a', '::ffff:192.168.1.5', false), true, 'a mapped address');
  assert.equal(connectedToLocal('http://10.1.2.3/a', '93.184.216.34', true), true, 'behind a proxy the host is judged by its text: the address seen is the proxy\'s');
  assert.equal(connectedToLocal('https://public.example/a', '127.0.0.1', true), false, 'and a name is not an address');
  assert.equal(connectedToLocal('http://localhost:3000/a', undefined, false), true, 'with no address seen, the text');
  assert.equal(connectedToLocal('not an address', undefined, false), false);
});

test('The address that a name resolves to is refused after a redirect from the internet, in every other case it is not', () => {
  assert.equal(mustRefuseLocalAddresses(1, false, false), true, 'the second hop after a connection to a public address');
  assert.equal(mustRefuseLocalAddresses(3, false, false), true);
  assert.equal(mustRefuseLocalAddresses(0, false, false), false, 'the first address is the one the person wrote');
  assert.equal(mustRefuseLocalAddresses(1, true, false), false, 'the person allowed it');
  assert.equal(mustRefuseLocalAddresses(1, false, true), false, 'the hop before was on this machine or network: a company sends its people from one internal name to another');
});

test('A connection after a redirect goes through the guard of the lookup: a name that resolves to this machine does not get a connection', async () => {
  const { exchange } = await import('../../src/engine/transport');
  const { DEFAULT_DECODE_LIMITS } = await import('../../src/engine/decode');
  const server = await startServer();
  try {
    const port = new URL(server.url).port;
    const options = { signal: new AbortController().signal, connectTimeoutMs: 5000, idleTimeoutMs: 5000, tls: { rejectUnauthorized: true }, responseLimitBytes: 1024 * 1024, decode: DEFAULT_DECODE_LIMITS, body: () => 'read' as const };
    await withNames(['rebind.test'], async () => {
      await assert.rejects(exchange(get(`http://rebind.test:${port}/echo`), { ...options, refuseLocalAddresses: true }), (error: unknown) => error instanceof EngineError && error.code === 'network' && /The name rebind\.test leads to 127\.0\.0\.1/.test(error.message));
      assert.equal(server.requests.length, 0, 'nothing reached the server');
      const allowed = await exchange(get(`http://rebind.test:${port}/echo`), options);
      assert.equal(allowed.status, 200, 'without the guard the same request is made');
      assert.equal(allowed.remoteAddress, '127.0.0.1', 'and the address that was connected to is reported');
    });
  } finally { await server.close(); }
});

const BASE: SendOptions = { timeoutMs: 10_000, followRedirects: true, maxRedirects: 10, tls: { rejectUnauthorized: true }, responseLimitBytes: 1024 * 1024 };

test('A redirect from the internet to this machine that the settings allow is followed with a note, and a redirect between two local addresses with none', async () => {
  const server = await startServer();
  const proxy = await startProxy();
  try {
    const port = new URL(server.url).port;
    const target = `http://127.0.0.1:${port}/echo`;
    await withNames(['public.example'], async () => {
      // The first hop goes through a proxy, which is all that is seen of it: the name is public, so the hop after it is a redirect from the internet.
      const through = { ...BASE, allowLocalRedirect: true, proxy: { all: proxy.url, proxyLoopback: true } };
      const followed = await send(get(`http://public.example:${port}/to?to=${encodeURIComponent(target)}`), through);
      assert.equal(followed.status, 200);
      assert.equal(followed.redirects.length, 1);
      assert.deepEqual(followed.warnings.filter(note => /^A redirect from the internet/.test(note)), [`A redirect from the internet to 127.0.0.1:${port}, an address on this machine or network, was followed because the settings of the request allow it.`]);
      // The same without the permission is not followed.
      const refused = await send(get(`http://public.example:${port}/to?to=${encodeURIComponent(target)}`), { ...through, allowLocalRedirect: false });
      assert.equal(refused.redirects.length, 0);
      assert.ok(refused.warnings.some(note => /^Not followed/.test(note)), refused.warnings.join(' | '));
    });
    // From this machine to this machine there is nothing to say.
    const local = await send(get(`${server.url}/to?to=${encodeURIComponent(target)}`), { ...BASE, allowLocalRedirect: true });
    assert.equal(local.status, 200);
    assert.equal(local.redirects.length, 1);
    assert.deepEqual(local.warnings.filter(note => /^A redirect from the internet/.test(note)), []);
  } finally { await proxy.close(); await server.close(); }
});
