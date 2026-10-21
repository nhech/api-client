import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startLoopback } from '../../src/engine/loopback';

/** The place the person is sent back to after signing in: it takes one answer, from the right place, for the right attempt, and nothing else. */

interface Answer { status: number; body: string; headers: Record<string, string | string[] | undefined> }

function get(url: string, options: { host?: string; method?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: options.method ?? 'GET', headers: options.host === undefined ? {} : { Host: options.host }, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

const refusedConnection = (url: string): Promise<boolean> => get(url).then(() => false, () => true);

test('The answer with the right state ends the wait with the code, the page that is shown repeats nothing of the request, and the server is gone', async () => {
  const loopback = await startLoopback({ state: 'state-1' });
  assert.match(loopback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const answer = await get(`${loopback.redirectUri}?code=the-code&state=state-1&evil=%3Cscript%3Ealert(1)%3C/script%3E`);
  assert.equal(answer.status, 200);
  assert.match(answer.body, /You can close this tab/);
  assert.ok(!answer.body.includes('evil') && !answer.body.includes('script>') && !answer.body.includes('the-code'), 'nothing of the request comes back');
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.headers['content-security-policy'], "default-src 'none'");
  assert.deepEqual(await loopback.result, { ok: true, code: 'the-code' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await refusedConnection(`${loopback.redirectUri}?code=late&state=state-1`), true, 'nobody is listening any more');
});

test('A request with another state or none, from another name, on another path or by another method is answered and does not end the wait', async () => {
  const loopback = await startLoopback({ state: 'right', timeoutMs: 10_000 });
  const base = loopback.redirectUri;
  const port = new URL(base).port;
  assert.equal((await get(`${base}?code=c&state=wrong`)).status, 400);
  assert.equal((await get(`${base}?code=c`)).status, 400);
  assert.equal((await get(`${base}?code=c&state=`)).status, 400);
  assert.equal((await get(`${base}?code=c&state=righ`)).status, 400, 'a state that is part of the right one');
  assert.equal((await get(`${base}?code=c&state=right`, { host: `evil.test:${port}` })).status, 400, 'a name that points here is not the address that was agreed');
  assert.equal((await get(`${base}?code=c&state=right`, { host: `127.0.0.1:${Number(port) + 1}` })).status, 400);
  assert.equal((await get(`${base}?code=c&state=right`, { host: 'localhost' })).status, 400);
  assert.equal((await get(`http://127.0.0.1:${port}/other?code=c&state=right`)).status, 404);
  assert.equal((await get(`${base}?code=c&state=right`, { method: 'POST' })).status, 405);
  assert.equal((await get(`${base}/?code=c&state=right`)).status, 404, 'the path has to be exactly the one that was agreed');
  const pending = await Promise.race([loopback.result, new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 100))]);
  assert.equal(pending, 'still waiting');
  assert.equal((await get(`${base}?code=real&state=right`)).status, 200);
  assert.deepEqual(await loopback.result, { ok: true, code: 'real' });
});

test('The provider can refuse: the person said no, and what it says is made printable and short', async () => {
  const loopback = await startLoopback({ state: 's' });
  const bad = `access_denied${String.fromCharCode(10)}x`;
  const answer = await get(`${loopback.redirectUri}?error=${encodeURIComponent(bad)}&error_description=${encodeURIComponent('The user said no'.padEnd(400, '!'))}&state=s`);
  assert.equal(answer.status, 200);
  const result = await loopback.result;
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /^The provider refused: access_denied\?x \(The user said no!+\)\.$/);
  assert.ok((result.ok ? '' : result.error).length < 400);
  const plain = await startLoopback({ state: 's' });
  await get(`${plain.redirectUri}?error=server_error&state=s`);
  assert.deepEqual(await plain.result, { ok: false, error: 'The provider refused: server_error.' });
});

test('An answer with a state but no code, or a code that is far too long, ends the wait with no code', async () => {
  const none = await startLoopback({ state: 's' });
  assert.equal((await get(`${none.redirectUri}?state=s`)).status, 400);
  assert.deepEqual(await none.result, { ok: false, error: 'The provider sent no code back.' });
  const empty = await startLoopback({ state: 's' });
  await get(`${empty.redirectUri}?code=&state=s`);
  assert.equal((await empty.result).ok, false);
  const long = await startLoopback({ state: 's' });
  await get(`${long.redirectUri}?code=${'x'.repeat(5000)}&state=s`);
  assert.deepEqual(await long.result, { ok: false, error: 'The provider sent no code back.' });
  const edge = await startLoopback({ state: 's' });
  await get(`${edge.redirectUri}?code=${'x'.repeat(4096)}&state=s`);
  assert.equal((await edge.result).ok, true, 'a code of the greatest size that is accepted');
});

test('The wait has an end: a time, a signal, or a call to close; each leaves nothing listening', async () => {
  const slow = await startLoopback({ state: 's', timeoutMs: 80 });
  assert.deepEqual(await slow.result, { ok: false, error: 'No answer came back in time.' });
  assert.equal(await refusedConnection(`${slow.redirectUri}?code=c&state=s`), true);
  const controller = new AbortController();
  const aborted = await startLoopback({ state: 's', signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();
  assert.deepEqual(await aborted.result, { ok: false, error: 'cancelled' });
  const before = new AbortController();
  before.abort();
  const early = await startLoopback({ state: 's', signal: before.signal, timeoutMs: 10_000 });
  assert.deepEqual(await early.result, { ok: false, error: 'cancelled' });
  const closed = await startLoopback({ state: 's', timeoutMs: 10_000 });
  closed.close();
  assert.deepEqual(await closed.result, { ok: false, error: 'cancelled' });
  closed.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await refusedConnection(`${closed.redirectUri}?code=c&state=s`), true);
  const done = await startLoopback({ state: 's', timeoutMs: 10_000 });
  await get(`${done.redirectUri}?code=c&state=s`);
  assert.equal((await done.result).ok, true);
  done.close();
  assert.equal((await done.result).ok, true, 'closing after the answer does not change it');
});

test('A redirect address that was registered with the provider is listened on as it is, and only if it is on this computer', async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/oauth/cb`;
  const registered = await startLoopback({ state: 's', redirectUrl: url });
  assert.equal(registered.redirectUri, url);
  assert.equal((await get(`${url}?code=c&state=s`)).status, 200);
  assert.deepEqual(await registered.result, { ok: true, code: 'c' });
  const port2 = await freePort();
  const named = await startLoopback({ state: 's', redirectUrl: `http://localhost:${port2}/cb` });
  assert.equal(named.redirectUri, `http://localhost:${port2}/cb`);
  assert.equal((await get(`http://127.0.0.1:${port2}/cb?code=c&state=s`, { host: `localhost:${port2}` })).status, 200, 'the name of the address that was agreed');
  assert.deepEqual(await named.result, { ok: true, code: 'c' });
  const other = await startLoopback({ state: 's', redirectUrl: `http://127.0.0.1:${await freePort()}/cb`, timeoutMs: 10_000 });
  assert.equal((await get(`${other.redirectUri}?code=c&state=s`, { host: `localhost:${new URL(other.redirectUri).port}` })).status, 400, 'a name that was not the one agreed');
  other.close();
  for (const bad of ['https://127.0.0.1:8765/cb', 'http://example.test:8765/cb', 'http://127.0.0.1/cb', 'http://127.0.0.1:0/cb', 'http://0.0.0.0:8765/cb', 'http://[::1]:8765/cb', 'http://127.0.0.1:8765/cb?x=1', 'http://127.0.0.1:8765/cb#frag', 'nonsense', 'http://127.0.0.1.evil.test:8765/cb']) {
    await assert.rejects(startLoopback({ state: 's', redirectUrl: bad }), /redirect address/, bad);
  }
  const taken = createServer();
  await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
  const busy = (taken.address() as AddressInfo).port;
  await assert.rejects(startLoopback({ state: 's', redirectUrl: `http://127.0.0.1:${busy}/cb` }), new RegExp(`port ${busy} is already in use`));
  await new Promise<void>(resolve => taken.close(() => resolve()));
  const blank = await startLoopback({ state: 's', redirectUrl: '   ', timeoutMs: 10_000 });
  assert.match(blank.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'an address that is only spaces is none');
  blank.close();
});

test('It listens on 127.0.0.1 only, and a request with a very large header is refused', async () => {
  const loopback = await startLoopback({ state: 's', timeoutMs: 10_000 });
  assert.equal(loopback.listeningOn, '127.0.0.1', 'not on the addresses of the network');
  const port = new URL(loopback.redirectUri).port;
  const big = await new Promise<number>(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/callback?state=s&code=c', headers: { 'X-Big': 'x'.repeat(20_000) }, agent: false }, res => { resolve(res.statusCode ?? 0); res.resume(); });
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.ok(big === 431 || big === 0, `refused (${big})`);
  loopback.close();
});

/** A port that is free on 127.0.0.1 and on ::1, or undefined when this machine has no ::1. */
async function freePortOnBoth(): Promise<number | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const six = createServer();
    try { await new Promise<void>((resolve, reject) => { six.once('error', reject); six.listen(0, '::1', resolve); }); } catch { return undefined; }
    const port = (six.address() as AddressInfo).port;
    await new Promise<void>(resolve => six.close(() => resolve()));
    const four = createServer();
    try {
      await new Promise<void>((resolve, reject) => { four.once('error', reject); four.listen(port, '127.0.0.1', resolve); });
      await new Promise<void>(resolve => four.close(() => resolve()));
      return port;
    } catch { /* taken on 127.0.0.1: try another */ }
  }
  return undefined;
}

test('An address with the name localhost is answered on both 127.0.0.1 and ::1, so that the browser reaches the server whichever it resolves the name to', async t => {
  const port = await freePortOnBoth();
  if (port === undefined) { t.skip('this machine has no ::1'); return; }
  const loopback = await startLoopback({ redirectUrl: `http://localhost:${port}/callback`, state: 's1', timeoutMs: 10_000 });
  try {
    const refused = await get(`http://[::1]:${port}/callback?code=x&state=wrong`, { host: `localhost:${port}` });
    assert.equal(refused.status, 400, 'it is the server of the attempt that answers on ::1');
    const answer = await get(`http://[::1]:${port}/callback?code=the-code&state=s1`, { host: `localhost:${port}` });
    assert.equal(answer.status, 200);
    assert.deepEqual(await loopback.result, { ok: true, code: 'the-code' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await refusedConnection(`http://[::1]:${port}/callback?code=late&state=s1`), true, 'and it is gone on ::1 too');
  } finally { loopback.close(); }
});

test('When another process already holds the port on ::1, a localhost address is refused: the answer could go to it', async t => {
  const port = await freePortOnBoth();
  if (port === undefined) { t.skip('this machine has no ::1'); return; }
  const squatter = createServer((req, res) => { res.end('squatter'); });
  await new Promise<void>(resolve => squatter.listen(port, '::1', resolve));
  try {
    await assert.rejects(startLoopback({ redirectUrl: `http://localhost:${port}/callback`, state: 's1' }), /already in use on ::1/);
    assert.equal(await refusedConnection(`http://127.0.0.1:${port}/callback?code=x&state=s1`), true, 'and nothing is left listening on 127.0.0.1');
    const loopback = await startLoopback({ redirectUrl: `http://127.0.0.1:${port}/callback`, state: 's1', timeoutMs: 10_000 });
    assert.equal(loopback.redirectUri, `http://127.0.0.1:${port}/callback`, 'an address with 127.0.0.1 is not held to it: only that interface is used');
    loopback.close();
  } finally { await new Promise<void>(resolve => squatter.close(() => resolve())); }
});
