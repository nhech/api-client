import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { FINDING_CODES } from '../../src';
import type { Finding, FindingCode, TcSource } from '../../src';
import { importSource } from '../../src/import';
import { importFromPath } from '../../src/run';
import { relativePathProblem } from '../../src/write/paths';
import { CASES } from '../fixtures/cases';
import { file, folder, random, req, shuffled, source, v4 } from '../support/source';
import { parseHttp } from '../support/http-parser';
import { makeTree, snapshot, tryLink } from '../support/tree';

const text = (result: { files: { path: string; content: string }[] }, path: string): string => result.files.find(f => f.path === path)?.content ?? `<missing ${path}>`;

test('F2: the v3 flat files make collections with their requests, an "Unsorted" collection, and skip the history', async () => {
  const tree = makeTree({
    'thunderclient.json': [
      { _id: 'r1', colId: 'c1', containerId: '', name: 'list', url: '/items', method: 'GET', sortNum: 1 },
      { _id: 'r2', colId: 'c1', containerId: 'f1', name: 'create', url: '/items', method: 'POST', body: { type: 'json', raw: '{"a":1}' }, sortNum: 2 },
      { _id: 'r3', colId: 'history', name: 'old call', url: 'https://x.example/', method: 'GET' },
      { _id: 'r4', colId: 'gone', containerId: '', name: 'lost', url: 'https://x.example/lost', method: 'GET' }
    ],
    'thunderCollection.json': [{ _id: 'c1', colName: 'Shop', sortNum: 1, folders: [{ _id: 'f1', name: 'Admin', containerId: '' }], settings: { options: { baseUrl: 'https://v3.example' } } }],
    'thunderEnvironment.json': [{ _id: 'e1', name: 'dev', default: true, sortNum: 1, data: [{ name: 'host', value: 'dev.example' }] }]
  });
  try {
    const before = snapshot(tree.root);
    const result = await importFromPath(tree.root);
    assert.equal(snapshot(tree.root), before, 'P6: the source is untouched');
    assert.deepEqual(result.files.map(f => f.path).sort(), ['IMPORT_REPORT.md', 'Shop/Admin.http', 'Shop/index.http', 'Unsorted/index.http', 'http-client.env.json', 'rest-client.settings.json']);
    assert.equal(text(result, 'Shop/index.http'), '### list\n# @name list\nGET https://v3.example/items\n');
    assert.match(text(result, 'Shop/Admin.http'), /POST https:\/\/v3\.example\/items\nContent-Type: application\/json\n\n\{"a":1\}\n$/);
    assert.match(text(result, 'Unsorted/index.http'), /GET https:\/\/x\.example\/lost/);
    assert.deepEqual(result.findings.map(f => f.code).sort(), ['TC-HISTORY-SKIPPED', 'TC-INHERIT-BASEURL', 'TC-ORPHAN-REQUEST']);
    assert.deepEqual(JSON.parse(text(result, 'http-client.env.json')), { dev: { host: 'dev.example' } });
  } finally { tree.cleanup(); }
});

test('F5: a body or docs given as a list of lines or as one string come out the same', () => {
  const build = (lines: boolean): TcSource => source(file('collections/tc_col_a.json', 'v4-collection', v4('A', [], [
    req('r', '', { method: 'POST', url: '/x', body: { type: 'json', raw: lines ? ['{', '  "a": 1', '}'] : '{\n  "a": 1\n}' }, docs: lines ? ['First', 'Second'] : 'First\nSecond' })
  ], { settings: { docs: lines ? ['About', 'the collection'] : 'About\nthe collection' } })));
  assert.deepEqual(importSource(build(true)).files, importSource(build(false)).files);
  assert.match(text(importSource(build(true)), 'A/index.http'), /^# About\n# the collection\n\n### r\n# @name r\n# First\n# Second\nPOST \/x\n/);
});

test('F8: a broken tree is repaired in a safe way and says so', () => {
  const result = importSource(source(file('collections/tc_col_a.json', 'v4-collection', v4('Broken', [
    folder('a', 'A', 'b'), folder('b', 'B', 'a'), folder('lost', 'Lost', 'nowhere'), folder('self', 'Self', 'self')
  ], [req('in a', 'a'), req('in lost', 'lost'), req('nowhere', 'ghost'), { ...req('hist', ''), colId: 'history' }]))));
  const codes = result.findings.map(f => f.code);
  for (const code of ['TC-CYCLE', 'TC-ORPHAN-FOLDER', 'TC-ORPHAN-REQUEST', 'TC-HISTORY-SKIPPED'] as const) assert.ok(codes.includes(code), code);
  assert.equal(result.summary.requests, 3);
  const names = result.files.filter(f => f.path.endsWith('.http')).flatMap(f => parseHttp(f.content).requests.map(r => r.title));
  assert.deepEqual(names.sort(), ['in a', 'in lost', 'nowhere']);
});

test('F12: ties in order (same sortNum, same name) are settled the same way whatever the order of the data', () => {
  const requests = Array.from({ length: 12 }, (_, i) => req(i % 3 === 0 ? 'same' : `n${i % 4}`, '', { _id: `id${i % 5}`, sortNum: 1, url: `/u${i}` }));
  const baseline = importSource(source(file('collections/tc_col_a.json', 'v4-collection', v4('Ties', [folder('f1', 'F'), folder('f1', 'F')], requests)))).files;
  for (let seed = 1; seed <= 30; seed++) {
    const shuffledRequests = shuffled(requests, seed);
    const got = importSource(source(file('collections/tc_col_a.json', 'v4-collection', v4('Ties', shuffled([folder('f1', 'F'), folder('f1', 'F')], seed), shuffledRequests)))).files;
    assert.deepEqual(got, baseline, `seed ${seed}`);
  }
});

test('F11: hostile files do not stop the import, change nothing outside, and pollute nothing', async () => {
  const tree = makeTree({
    'collections/tc_col_a.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(v4('Hostile', [folder('f1', 'F')], [
      req('r', 'f1', { url: '/x', headers: [{ name: 'X-A', value: 'b' }] })
    ])).replace('"_id"', '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"_id"'))]),
    'collections/tc_col_utf8.json': Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]),
    'collections/tc_col_deep.json': `${'['.repeat(100)}${']'.repeat(100)}`,
    'collections/tc_col_big.json': `{"colName":"Big","requests":[],"folders":[],"note":"${'x'.repeat(6 * 1024 * 1024)}"}`
  });
  const outside = makeTree({ 'secret.json': { colName: 'Outside', requests: [], folders: [] } });
  try {
    const linked = tryLink(outside.path('secret.json'), tree.path('collections/tc_col_link.json'), 'file');
    const before = snapshot(tree.root);
    const result = await importFromPath(tree.root);
    assert.equal(snapshot(tree.root), before, 'P6');
    const codes = new Set(result.findings.map(f => f.code));
    assert.ok(codes.has('TC-PARSE-ERROR') && codes.has('TC-TOO-LARGE'));
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
    assert.ok(result.model.collections.some(c => c.name === 'Hostile'));
    assert.ok(!result.model.collections.some(c => c.name === 'Outside') || !linked, 'a link out of the folder is not followed');
    for (const f of result.files) assert.equal(relativePathProblem(f.path), undefined, f.path);
  } finally { tree.cleanup(); outside.cleanup(); }
});

// ---- every code of the catalog is produced by a real conversion ----

test('Every code of the catalog is produced by at least one fixture', async () => {
  const seen = new Set<FindingCode>();
  const take = (findings: readonly Finding[]): void => { for (const f of findings) seen.add(f.code); };

  for (const fixture of CASES) take(importSource(fixture.build()).findings);
  take(importSource(CASES.find(c => c.id === 'f10-secrets')?.build() ?? source(), { moveSecrets: false }).findings);

  const sink = (id: string, extra: object): TcSource => source(file(`collections/tc_col_${id}.json`, 'v4-collection', v4(id, [folder('f1', 'F', '', { settings: { envId: 'e1', runOptions: { x: 1 } } })], [
    req('method', '', { method: 'GET POST' }),
    req('graphql', '', { method: 'POST', body: { type: 'graphql', graphql: { query: '{ a }', variables: 'not json {' } } }),
    req('dups', '', { headers: [{ name: 'a', value: '1' }, { name: 'A', value: '2' }, { name: 'X-Break', value: 'one\ntwo' }] }),
    req('sysvar', '', { url: '/x/{{#date}}' }),
    req('settings', 'f1', { cookies: [{ name: 'c' }], settings: { timeout: 1 } }),
    req('prereq', '', { preReq: { runRequests: [{ id: 'other' }] } }),
    req('guess', '', { tests: [{ type: 'json-query', custom: 'data.id', action: 'equal', value: '1' }] }),
    req('conflict', '', { auth: { type: 'bearer', bearer: '{{t}}' }, headers: [{ name: 'Authorization', value: 'Bearer {{other}}' }] }),
    req('external', '', { method: 'POST', body: { type: 'text', raw: 'a\n### b' } }),
    { ...req('coerced', ''), url: 12345 },
    ...Object.values(extra)
  ])));
  take(importSource(sink('k', {})).findings);
  take(importSource(source(file('collections/tc_col_deep.json', 'v4-collection', v4('Deep', Array.from({ length: 40 }, (_, i) => folder(`d${i}`, `D${i}`, i === 0 ? '' : `d${i - 1}`)), [req('leaf', 'd39')])))).findings);
  take(importSource(sink('k2', {}), { emit: { maxOutputBytes: 300 } }).findings);

  const tree = makeTree({
    'collections/tc_col_a.json': v4('Both', [], [req('r')]),
    'collections/tc_col_bad.json': '{ not json',
    'thunderclient.json': [{ _id: 'h', colId: 'history', name: 'h', url: '/', method: 'GET' }],
    'export.json': { collectionName: 'Exported', version: '9.9', requests: [], folders: [] }
  });
  try {
    take((await importFromPath(tree.root)).findings);
    take((await importFromPath(tree.root, { limits: { maxFileBytes: 100 } })).findings);
    take((await importFromPath(tree.path('export.json'))).findings);
  } finally { tree.cleanup(); }

  const missing = FINDING_CODES.filter(code => !seen.has(code));
  assert.deepEqual(missing, [], `no fixture produces: ${missing.join(', ')}`);
});

// ---- P2: nothing the data holds can make the import throw ----

const PIECES = ['', 'a', ' ', '\n', '\r\n', '###', '{{v}}', '{{', '}}', '../', '..\\', 'CON', ':', '"', '\\', '\u0000'.replace('\\u0000', String.fromCodePoint(0)), String.fromCodePoint(0x202e), String.fromCodePoint(0x1f600), '__proto__', 'constructor'];

function junk(rand: () => number, depth = 0): unknown {
  switch (Math.floor(rand() * (depth > 2 ? 7 : 10))) {
    case 0: return null;
    case 1: return rand() < 0.5;
    case 2: return Math.floor(rand() * 2000 - 1000);
    case 3: return rand() < 0.5 ? 1e308 : -0.5;
    case 4: case 5: case 6: return Array.from({ length: Math.floor(rand() * 4) }, () => PIECES[Math.floor(rand() * PIECES.length)] ?? '').join('');
    case 7: return Array.from({ length: Math.floor(rand() * 4) }, () => junk(rand, depth + 1));
    default: return Object.fromEntries(Array.from({ length: Math.floor(rand() * 4) }, () => [PIECES[Math.floor(rand() * PIECES.length)] ?? 'k', junk(rand, depth + 1)]));
  }
}

const REQUEST_FIELDS: Readonly<Record<string, () => unknown>> = {
  name: () => 'request', url: () => '/path?x=1', method: () => 'POST', headers: () => [{ name: 'X-A', value: 'b' }], params: () => [{ name: 'x', value: '1' }],
  body: () => ({ type: 'json', raw: '{}' }), auth: () => ({ type: 'bearer', bearer: 'tok' }), tests: () => [{ type: 'res-code', custom: '', action: 'equal', value: '200' }],
  docs: () => 'docs', reqType: () => 'http', sortNum: () => 5, created: () => '2020', containerId: () => 'f1', colId: () => 'c', _id: () => 'id',
  settings: () => ({ headers: [] }), preReq: () => ({ inlineScripts: [{ script: ['x'] }] }), postReq: () => ({}), cookies: () => []
};

test('P2: random junk in every field never makes the import throw, and the files stay safe', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rand = random(seed);
    const requests = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
      const request: Record<string, unknown> = {};
      for (const [field, real] of Object.entries(REQUEST_FIELDS)) if (rand() < 0.8) request[field] = rand() < 0.5 ? real() : junk(rand);
      return request;
    });
    const folders = Array.from({ length: Math.floor(rand() * 3) }, (_, i) => ({ _id: rand() < 0.8 ? `f${i}` : junk(rand), name: rand() < 0.7 ? `F${i}` : junk(rand), containerId: rand() < 0.5 ? '' : junk(rand), settings: rand() < 0.5 ? junk(rand) : undefined, sortNum: junk(rand) }));
    const data = { _id: junk(rand), colName: rand() < 0.8 ? 'C' : junk(rand), settings: rand() < 0.5 ? junk(rand) : undefined, sortNum: junk(rand), folders, requests };
    const env = { _id: 'e', name: junk(rand), data: junk(rand), global: junk(rand), local: junk(rand), default: junk(rand) };
    const src = source(file('collections/tc_col_a.json', 'v4-collection', data), file('environments/tc_env_a.json', 'v4-environment', env), file('thunderclient.json', 'v3-requests', junk(rand)), file('thunderCollection.json', 'v3-collections', junk(rand)));
    let result;
    try { result = importSource(src); } catch (error) { assert.fail(`seed ${seed} threw: ${String(error)}`); }
    assert.ok(text(result, 'IMPORT_REPORT.md').startsWith('# Thunder Client import report'), `seed ${seed}`);
    for (const f of result.files) {
      assert.equal(relativePathProblem(f.path), undefined, `seed ${seed}: ${f.path}`);
      if (f.path.endsWith('.http')) assert.equal(parseHttp(f.content).empty, 0, `seed ${seed}: ${f.path}`);
      assert.ok(!f.content.includes('\r'), `seed ${seed}: ${f.path} has a CR`);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  }
});

test('P7: 5,000 requests are converted in well under the budget', t => {
  const folders = Array.from({ length: 50 }, (_, i) => folder(`f${i}`, `Folder ${i}`));
  const requests = Array.from({ length: 5000 }, (_, i) => req(`Request ${i}`, `f${i % 50}`, {
    method: 'POST', url: `/items/${i}?page=${i % 7}`, params: [{ name: 'page', value: String(i % 7) }],
    headers: [{ name: 'X-Request', value: String(i) }], body: { type: 'json', raw: `{"id":${i},"tags":["a","b"]}` },
    auth: { type: 'bearer', bearer: '{{token}}' }, tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }, { type: 'json-query', custom: 'json.id', action: 'equal', value: String(i) }]
  }));
  const src = source(file('collections/tc_col_a.json', 'v4-collection', v4('Big', folders, requests, { settings: { headers: [{ name: 'Accept', value: 'application/json' }], options: { baseUrl: 'https://api.example' } } })));
  const started = performance.now();
  const result = importSource(src);
  const elapsed = performance.now() - started;
  t.diagnostic(`5,000 requests: ${elapsed.toFixed(0)} ms`);
  assert.equal(result.summary.requests, 5000);
  assert.ok(elapsed < 5000, `${elapsed} ms`);
});

// keep the compiler honest about an import used only in some environments
void writeFileSync;
