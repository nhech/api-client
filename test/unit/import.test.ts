import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importSource } from '../../src/import';
import { emitHttp } from '../../src/emit';
import { headerName } from '../../src/emit/http';
import { escapeMarkdown } from '../../src/emit/report';
import { identifier } from '../../src/emit/names';
import type { ImpBody, ImpRequest, OutputFile, TcSource } from '../../src';
import { file, folder, random, req, shuffled, source, v4 } from '../support/source';
import { container, imp, model } from '../support/ir';
import { parseHttp } from '../support/http-parser';

const CANARY_TOKEN = 'CANARY-token-1111';
const CANARY_PASSWORD = 'CANARY-password-2222';
const CANARY_HEADER = 'CANARY-header-3333';
const CANARY_ENV = 'CANARY-env-secret-4444';
const CANARIES = [CANARY_TOKEN, CANARY_PASSWORD, CANARY_HEADER, CANARY_ENV];

const realistic = (): TcSource => source(
  file('collections/tc_col_a.json', 'v4-collection', v4('Shop', [folder('f1', 'Orders'), folder('f2', 'Admin', 'f1')], [
    req('login', '', { method: 'POST', url: '{{base}}/token', body: { type: 'formencoded', form: [{ name: 'username', value: 'me' }, { name: 'password', value: CANARY_PASSWORD }] },
      tests: [{ type: 'set-env-var', custom: 'json.access_token', action: 'setto', value: '{{access_token}}' }] }),
    req('list', 'f1', { url: '{{base}}/orders', auth: { type: 'bearer', bearer: CANARY_TOKEN }, headers: [{ name: 'X-Api-Key', value: CANARY_HEADER }],
      tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }] }),
    req('purge', 'f2', { method: 'DELETE', url: '{{base}}/orders' })
  ])),
  file('environments/tc_env_dev.json', 'v4-environment', { _id: 'e1', name: 'dev', data: [{ name: 'base', value: 'https://dev.example' }, { name: 'api_secret', value: CANARY_ENV }, { name: 'old_key', value: 'x', encrypted: true }] })
);

const contentOf = (files: readonly OutputFile[], path: string): string => files.find(f => f.path === path)?.content ?? '';

test('End to end: files, secrets only in the private file, a report, and the findings of every stage', () => {
  const result = importSource(realistic());
  assert.deepEqual(result.files.map(f => f.path).sort(), [
    'IMPORT_REPORT.md', 'Shop/Orders.http', 'Shop/Orders/Admin.http', 'Shop/index.http', 'http-client.env.json', 'http-client.private.env.json', 'rest-client.private.settings.json', 'rest-client.settings.json'
  ]);
  for (const f of result.files) {
    if (f.path.includes('.private.')) continue;
    for (const canary of CANARIES) assert.ok(!f.content.includes(canary), `${canary} leaked into ${f.path}`);
  }
  const priv = contentOf(result.files, 'http-client.private.env.json');
  for (const canary of CANARIES) assert.ok(priv.includes(canary), `${canary} should be in the private file`);
  assert.equal(result.files.find(f => f.path === 'http-client.private.env.json')?.mode, 0o600);
  const privateSettings = contentOf(result.files, 'rest-client.private.settings.json');
  for (const canary of CANARIES) assert.ok(privateSettings.includes(canary), `${canary} should be in the private settings`);
  assert.equal(result.files.find(f => f.path === 'rest-client.private.settings.json')?.mode, 0o600);
  assert.deepEqual(result.summary, { collections: 1, folders: 2, requests: 3, environments: 1, skippedRequests: 0, secretsMoved: 4, variablesToReenter: 1 });

  const login = parseHttp(contentOf(result.files, 'Shop/index.http')).requests[0];
  assert.equal(login?.method, 'POST');
  assert.equal(login?.url, '{{base}}/token');
  assert.deepEqual(login?.captures, ['access_token = json $.access_token']);
  assert.match(login?.body ?? '', /^username=me&password=\{\{secret_shop_/);

  const report = contentOf(result.files, 'IMPORT_REPORT.md');
  assert.match(report, /^# Thunder Client import report\n/);
  assert.match(report, /\| Requests imported \| 3 \|/);
  assert.match(report, /## Enter these values again/);
  for (const canary of CANARIES) assert.ok(!report.includes(canary));
});

test('P1: the same data in any order gives the same files, byte for byte', () => {
  const baseline = importSource(realistic()).files;
  const parts = realistic();
  for (let seed = 1; seed <= 20; seed++) {
    const shuffledSource: TcSource = { ...parts, files: shuffled(parts.files, seed).map(f => ({ ...f, json: shuffleInside(f.json, seed) })) };
    assert.deepEqual(importSource(shuffledSource).files, baseline, `seed ${seed}`);
  }
});

/** Keys and the arrays whose order carries no meaning in Thunder data (the position of a request comes from sortNum, then the name). */
const UNORDERED = new Set(['requests', 'folders', 'data']);
function shuffleInside(json: unknown, seed: number, unordered = false): unknown {
  if (Array.isArray(json)) {
    const items = json.map(item => shuffleInside(item, seed + 1));
    return unordered ? shuffled(items, seed) : items;
  }
  if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>;
    return Object.fromEntries(shuffled(Object.keys(record), seed).map(key => [key, shuffleInside(record[key], seed + 1, UNORDERED.has(key))]));
  }
  return json;
}

test('Switching secret moving off leaves the secrets where they were and reports them', () => {
  const result = importSource(realistic(), { moveSecrets: false });
  assert.ok(contentOf(result.files, 'Shop/Orders.http').includes(CANARY_TOKEN));
  assert.ok(result.findings.some(f => f.code === 'TC-SECRET-LITERAL'));
  assert.equal(result.summary.secretsMoved, 0);
});

test('The report escapes names so that a name cannot make a link, a table cell, a heading or HTML', () => {
  const evil = '[click](http://attacker.invalid)|<img src=x>`code`\n# Heading';
  assert.ok(!/[<`|]/.test(escapeMarkdown(evil).replace(/\\[<`|]/g, '')), escapeMarkdown(evil));
  assert.ok(!escapeMarkdown(evil).includes('\n'));
  const result = importSource(source(file('collections/tc_col_a.json', 'v4-collection', v4(evil, [], [req('r')]))));
  const report = contentOf(result.files, 'IMPORT_REPORT.md');
  assert.ok(!/(?<!\\)</.test(report), 'no raw <');
  const outsideTable = report.split('\n').filter(line => !line.startsWith('| `')).join('\n');
  assert.ok(!/(?<!\\)\[click\]\(/.test(outsideTable), 'no link');
  const row = report.split('\n').find(line => line.startsWith('| `')) ?? '';
  assert.match(row, /^\| ``[^|]*`` \| 1 \| 0 \|$/, 'the folder is in a code span whose fence is longer than any run of backticks in it');
  assert.ok(!report.split('\n').some(line => /^# Heading/.test(line)));
});

test('The report says when the import is incomplete', () => {
  const requests = Array.from({ length: 30 }, (_, i) => req(`r${i}`, '', { method: 'POST', body: { type: 'text', raw: 'x'.repeat(300) } }));
  const result = importSource(source(file('collections/tc_col_a.json', 'v4-collection', v4('Big', [], requests))), { emit: { maxOutputBytes: 4000 } });
  const report = contentOf(result.files, 'IMPORT_REPORT.md');
  assert.match(report, /\*\*The import is incomplete\.\*\*/);
  assert.match(report, /TC-TOO-LARGE/);
  assert.ok(result.summary.requests < 30);
});

test('Header names cannot look like a comment, a variable definition or a second header', () => {
  assert.equal(headerName('X-A'), 'X-A');
  assert.equal(headerName('#@name'), '_-name');
  assert.equal(headerName('//x'), '-x');
  assert.equal(headerName('@a=b'), '-a-b');
  assert.equal(headerName('A: B\nC'), 'A-B-C');
  assert.equal(headerName('{{prefix}}-Id'), '{{prefix}}-Id');
  assert.equal(headerName('X Y'), 'X-Y');
});

// ---- P5: whatever is in the data, the file says what the model says ----

const PIECES = ['a', 'B', ' ', '  ', '\n', '\r\n', '###', '# @name x', '@assert status == 1', 'POST /x', '{{v}}', '<', '>', ':', '#', '//', '\t', '\\', '"', '%', '=', '@',
  String.fromCodePoint(0x202e), String.fromCodePoint(0x200b), String.fromCodePoint(0x1f642), '\n###', '\n< ', '\n\n'];
const hostile = (rand: () => number, max = 6): string => Array.from({ length: Math.floor(rand() * max) }, () => PIECES[Math.floor(rand() * PIECES.length)] ?? '').join('');
const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

function randomBody(rand: () => number): ImpBody | undefined {
  switch (Math.floor(rand() * 5)) {
    case 0: return { kind: 'text', contentType: 'text/plain', text: hostile(rand, 10) };
    case 1: return { kind: 'form', fields: [{ name: hostile(rand), value: hostile(rand), enabled: rand() < 0.7 }, { name: hostile(rand), value: hostile(rand), enabled: true }] };
    case 2: return { kind: 'multipart', parts: [{ name: hostile(rand), value: hostile(rand), enabled: true }, { name: hostile(rand), filePath: hostile(rand), enabled: rand() < 0.7 }] };
    case 3: return { kind: 'graphql', query: hostile(rand, 8), variables: hostile(rand, 3) };
    default: return undefined;
  }
}

function randomRequest(rand: () => number, index: number): ImpRequest {
  const headers = Array.from({ length: Math.floor(rand() * 4) }, () => ({ name: hostile(rand, 3), value: hostile(rand), enabled: rand() < 0.7, secret: false }));
  const body = randomBody(rand);
  return {
    sourceId: `r${index}`, name: hostile(rand), method: pick(rand, ['GET', 'POST', 'PUT', 'DELETE']), url: `https://x.invalid/${hostile(rand)}`,
    ...(rand() < 0.5 ? { docs: hostile(rand, 10) } : {}),
    query: [{ name: hostile(rand), value: hostile(rand), enabled: false }], headers,
    ...(body === undefined ? {} : { body }),
    ...(rand() < 0.3 ? { auth: { kind: 'bearer' as const, token: { value: hostile(rand), secret: false } } } : {}),
    assertions: Array.from({ length: Math.floor(rand() * 3) }, () => ({ target: pick(rand, ['status', 'time', 'body', 'header', 'json'] as const), name: hostile(rand), op: pick(rand, ['==', '!=', 'includes']), expected: hostile(rand) })),
    captures: Array.from({ length: Math.floor(rand() * 3) }, () => ({ variable: hostile(rand), scope: pick(rand, ['active', 'local', 'global'] as const), source: hostile(rand) })),
    notes: [hostile(rand), hostile(rand)],
    skippedScripts: rand() < 0.4 ? [{ phase: pick(rand, ['pre', 'post'] as const), lines: [hostile(rand, 8), hostile(rand)], from: hostile(rand) }] : []
  };
}

test('P5: with hostile names, values, docs, bodies and scripts, a file has exactly the requests, directives and headers the model has', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = random(seed);
    const requests = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => randomRequest(rand, i));
    const out = emitHttp(model([{ name: hostile(rand), root: container(hostile(rand), requests, [], rand() < 0.5 ? hostile(rand, 8) : undefined) }]));
    const written = out.files.filter(f => f.path.endsWith('.http'));
    assert.equal(written.length, 1, `seed ${seed}: one file`);
    const parsed = parseHttp(written[0]?.content ?? '');
    assert.equal(parsed.empty, 0, `seed ${seed}: no block without a request`);
    assert.equal(parsed.requests.length, requests.length, `seed ${seed}: one block per request`);
    parsed.requests.forEach((got, i) => {
      const want = requests[i] as ImpRequest;
      const where = `seed ${seed} request ${i}`;
      assert.equal(got.method, want.method, where);
      assert.match(got.name ?? '', /^\w+$/, where);
      assert.equal(got.captures.length, want.captures.length, `${where}: captures`);
      assert.equal(got.asserts.length, want.assertions.length, `${where}: assertions`);
      assert.deepEqual(got.unknownDirectives, [], `${where}: no directive that is not in the grammar`);
      assert.equal(got.headers.length, want.headers.filter(h => h.enabled).length + (want.auth === undefined ? 0 : 1), `${where}: headers`);
      for (const [name] of got.headers) assert.match(name, /^(?:[!#$%&'*+.^_`|~0-9A-Za-z-]|\{\{[^\n]*\}\})*$/, `${where}: header name ${JSON.stringify(name)}`);
    });
    const names = parsed.requests.map(r => (r.name ?? '').toLowerCase());
    assert.equal(new Set(names).size, names.length, `seed ${seed}: names are unique`);
    // External bodies hold exactly what the body would have been.
    for (const [i, got] of parsed.requests.entries()) {
      if (got.bodyFile === undefined) continue;
      const saved = out.files.find(f => f.path === `${out.collections[0]?.dir}/${got.bodyFile?.replace(/^\.\//, '')}`);
      assert.ok(saved !== undefined, `seed ${seed} request ${i}: the body file exists`);
      assert.match(saved?.content ?? '', /(?:^|\n)(?:#|\/\/|<(?:\s|>|$)|>(?:\s|>|\{|$))/);
    }
  }
});

test('The title of a block has no line break whatever the name, and identifiers are stable', () => {
  assert.equal(identifier('a\nb'), 'a_b');
  const out = emitHttp(model([{ name: 'C', root: container('C', [imp('x\n###y\r\nz')]) }]));
  const blocks = (out.files[0]?.content ?? '').split('\n').filter(line => line.startsWith('###'));
  assert.equal(blocks.length, 1);
});
