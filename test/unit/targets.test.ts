import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSystemVariables, thunderRange } from '../../src/convert/sysvars';
import { DEFAULT_TARGET, TARGETS, isTarget } from '../../src/model/target';
import { importSource } from '../../src/import';
import { runCli } from '../../src/cli';
import { file, req, source, v4 } from '../support/source';
import { makeTree } from '../support/tree';

const map = (text: string, target: (typeof TARGETS)[number]) => mapSystemVariables(text, new Set<string>(), target);

test('The default tool is REST Client, and a target is one of three words', () => {
  assert.equal(DEFAULT_TARGET, 'rest-client');
  assert.deepEqual([...TARGETS], ['rest-client', 'httpyac', 'jetbrains']);
  assert.equal(isTarget('jetbrains'), true);
  assert.equal(isTarget('postman'), false);
  assert.equal(isTarget(undefined), false);
});

test('Each tool gets the spelling it reads (tried for real in REST Client 0.25.1, httpYac 6.16.7 and JetBrains ijhttp 263.7031)', () => {
  const text = '{{#guid}} {{#number, 1, 9}} {{#dateISO}}';
  assert.equal(map(text, 'rest-client'), '{{$guid}} {{$randomInt 1 10}} {{$datetime iso8601}}');
  assert.equal(map(text, 'httpyac'), '{{$guid}} {{$randomInt 1 10}} {{$datetime iso8601}}');
  assert.equal(map(text, 'jetbrains'), '{{$uuid}} {{$random.integer(1, 10)}} {{$isoTimestamp}}');
});

test('#date is milliseconds in Thunder: only httpYac has a variable with milliseconds, so only httpYac gets one', () => {
  assert.equal(map('{{#date}}', 'httpyac'), '{{$timestamp}}');
  for (const target of ['rest-client', 'jetbrains'] as const) assert.equal(map('{{#date}}', target), '{{#date}}', target);
});

test('The number is Thunder\'s own: from a to b with both ends, written as b + 1 because the tools stop before the upper bound', () => {
  assert.deepEqual(thunderRange([]), { min: 1, max: 1_000_000 });
  assert.deepEqual(thunderRange(['5']), { min: 5, max: 1_000_000 });
  assert.deepEqual(thunderRange([' 2 ', ' 4 ']), { min: 2, max: 4 });
  assert.deepEqual(thunderRange(['-5', '5']), { min: -5, max: 5 });
  // What Thunder 3.0.0 does with a start at or above 990,000 (it takes 1) and an end above 1,000,000 (it takes 1,000,000).
  assert.deepEqual(thunderRange(['990000', '2000000']), { min: 1, max: 1_000_000 });
  assert.deepEqual(thunderRange(['', '10']), { min: 1, max: 10 });
  for (const bad of [['x'], ['1', 'y'], ['1', '2', '3'], ['9', '3'], ['1.5', '2'], ['1e3', '5']]) assert.equal(thunderRange(bad), undefined, JSON.stringify(bad));
  assert.equal(map('{{#number, 1, 1}}', 'rest-client'), '{{$randomInt 1 2}}');
  assert.equal(map('{{#number, 3, 1}}', 'rest-client'), '{{#number, 3, 1}}', 'an end before the start is left alone');
});

test('What has no exact equivalent is left, listed, and the same for every tool', () => {
  for (const target of TARGETS) {
    const unmapped = new Set<string>();
    const text = '{{#email}} {{#bool}} {{#name}} {{#string}} {{#enum, a, b}} {{#guid, 1}} {{#dateISO, X}} {{#number, x}}';
    assert.equal(mapSystemVariables(text, unmapped, target), text, target);
    assert.deepEqual([...unmapped].sort(), ['bool', 'dateISO', 'email', 'enum', 'guid', 'name', 'number', 'string'], target);
  }
});

test('The whole import writes the spelling of the chosen tool, says so in the report, and defaults to REST Client', () => {
  const build = () => source(file('collections/tc_col_a.json', 'v4-collection', v4('A', [], [req('r', '', { url: '/{{#guid}}/{{#number, 1, 3}}' })])));
  const text = (target?: (typeof TARGETS)[number]) => {
    const result = importSource(build(), target === undefined ? {} : { target });
    return { http: result.files.find(f => f.path === 'A/index.http')?.content ?? '', report: result.files.find(f => f.path === 'IMPORT_REPORT.md')?.content ?? '' };
  };
  assert.match(text().http, /GET \/\{\{\$guid\}\}\/\{\{\$randomInt 1 4\}\}\n/);
  assert.equal(text().http, text('rest-client').http);
  assert.match(text('jetbrains').http, /GET \/\{\{\$uuid\}\}\/\{\{\$random\.integer\(1, 4\)\}\}\n/);
  assert.match(text('jetbrains').report, /^Written for JetBrains HTTP Client: /m);
  assert.match(text('httpyac').report, /^Written for httpYac: /m);
  assert.match(text().report, /^Written for REST Client: /m);
});

test('The report tells REST Client users that it does not read the environment file; the other two tools read it', () => {
  const build = () => source(file('collections/tc_col_a.json', 'v4-collection', v4('A', [], [req('r')])), file('environments/tc_env_dev.json', 'v4-environment', { _id: 'e', name: 'dev', data: [{ name: 'base', value: 'x' }] }));
  const report = (target: (typeof TARGETS)[number]) => importSource(build(), { target }).files.find(f => f.path === 'IMPORT_REPORT.md')?.content ?? '';
  assert.match(report('rest-client'), /REST Client does not read `http-client\.env\.json`/);
  assert.doesNotMatch(report('httpyac'), /does not read/);
  assert.doesNotMatch(report('jetbrains'), /does not read/);
});

test('CLI: --target chooses the tool, a wrong one is a usage error', async () => {
  const data = makeTree({ 'collections/tc_col_a.json': { _id: 'c', colName: 'A', folders: [], requests: [{ _id: 'r', colId: 'c', containerId: '', name: 'r', url: '/{{#guid}}', method: 'GET' }] } });
  const workspace = makeTree();
  try {
    const run = async (...args: string[]) => {
      let out = '';
      let err = '';
      const code = await runCli(args, { stdout: t => { out += t; }, stderr: t => { err += t; }, cwd: () => workspace.root });
      return { code, out, err };
    };
    const written = await run(data.root, '--target', 'jetbrains', '--write');
    assert.equal(written.code, 0);
    assert.match(written.out, /Written for JetBrains HTTP Client/);
    assert.equal((await run(data.root, '--target', 'postman')).code, 2);
    assert.equal((await run(data.root, '--target')).code, 2);
  } finally { data.cleanup(); workspace.cleanup(); }
});
