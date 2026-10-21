import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { refuseLocalAddresses } from '../../src/engine/lookup';
import { send, type SendOptions } from '../../src/engine/send';
import { EngineError, type WireRequest } from '../../src/engine/types';
import { startServer } from '../support/servers/http-server';

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

const BASE: SendOptions = { timeoutMs: 10_000, followRedirects: true, maxRedirects: 10, tls: { rejectUnauthorized: true }, responseLimitBytes: 1024 * 1024 };
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

test('A public name that redirects to a name that resolves to this machine is not followed: the second connection is never made', async () => {
  const server = await startServer();
  try {
    const port = new URL(server.url).port;
    await withNames(['public-site.test', 'rebind.test'], async () => {
      const target = encodeURIComponent(`http://rebind.test:${port}/echo`);
      await assert.rejects(send(get(`http://public-site.test:${port}/to?to=${target}`), BASE), (error: unknown) => error instanceof EngineError && error.code === 'network' && /The name rebind\.test leads to 127\.0\.0\.1/.test(error.message));
      assert.deepEqual(server.requests.map(request => request.url), [`/to?to=${target}`], 'only the first request reached the server');
      // The person can allow it: then the redirect is followed as before.
      const allowed = await send(get(`http://public-site.test:${port}/to?to=${target}`), { ...BASE, allowLocalRedirect: true });
      assert.equal(allowed.status, 200);
    });
  } finally { await server.close(); }
});

test('A request that starts on this machine is not held to the rule, and neither is a redirect to another path of the same name', async () => {
  const server = await startServer();
  try {
    const port = new URL(server.url).port;
    await withNames(['public-site.test'], async () => {
      const local = await send(get(`${server.url}/redirect/1`), BASE);
      assert.equal(local.status, 200, 'from 127.0.0.1 to 127.0.0.1');
      // The first hop is the address the person wrote, and the same name again is where they already are.
      const same = await send(get(`http://public-site.test:${port}/redirect/1`), BASE);
      assert.equal(same.status, 200);
    });
  } finally { await server.close(); }
});
