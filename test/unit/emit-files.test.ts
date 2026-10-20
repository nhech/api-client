import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitHttp } from '../../src/emit';
import { renderEnvironments } from '../../src/emit/env';
import { FindingSink } from '../../src/normalize/sink';
import type { OutputFile } from '../../src';
import { parseHttp } from '../support/http-parser';
import { container, env, imp, model, variable } from '../support/ir';

const paths = (files: readonly OutputFile[]): string[] => files.map(file => file.path);
const text = (files: readonly OutputFile[], path: string): string => files.find(file => file.path === path)?.content ?? `<missing ${path}>`;

test('Layout: a folder per collection, index.http for its own requests, a file per folder, a folder per sub-folder', () => {
  const { files } = emitHttp(model([{ name: 'Shop', root: container('Shop', [imp('root one')], [
    container('Orders', [imp('list'), imp('get')], [container('Admin', [imp('purge')])]),
    container('Empty')
  ])}]));
  assert.deepEqual(paths(files), ['Shop/index.http', 'Shop/Orders.http', 'Shop/Orders/Admin.http']);
  const orders = parseHttp(text(files, 'Shop/Orders.http'));
  assert.deepEqual(orders.requests.map(r => r.name), ['list', 'get']);
  assert.equal(orders.empty, 0);
});

test('Every file ends with exactly one newline and uses \\n only', () => {
  const { files } = emitHttp(model([{ name: 'A', root: container('A', [imp('x', { docs: 'one\r\ntwo' })]) }]));
  for (const file of files) {
    assert.ok(file.content.endsWith('\n') && !file.content.endsWith('\n\n'), file.path);
    assert.ok(!file.content.includes('\r'), file.path);
  }
});

test('Names: a name that is not valid in a file name is changed and reported, a repeat gets a suffix, ignoring case', () => {
  const result = emitHttp(model([
    { name: 'A/B', root: container('A/B', [imp('x')]) },
    { name: 'a-b', root: container('a-b', [imp('y')], [container('Same', [imp('s1')]), container('same', [imp('s2')]), container('con', [imp('s3')])]) }
  ]));
  assert.deepEqual(paths(result.files), ['A-B/index.http', 'a-b-2/index.http', 'a-b-2/Same.http', 'a-b-2/same-2.http', 'a-b-2/con_.http']);
  assert.deepEqual(result.findings.map(f => `${f.code}@${f.where}`), [
    'TC-NAME-SANITIZED@A/B', 'TC-NAME-COLLISION@a-b', 'TC-NAME-COLLISION@a-b / same', 'TC-NAME-SANITIZED@a-b / con'
  ]);
});

test('A collection cannot take the name of a file the importer writes, and a folder cannot take index or _bodies', () => {
  const result = emitHttp(model([
    { name: 'IMPORT_REPORT.md', root: container('x', [imp('a')]) },
    { name: 'c', root: container('c', [imp('b')], [container('index', [imp('i')]), container('_bodies', [imp('j')]), container('Index.http', [imp('k')])]) }
  ]));
  assert.deepEqual(paths(result.files), ['IMPORT_REPORT.md-2/index.http', 'c/index.http', 'c/index-2.http', 'c/_bodies-2.http', 'c/Index.http-2.http']);
});

test('Request names are unique inside a file, whatever their case', () => {
  const { files } = emitHttp(model([{ name: 'C', root: container('C', [imp('Get user'), imp('get_user'), imp('Get-user')]) }]));
  assert.deepEqual(parseHttp(text(files, 'C/index.http')).requests.map(r => r.name), ['Get_user', 'get_user_2', 'Get_user_3']);
});

test('Docs of a folder open its file as comments; a folder with docs and no request still gets a file', () => {
  const { files } = emitHttp(model([{ name: 'C', root: container('C', [imp('a')], [container('Notes', [], [], 'Read me\n@name nope')], 'About C') }]));
  const index = parseHttp(text(files, 'C/index.http'));
  assert.deepEqual(index.preamble, ['# About C']);
  const notes = parseHttp(text(files, 'C/Notes.http'));
  assert.deepEqual(notes.preamble, ['# Read me', '# - @name nope']);
  assert.equal(notes.requests.length, 0);
});

test('A body with a ### line is a separate file, read from the right relative path at every depth', () => {
  const body = { kind: 'text', contentType: 'text/plain', text: 'a\n### b' } as const;
  const { files, externalBodies, findings } = emitHttp(model([{ name: 'C', root: container('C', [imp('top', { method: 'POST', body })], [container('F', [imp('mid', { method: 'POST', body })], [container('G', [imp('deep', { method: 'POST', body })])])]) }]));
  assert.equal(externalBodies, 3);
  assert.deepEqual(paths(files).filter(path => path.includes('_bodies')), ['C/_bodies/body-0001.txt', 'C/_bodies/body-0002.txt', 'C/_bodies/body-0003.txt']);
  assert.deepEqual(parseHttp(text(files, 'C/index.http')).requests.map(r => r.bodyFile), ['./_bodies/body-0001.txt']);
  assert.deepEqual(parseHttp(text(files, 'C/F.http')).requests.map(r => r.bodyFile), ['./_bodies/body-0002.txt']);
  assert.deepEqual(parseHttp(text(files, 'C/F/G.http')).requests.map(r => r.bodyFile), ['../_bodies/body-0003.txt']);
  assert.equal(text(files, 'C/_bodies/body-0001.txt'), 'a\n### b');
  assert.deepEqual(findings.map(f => `${f.code}@${f.where}`), ['TC-BODY-EXTERNAL@C / top', 'TC-BODY-EXTERNAL@C / F / mid', 'TC-BODY-EXTERNAL@C / F / G / deep']);
});

test('The output is the same for the same model, byte for byte', () => {
  const build = () => model([{ name: 'C', root: container('C', [imp('a', { headers: [{ name: 'X', value: '1', enabled: true, secret: false }] })], [container('F', [imp('b')])]) }], [env('dev', [variable('base', 'http://x')])]);
  assert.deepEqual(emitHttp(build()).files, emitHttp(build()).files);
});

test('The output limit stops the import cleanly: a prefix of the requests, the environments kept, TC-TOO-LARGE reported', () => {
  const requests = Array.from({ length: 50 }, (_, i) => imp(`r${i}`, { method: 'POST', body: { kind: 'text', contentType: 'text/plain', text: 'x'.repeat(200) } }));
  const result = emitHttp(model([{ name: 'C', root: container('C', requests) }], [env('dev', [variable('a', '1')])]), { maxOutputBytes: 3000 });
  assert.equal(result.truncated, true);
  assert.ok(result.requests > 0 && result.requests < 50, String(result.requests));
  assert.ok(paths(result.files).includes('http-client.env.json'), 'the environment is kept');
  const parsed = parseHttp(text(result.files, 'C/index.http'));
  assert.equal(parsed.requests.length, result.requests);
  assert.deepEqual(parsed.requests.map(r => r.name), requests.slice(0, result.requests).map((_, i) => `r${i}`));
  const finding = result.findings.find(f => f.code === 'TC-TOO-LARGE');
  assert.equal(finding?.severity, 'error');
  assert.match(finding?.message ?? '', new RegExp(`${50 - result.requests} of 50 requests were not written`));
  const total = result.files.reduce((sum, file) => sum + Buffer.byteLength(file.content) + Buffer.byteLength(file.path), 0);
  assert.ok(total <= 3000 + 200, `output ${total} bytes`);
});

test('Environments: shared variables are copied into every named environment, which overrides them; private ones go to the private file', () => {
  const sink = new FindingSink();
  const { files, keys } = renderEnvironments([
    env('Shared', [variable('region', 'eu'), variable('timeout', '5')], { kind: 'shared' }),
    env('Local', [variable('machine', 'laptop')], { kind: 'private' }),
    env('prod', [variable('timeout', '30'), variable('token', 'T', { secret: true }), variable('old', '', { secret: true, needsReentry: true })], { isDefault: true }),
    env('dev', [variable('base', 'http://localhost')])
  ], sink);
  assert.deepEqual(JSON.parse(text(files, 'http-client.env.json')), {
    dev: { base: 'http://localhost', region: 'eu', timeout: '5' },
    prod: { region: 'eu', timeout: '30' }
  });
  assert.deepEqual(JSON.parse(text(files, 'http-client.private.env.json')), {
    dev: { machine: 'laptop' },
    prod: { machine: 'laptop', old: '', token: 'T' }
  });
  assert.equal(files.find(f => f.path === 'http-client.private.env.json')?.mode, 0o600);
  assert.deepEqual(keys.map(k => [k.name, k.isDefault, k.variables, k.privateVariables]), [['prod', true, 2, 3], ['dev', false, 3, 1]]);
});

test('Environments: keys are in code point order, there is a "default" when no environment has a name, and nothing at all without variables', () => {
  const sink = new FindingSink();
  const sorted = renderEnvironments([env('b', [variable('z', '1'), variable('a', '2')]), env('B', [variable('m', '3')])], sink);
  assert.deepEqual(Object.keys(JSON.parse(text(sorted.files, 'http-client.env.json')) as object), ['B', 'b']);
  assert.deepEqual(Object.keys((JSON.parse(text(sorted.files, 'http-client.env.json')) as Record<string, object>)['b'] ?? {}), ['a', 'z']);
  const onlyShared = renderEnvironments([env('S', [variable('a', '1')], { kind: 'shared' })], sink);
  assert.deepEqual(JSON.parse(text(onlyShared.files, 'http-client.env.json')), { default: { a: '1' } });
  assert.deepEqual(renderEnvironments([], sink).files, []);
  assert.equal(text(sorted.files, 'http-client.env.json').endsWith('}\n'), true);
});

test('Environments: two with the same name keep both, the second renamed and reported', () => {
  const sink = new FindingSink();
  const { files } = renderEnvironments([env('dev', [variable('a', '1')]), env('dev', [variable('a', '2')])], sink);
  assert.deepEqual(JSON.parse(text(files, 'http-client.env.json')), { dev: { a: '1' }, 'dev-2': { a: '2' } });
  assert.deepEqual(sink.findings.map(f => f.code), ['TC-NAME-COLLISION']);
});
