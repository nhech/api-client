import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBaseUrl, collectScripts, inheritedBaseUrl, inheritHeaders, inheritTests, InheritBudget, MAX_INHERIT_LEVELS, resolveAuth, settingsLevels } from '../../src/convert/inherit';
import type { Level } from '../../src/convert/inherit';
import type { TcSettings } from '../../src';
import { refAuth, refBaseUrl, refHeaders, refScripts, refTests } from '../support/reference-inherit';
import { random } from '../support/source';

const levels = (...settings: (TcSettings | undefined)[]): Level[] => settings.map((s, i) => ({ kind: i === settings.length - 1 ? 'collection' : 'folder', name: i === settings.length - 1 ? 'Col' : `F${i}`, settings: s }));
const h = (name: string, value: string, enabled = true) => ({ name, value, enabled });

test('N15: the nearest level that has a base URL wins, an empty one is skipped, and a missing one finds none', () => {
  assert.deepEqual(inheritedBaseUrl(levels({ options: { baseUrl: 'https://near' } }, { options: { baseUrl: 'https://far' } })), { value: 'https://near', from: 'F0' });
  assert.deepEqual(inheritedBaseUrl(levels({ options: { baseUrl: '' } }, undefined, { options: { baseUrl: 'https://col' } })), { value: 'https://col', from: 'Col' });
  assert.equal(inheritedBaseUrl(levels({ options: { baseUrl: 5 as unknown as string } }, {}, undefined)), undefined);
  assert.equal(inheritedBaseUrl(levels({ options: 'x' as unknown as { baseUrl: string } })), undefined);
});

test('N15: only a URL that is not absolute and does not start with a variable is prefixed', () => {
  assert.equal(applyBaseUrl('/users', 'https://api'), 'https://api/users');
  assert.equal(applyBaseUrl('users', 'https://api'), 'https://apiusers', 'plain concatenation, as Thunder does');
  assert.equal(applyBaseUrl('https://other/x', 'https://api'), 'https://other/x');
  assert.equal(applyBaseUrl('HTTP://other/x', 'https://api'), 'HTTP://other/x');
  assert.equal(applyBaseUrl('{{baseUrl}}/x', 'https://api'), '{{baseUrl}}/x');
  assert.equal(applyBaseUrl('', 'https://api'), '');
});

test('N16: the request keeps its own type, even "none"', () => {
  assert.deepEqual(resolveAuth({ type: 'bearer', bearer: 't' }, levels({ auth: { type: 'basic' } })), { source: 'own', auth: { type: 'bearer', bearer: 't' } });
  assert.equal(resolveAuth({ type: 'none' }, levels({ auth: { type: 'basic' } })).source, 'own');
});

test('N16: a missing or "inherit" type takes the nearest level with another type; "none" stops; the collection counts "inherit" as "none"', () => {
  for (const own of [undefined, {}, { type: '' }, { type: 'inherit' }]) {
    const resolved = resolveAuth(own, levels({ auth: { type: 'inherit' } }, undefined, { auth: { type: 'basic', basic: { username: 'u' } } }, { auth: { type: 'bearer' } }));
    assert.equal(resolved.source, 'inherited');
    assert.equal(resolved.auth?.type, 'basic');
    assert.equal(resolved.from, 'F2');
  }
  assert.deepEqual(resolveAuth(undefined, levels({ auth: { type: 'none' } }, { auth: { type: 'bearer' } })), { source: 'none', auth: undefined });
  assert.equal(resolveAuth(undefined, levels({ auth: { type: 'inherit' } }, { auth: { type: 'inherit' } })).source, 'none');
  assert.equal(resolveAuth(undefined, levels(undefined, undefined)).source, 'none');
  assert.equal(resolveAuth(undefined, levels({ auth: 'x' as unknown as { type: string } }, { auth: { type: 'bearer' } })).auth?.type, 'bearer');
});

test('N17: a header is added when the request has no enabled header of the same exact name; the nearest wins', () => {
  const added = inheritHeaders([h('Accept', 'own')], levels({ headers: [{ name: 'Accept', value: 'folder' }, { name: 'X-A', value: 'near' }] }, { headers: [{ name: 'X-A', value: 'far' }, { name: 'X-B', value: 'far' }] }), new InheritBudget());
  assert.deepEqual(added.map(x => `${x.name}=${x.value}@${x.from}`), ['X-A=near@F0', 'X-B=far@Col']);
});

test('N17: names are compared exactly, a disabled header of the request does not block, and an inherited disabled one is added but does not block', () => {
  const added = inheritHeaders([h('Accept', 'own', false), h('x-a', 'own')], levels({ headers: [{ name: 'Accept', value: 'f' }, { name: 'X-A', value: 'f' }, { name: 'D', value: 'off', isDisabled: true }] }, { headers: [{ name: 'D', value: 'on' }] }), new InheritBudget());
  assert.deepEqual(added.map(x => `${x.name}=${x.value}:${x.enabled}`), ['Accept=f:true', 'X-A=f:true', 'D=off:false', 'D=on:true']);
});

test('N17: entries that are not usable headers are skipped', () => {
  const messy = { headers: [null, 3, { value: 'no name' }, { name: '' }, { name: 'N', value: 5 }] } as unknown as TcSettings;
  const notAList = { headers: 'x' } as unknown as TcSettings;
  const added = inheritHeaders([], levels(messy, notAList), new InheritBudget());
  assert.deepEqual(added.map(x => `${x.name}=${x.value}`), ['N=5']);
});

test('N18: a level test is added unless the request already has one with the same type, custom and action, for the checked actions only', () => {
  const own = [{ type: 'res-code', custom: '', action: 'equal', value: '200' }, { type: 'res-body', custom: '', action: 'contains', value: 'a' }];
  const added = inheritTests(own, levels({ tests: [
    { type: 'res-code', custom: '', action: 'equal', value: '201' },
    { type: 'res-body', custom: '', action: 'contains', value: 'b' },
    { type: 'res-time', custom: '', action: '<', value: '500' }
  ] }, { tests: [{ type: 'res-time', custom: '', action: '<', value: '900' }, { type: 'res-body', custom: '', action: 'contains', value: 'b' }] }), new InheritBudget());
  assert.deepEqual(added.map(x => `${x.test.type}|${x.test.action}|${String(x.test.value)}@${x.from}`), ['res-body|contains|b@F0', 'res-time|<|500@F0', 'res-body|contains|b@Col']);
});

test('N19: scripts run from the farthest level to the nearest and the request last; run-first and skip flags are noticed', () => {
  const collected = collectScripts(
    { preReq: { inlineScripts: [{ script: ['own pre'] }] }, postReq: { inlineScripts: [{ script: ['own post'] }, { script: ['  '] }, { script: 'not lines' }] } },
    levels({ preReq: { inlineScripts: [{ script: ['f pre'] }], runRequests: ['x'] } }, { postReq: { inlineScripts: [{ script: ['c post', 'second line'] }] }, preReq: { options: { skipRequest: true } } })
  );
  assert.deepEqual(collected.pre.map(b => `${b.from ?? 'own'}:${b.lines.join('/')}`), ['F0:f pre', 'own:own pre']);
  assert.deepEqual(collected.post.map(b => `${b.from ?? 'own'}:${b.lines.join('/')}`), ['Col:c post/second line', 'own:own post']);
  assert.equal(collected.runRequests, true);
  assert.equal(collected.skipRequest, true);
  const none = collectScripts({}, levels(undefined));
  assert.deepEqual([none.pre, none.post, none.runRequests, none.skipRequest], [[], [], false, false]);
});

test('Levels are the folders nearest first, then the collection; a chain over the limit is cut and says so', () => {
  const folder = (name: string) => ({ name, settings: { headers: [] } });
  let ancestry: { folder: ReturnType<typeof folder>; up: unknown } | undefined;
  for (let i = 0; i < 5; i++) ancestry = { folder: folder(`F${i}`), up: ancestry };
  const collection = { name: 'Col', settings: undefined };
  const full = settingsLevels(ancestry as never, collection);
  assert.deepEqual(full.levels.map(l => l.name), ['F4', 'F3', 'F2', 'F1', 'F0', 'Col']);
  assert.equal(full.truncated, false);
  const cut = settingsLevels(ancestry as never, collection, 2);
  assert.deepEqual(cut.levels.map(l => l.name), ['F4', 'F3', 'Col']);
  assert.equal(cut.truncated, true);
  assert.equal(settingsLevels(undefined, collection).levels.length, 1);
  assert.equal(MAX_INHERIT_LEVELS, 1024);
});

test('The budget stops inheritance for good and says it was exhausted', () => {
  const budget = new InheritBudget(3);
  const many = { headers: Array.from({ length: 10 }, (_, i) => ({ name: `H${i}`, value: 'v' })) };
  assert.equal(inheritHeaders([], levels(many), budget).length, 3);
  assert.equal(budget.exhausted, true);
  assert.equal(inheritHeaders([], levels(many), budget).length, 0);
  assert.equal(inheritTests([], levels({ tests: [{ type: 'a', custom: '', action: 'contains' }] }), budget).length, 0);
});

// ---------- P8: the real code and an independent reading of the spec agree on random cases ----------

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

function randomSettings(next: () => number): TcSettings | undefined {
  if (next() < 0.25) return undefined;
  const s: Record<string, unknown> = {};
  if (next() < 0.6) s['options'] = { baseUrl: pick(next, [undefined, '', 'https://a.example', '/b', '{{base}}']) };
  if (next() < 0.6) s['auth'] = pick(next, [undefined, { type: 'inherit' }, { type: 'none' }, { type: 'bearer', bearer: 'x' }, { type: 'basic' }, {}, { type: '' }]);
  if (next() < 0.7) s['headers'] = Array.from({ length: Math.floor(next() * 4) }, () => ({ name: pick(next, ['Accept', 'accept', 'X-A', 'X-B', 'Content-Type']), value: `v${Math.floor(next() * 5)}`, isDisabled: next() < 0.3 }));
  if (next() < 0.6) s['tests'] = Array.from({ length: Math.floor(next() * 4) }, () => ({ type: pick(next, ['res-code', 'json-query']), custom: pick(next, ['', 'json.a']), action: pick(next, ['equal', 'contains', '<', 'count']), value: `${Math.floor(next() * 3)}` }));
  if (next() < 0.5) s['preReq'] = { inlineScripts: [{ script: [`pre${Math.floor(next() * 3)}`] }], runRequests: next() < 0.3 ? ['r'] : [], options: { skipRequest: next() < 0.2 } };
  if (next() < 0.5) s['postReq'] = { inlineScripts: [{ script: [`post${Math.floor(next() * 3)}`] }] };
  return s as TcSettings;
}

test('P8: base URL, authentication, headers, tests and scripts inherit exactly as the independent reading says, on 1,000 random cases', () => {
  for (let seed = 1; seed <= 1000; seed++) {
    const next = random(seed);
    const depth = Math.floor(next() * 6);
    const settings = Array.from({ length: depth + 1 }, () => randomSettings(next));
    const lv = levels(...settings);
    const plain = settings; // the same data for the reference, nearest first, collection last
    const ownUrl = pick(next, ['/p', 'https://x/p', '{{u}}/p', '', 'rel']);
    const ownAuth = pick(next, [undefined, { type: 'inherit' }, { type: 'none' }, { type: 'bearer' }, {}] as const);
    const ownHeaders = Array.from({ length: Math.floor(next() * 3) }, () => ({ name: pick(next, ['Accept', 'accept', 'X-A', 'Content-Type']), value: 'own', enabled: next() < 0.7 }));
    const ownTests = Array.from({ length: Math.floor(next() * 3) }, () => ({ type: pick(next, ['res-code', 'json-query']), custom: pick(next, ['', 'json.a']), action: pick(next, ['equal', 'contains', '<']), value: '9' }));
    const ownScripts = { preReq: next() < 0.5 ? { inlineScripts: [{ script: ['own pre'] }], runRequests: next() < 0.2 ? ['r'] : undefined } : undefined, postReq: next() < 0.5 ? { inlineScripts: [{ script: ['own post'] }] } : undefined };
    const label = `seed ${seed}`;

    const base = inheritedBaseUrl(lv);
    assert.equal(base === undefined ? ownUrl : applyBaseUrl(ownUrl, base.value), refBaseUrl(ownUrl, plain).url, label);

    const auth = resolveAuth(ownAuth, lv);
    const refA = refAuth(ownAuth, plain);
    assert.deepEqual([auth.source, auth.auth?.type ?? (auth.source === 'own' ? 'inherit' : undefined)], [refA.source, refA.type], label);

    const headers = inheritHeaders(ownHeaders, lv, new InheritBudget());
    const refH = refHeaders(ownHeaders.map(x => ({ name: x.name, value: x.value, disabled: !x.enabled })), plain);
    assert.deepEqual(headers.map(x => `${x.name}|${x.value}|${x.enabled}`), refH.map(x => `${x.header.name}|${x.header.value}|${!x.header.disabled}`), label);

    const tests = inheritTests(ownTests, lv, new InheritBudget());
    const refT = refTests(ownTests, plain);
    assert.deepEqual(tests.map(x => JSON.stringify(x.test)), refT.map(x => JSON.stringify(x.test)), label);

    const scripts = collectScripts(ownScripts, lv);
    const refS = refScripts(ownScripts, plain);
    const norm = (blocks: { lines: string[]; from?: string }[]) => blocks.map(b => `${b.from === undefined ? 'own' : `L${lv.findIndex(l => l.name === b.from)}`}:${b.lines.join('\n')}`);
    assert.deepEqual(norm(scripts.pre), refS.pre, label);
    assert.deepEqual(norm(scripts.post), refS.post, label);
    assert.deepEqual([scripts.runRequests, scripts.skipRequest], [refS.runRequests, refS.skipRequest], label);
  }
});
