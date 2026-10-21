import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBaseUrl, effectiveRequest, MAX_LEVELS, type Level } from '../../src/core/inherit';
import { DEFAULT_SETTINGS, newContainer, newRequest, type Auth, type Container, type KV, type Request, type SettingsOverride } from '../../src/core/model';

const kv = (name: string, value: string, enabled = true): KV => ({ name, value, enabled, description: '' });
const level = (kind: 'collection' | 'folder', name: string, change: Partial<Container> = {}): Level => ({ kind, name, container: { ...newContainer(`id-${name}`, name), ...change } });
const request = (change: Partial<Request> = {}): Request => ({ ...newRequest('r1', 'Request'), ...change });

test('The base URL of the nearest level that has one is put before a URL that is not absolute', () => {
  const chain = [level('collection', 'Shop', { baseUrl: 'https://api.example.com' }), level('folder', 'Orders', { baseUrl: 'https://orders.example.com' }), level('folder', 'Open')];
  const result = effectiveRequest(request({ url: '/list' }), chain);
  assert.equal(result.url, 'https://orders.example.com/list');
  assert.equal(result.baseUrlFrom, 'Orders');
  for (const url of ['https://other.test/x', 'HTTP://other.test/x', '{{host}}/x', '']) {
    const absolute = effectiveRequest(request({ url }), chain);
    assert.equal(absolute.url, url);
    assert.equal(absolute.baseUrlFrom, undefined, url);
  }
  assert.equal(applyBaseUrl('/a', ''), '/a');
  assert.equal(effectiveRequest(request({ url: '/a' }), [level('collection', 'Shop')]).url, '/a');
});

test('Headers go outermost first; a nearer level replaces an inherited header of the same name, whatever its case, and a disabled one removes it', () => {
  const chain = [
    level('collection', 'Shop', { headers: [kv('Accept', 'application/json'), kv('X-Team', 'pets'), kv('X-Trace', 'on')] }),
    level('folder', 'Orders', { headers: [kv('accept', 'text/plain'), kv('X-Trace', 'off', false)] })
  ];
  const result = effectiveRequest(request({ headers: [kv('X-Id', '1'), kv('X-Id', '2'), kv('X-Skipped', 'x', false), kv('', 'nameless')] }), chain);
  assert.deepEqual(result.headers.map(h => `${h.name}: ${h.value} (${h.from})`), ['X-Team: pets (Shop)', 'accept: text/plain (Orders)', 'X-Id: 1 (request)', 'X-Id: 2 (request)']);
});

test('Authentication: the request keeps its own, even "none"; otherwise the nearest level that chose one decides; nothing chosen means none', () => {
  const bearer: Auth = { kind: 'bearer', token: 't', prefix: 'Bearer' };
  const basic: Auth = { kind: 'basic', username: 'u', password: 'p' };
  const chain = [level('collection', 'Shop', { auth: bearer }), level('folder', 'Orders', { auth: basic }), level('folder', 'Open')];
  assert.deepEqual([effectiveRequest(request(), chain).auth, effectiveRequest(request(), chain).authFrom], [basic, 'Orders']);
  assert.deepEqual([effectiveRequest(request({ auth: { kind: 'none' } }), chain).auth.kind, effectiveRequest(request({ auth: { kind: 'none' } }), chain).authFrom], ['none', 'request']);
  assert.equal(effectiveRequest(request({ auth: bearer }), chain).authFrom, 'request');
  const stopped = [level('collection', 'Shop', { auth: bearer }), level('folder', 'Public', { auth: { kind: 'none' } })];
  assert.deepEqual([effectiveRequest(request(), stopped).auth.kind, effectiveRequest(request(), stopped).authFrom], ['none', 'Public']);
  assert.deepEqual([effectiveRequest(request(), [level('collection', 'Shop')]).auth.kind, effectiveRequest(request(), []).authFrom], ['none', 'none']);
});

test('Scripts and assertions run outermost first with the request last; empty scripts, disabled and repeated assertions are left out', () => {
  const chain = [
    level('collection', 'Shop', { scripts: { pre: 'a();', post: '   ' }, tests: [{ expr: 'status == 200', enabled: true }, { expr: 'duration < 1', enabled: false }] }),
    level('folder', 'Orders', { scripts: { pre: 'b();', post: 'c();' }, tests: [{ expr: 'status == 200', enabled: true }, { expr: 'body includes ok', enabled: true }] })
  ];
  const result = effectiveRequest(request({ scripts: { pre: 'd();', post: 'e();' }, tests: [{ expr: 'json $.id exists', enabled: true }, { expr: 'body includes ok', enabled: true }] }), chain);
  assert.deepEqual(result.preScripts, [{ code: 'a();', from: 'Shop', id: 'id-Shop' }, { code: 'b();', from: 'Orders', id: 'id-Orders' }, { code: 'd();', from: 'request', id: 'r1' }], 'each says whose it is, by the id that survives a rename');
  assert.deepEqual(result.postScripts, [{ code: 'c();', from: 'Orders', id: 'id-Orders' }, { code: 'e();', from: 'request', id: 'r1' }]);
  assert.deepEqual(result.tests, [{ expr: 'status == 200', from: 'Shop' }, { expr: 'body includes ok', from: 'Orders' }, { expr: 'json $.id exists', from: 'request' }]);
});

test('Settings: the defaults, then the workspace, the collection, each folder and the request, field by field', () => {
  const chain = [level('collection', 'Shop', { settings: { timeoutMs: 1000, maxRedirects: 3 } }), level('folder', 'Orders', { settings: { timeoutMs: 2000, cookies: false } })];
  const result = effectiveRequest(request({ settings: { followRedirects: false } }), chain, { timeoutMs: 500, rejectUnauthorized: false, httpVersion: 'auto' });
  assert.deepEqual(result.settings, { ...DEFAULT_SETTINGS, timeoutMs: 2000, maxRedirects: 3, cookies: false, followRedirects: false, rejectUnauthorized: false, httpVersion: 'auto' });
  assert.deepEqual(effectiveRequest(request(), []).settings, DEFAULT_SETTINGS);
});

test('Only the nearest levels count, so a chain of a thousand folders cannot make a request expensive', () => {
  const chain: Level[] = [level('collection', 'Deep', { baseUrl: 'https://far.example.com', auth: { kind: 'bearer', token: 't', prefix: 'Bearer' } })];
  for (let index = 0; index < 2000; index++) chain.push(level('folder', `f${index}`));
  const started = performance.now();
  const result = effectiveRequest(request({ url: '/x' }), chain);
  assert.ok(performance.now() - started < 200);
  assert.equal(result.truncated, true);
  assert.equal(result.url, '/x', 'the base URL of a level beyond the limit is not used');
  assert.equal(result.auth.kind, 'none');
  assert.equal(effectiveRequest(request(), chain.slice(0, MAX_LEVELS)).truncated, false);
});

test('Property: on random chains the result is what a plain nearest-first search finds (500 chains)', () => {
  let state = 12345;
  const random = (n: number): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state >>> 16) % n; };
  const AUTHS: Auth[] = [{ kind: 'inherit' }, { kind: 'none' }, { kind: 'bearer', token: 'a', prefix: 'Bearer' }, { kind: 'basic', username: 'u', password: 'p' }];
  for (let run = 0; run < 500; run++) {
    const chain: Level[] = [];
    for (let depth = random(6); depth >= 0; depth--) {
      const settings: SettingsOverride = random(2) === 0 ? {} : { timeoutMs: 1 + random(9) };
      chain.push(level(chain.length === 0 ? 'collection' : 'folder', `L${chain.length}`, { baseUrl: random(3) === 0 ? `https://h${chain.length}.test` : '', auth: AUTHS[random(AUTHS.length)] as Auth, settings }));
    }
    const own = AUTHS[random(AUTHS.length)] as Auth;
    const ownSettings: SettingsOverride = random(2) === 0 ? {} : { timeoutMs: 100 + random(9) };
    const result = effectiveRequest(request({ url: '/p', auth: own, settings: ownSettings }), chain);
    const near = [...chain].reverse();
    const baseOracle = near.find(l => l.container.baseUrl !== '');
    assert.equal(result.url, baseOracle === undefined ? '/p' : `${baseOracle.container.baseUrl}/p`, `run ${run}`);
    const authOracle = own.kind !== 'inherit' ? own : near.find(l => l.container.auth.kind !== 'inherit')?.container.auth ?? { kind: 'none' };
    assert.deepEqual(result.auth, authOracle, `run ${run}`);
    assert.notEqual(result.auth.kind, 'inherit');
    // The request's own value is nearer than every level; then the nearest level that sets one; then the default.
    const expected = ownSettings.timeoutMs ?? near.map(l => l.container.settings.timeoutMs).find(v => v !== undefined) ?? DEFAULT_SETTINGS.timeoutMs;
    assert.equal(result.settings.timeoutMs, expected, 'run ' + run);
  }
});
