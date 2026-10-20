import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { readSource, SourceError } from '../../src';
import type { TcSource } from '../../src';
import { collection, environment, makeTree, request, snapshot, tryLink } from '../support/tree';
import type { Tree } from '../support/tree';

/** Invisible and direction-changing characters are built from numbers: they must not appear in this source either. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const origins = (source: TcSource) => source.files.map(file => file.origin);
const kinds = (source: TcSource) => source.files.map(file => `${file.origin}=${file.kind}`);
const brief = (source: TcSource) => source.findings.map(f => `${f.code}/${f.severity}@${f.where}`);
const using = (t: TestContext, tree: Tree) => { t.after(() => tree.cleanup()); return tree; };

test('A v4 folder gives its collections and environments, sorted, with paths relative to the folder', async t => {
  const tree = using(t, makeTree({
    'collections/tc_col_b.json': collection('b'),
    'collections/tc_col_a.json': collection('a'),
    'collections/notes.txt': 'not data',
    'collections/other.json': collection('ignored: no tc_col prefix'),
    'environments/tc_env_dev.json': environment('dev'),
    'environments/readme.md': '# not data'
  }));
  const source = await readSource(tree.root);
  assert.equal(source.layout, 'v4');
  assert.deepEqual(kinds(source), ['collections/tc_col_a.json=v4-collection', 'collections/tc_col_b.json=v4-collection', 'environments/tc_env_dev.json=v4-environment']);
  assert.deepEqual(source.findings, []);
  const text = JSON.stringify(source);
  assert.ok(!text.includes(tree.root) && !text.includes(tmpdir()), 'no absolute path in the result');
});

test('A v3 folder gives its four files; a known file may be an empty list', async t => {
  const tree = using(t, makeTree({
    'thunderCollection.json': [{ _id: 'c1', colName: 'a', folders: [] }],
    'thunderclient.json': [request('c1', 'one')],
    'thunderEnvironment.json': [],
    'thunderLocalEnvironment.json': [{ _id: 'e1', name: 'Local', global: true, local: true, data: [] }]
  }));
  const source = await readSource(tree.root);
  assert.equal(source.layout, 'v3');
  assert.deepEqual(kinds(source), ['thunderCollection.json=v3-collections', 'thunderEnvironment.json=v3-environments', 'thunderLocalEnvironment.json=v3-environments', 'thunderclient.json=v3-requests']);
  assert.deepEqual(source.findings, []);
});

test('An empty requests file is a v3 requests file, not an unknown one', async t => {
  const tree = using(t, makeTree({ 'thunderclient.json': [], 'thunderCollection.json': [] }));
  const source = await readSource(tree.root);
  assert.deepEqual(kinds(source), ['thunderCollection.json=v3-collections', 'thunderclient.json=v3-requests']);
  assert.deepEqual(source.findings, []);
});

test('When v3 and v4 files both exist, v4 wins, v3 is not read, and the report says so', async t => {
  const tree = using(t, makeTree({
    'collections/tc_col_a.json': collection('a'),
    'thunderclient.json': '{ this is not JSON',
    'thunderCollection.json': [{ colName: 'old' }],
    'thunderEnvironment.json': '{ this is not JSON either'
  }));
  const source = await readSource(tree.root);
  assert.equal(source.layout, 'v4');
  assert.deepEqual(origins(source), ['collections/tc_col_a.json']);
  assert.deepEqual(brief(source), ['TC-LAYOUT-BOTH/warn@.'], 'no parse error: the v3 files were never opened');
});

test('The private variables file is read with v4 too, as the extension itself loads it whatever the layout', async t => {
  const tree = using(t, makeTree({
    'collections/tc_col_a.json': collection('a'),
    'thunderLocalEnvironment.json': [{ _id: 'l1', name: 'Local', global: true, local: true, data: [{ name: 'k', value: 'v' }] }]
  }));
  const source = await readSource(tree.root);
  assert.equal(source.layout, 'v4');
  assert.deepEqual(kinds(source), ['collections/tc_col_a.json=v4-collection', 'thunderLocalEnvironment.json=v3-environments']);
  assert.deepEqual(source.findings, [], 'a lone v3-named file is not a second layout');
});

test('A folder with no Thunder Client data says so instead of failing', async t => {
  const tree = using(t, makeTree({ 'notes.txt': 'hello', 'src/app.json': { a: 1 } }));
  const source = await readSource(tree.root);
  assert.equal(source.layout, 'none');
  assert.deepEqual(source.files, []);
  assert.deepEqual(brief(source), ['TC-PARSE-ERROR/info@.']);
});

test('History, stored responses, attachments and upgrade backups are never opened', async t => {
  for (const base of [{ 'collections/tc_col_a.json': collection('a') }, { 'thunderclient.json': [request('c1', 'one')] }]) {
    const tree = using(t, makeTree({
      ...base,
      'thunderActivity.json': '{ not json',
      'thunderResponses.json': '{ not json',
      'files/upload.json': '{ not json',
      'res-files/stored.json': '{ not json',
      '_db-backup/tc_col_old.json': '{ not json',
      '_db-backupv3/thunderclient.json': '{ not json'
    }));
    const source = await readSource(tree.root);
    assert.equal(source.files.length, 1);
    assert.deepEqual(source.findings, [], 'nothing was opened, so nothing could fail');
  }
});

test('The content decides what a file is, not its name', async t => {
  const tree = using(t, makeTree({
    'collections/tc_col_a.json': { hello: 'world' },
    'collections/tc_col_b.json': { collectionName: 'an export put in the wrong folder', requests: [] },
    'collections/tc_col_c.json': collection('c')
  }));
  const source = await readSource(tree.root);
  assert.deepEqual(kinds(source), ['collections/tc_col_b.json=export-collection', 'collections/tc_col_c.json=v4-collection']);
  assert.deepEqual(brief(source), ['TC-PARSE-ERROR/info@collections/tc_col_a.json']);
});

test('Bad files are reported and skipped, and the good ones are still read', async t => {
  const tree = using(t, makeTree({
    'collections/tc_col_a_bad_json.json': '{ "colName": ',
    'collections/tc_col_b_empty.json': '',
    'collections/tc_col_c_bad_utf8.json': Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]),
    'collections/tc_col_d_bom.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(collection('bom')))]),
    'collections/tc_col_e_good.json': collection('good')
  }));
  const source = await readSource(tree.root);
  assert.deepEqual(origins(source), ['collections/tc_col_d_bom.json', 'collections/tc_col_e_good.json']);
  assert.deepEqual(brief(source), [
    'TC-PARSE-ERROR/warn@collections/tc_col_a_bad_json.json',
    'TC-PARSE-ERROR/warn@collections/tc_col_b_empty.json',
    'TC-PARSE-ERROR/warn@collections/tc_col_c_bad_utf8.json'
  ]);
  assert.match(source.findings[2]?.message ?? '', /UTF-8/);
  const text = JSON.stringify(source.findings);
  assert.ok(!text.includes('colName'), 'a finding never carries what was read');
});

test('A directory with a data file name is not read as a file', async t => {
  const tree = using(t, makeTree({ 'collections/tc_col_dir.json/inner.json': collection('inside'), 'collections/tc_col_a.json': collection('a') }));
  const source = await readSource(tree.root);
  assert.deepEqual(origins(source), ['collections/tc_col_a.json']);
  assert.deepEqual(source.findings, []);
});

test('Keys named like the prototype are plain data and change nothing', async t => {
  const tree = using(t, makeTree({ 'collections/tc_col_a.json': '{"colName":"a","requests":[],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}' }));
  const source = await readSource(tree.root);
  assert.equal(source.files[0]?.kind, 'v4-collection');
  const json = source.files[0]?.json as Record<string, unknown>;
  assert.equal(Object.hasOwn(json, '__proto__'), true, 'kept as an own key');
  assert.equal(Object.getPrototypeOf(json), Object.prototype);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('Over a bound, only that part is skipped, with TC-TOO-LARGE', async t => {
  const big = { _id: 'c', colName: 'big', folders: [], requests: [], padding: 'x'.repeat(300) };
  const tree = using(t, makeTree({ 'collections/tc_col_a_big.json': big, 'collections/tc_col_b_small.json': { colName: 's', requests: [] } }));
  const source = await readSource(tree.root, { limits: { maxFileBytes: 100 } });
  assert.deepEqual(origins(source), ['collections/tc_col_b_small.json']);
  assert.deepEqual(brief(source), ['TC-TOO-LARGE/error@collections/tc_col_a_big.json']);
});

test('The total size bound stops the reading once, and says so once', async t => {
  const file = (name: string) => ({ _id: name, colName: name, folders: [], requests: [], padding: 'x'.repeat(60) });
  const tree = using(t, makeTree({ 'collections/tc_col_a.json': file('a'), 'collections/tc_col_b.json': file('b'), 'collections/tc_col_c.json': file('c'), 'collections/tc_col_d.json': file('d') }));
  const one = (await readSource(tree.root)).files.length;
  assert.equal(one, 4);
  const size = JSON.stringify(file('a'), null, 2).length;
  const source = await readSource(tree.root, { limits: { maxTotalBytes: size * 2 + 5 } });
  assert.deepEqual(origins(source), ['collections/tc_col_a.json', 'collections/tc_col_b.json']);
  assert.deepEqual(brief(source), ['TC-TOO-LARGE/error@collections/tc_col_c.json']);
});

test('The file count bound stops the reading once, and says so once', async t => {
  const tree = using(t, makeTree({ 'collections/tc_col_1.json': collection('1'), 'collections/tc_col_2.json': collection('2'), 'collections/tc_col_3.json': collection('3'), 'collections/tc_col_4.json': collection('4') }));
  const source = await readSource(tree.root, { limits: { maxFiles: 2 } });
  assert.deepEqual(origins(source), ['collections/tc_col_1.json', 'collections/tc_col_2.json']);
  assert.deepEqual(brief(source), ['TC-TOO-LARGE/error@collections/tc_col_3.json']);
});

test('The request bound skips the collection that would cross it', async t => {
  const reqs = (n: number) => Array.from({ length: n }, (_, i) => request('c', `r${i}`));
  const tree = using(t, makeTree({ 'collections/tc_col_a.json': collection('a', reqs(2)), 'collections/tc_col_b.json': collection('b', reqs(2)), 'collections/tc_col_c.json': collection('c', reqs(1)) }));
  const source = await readSource(tree.root, { limits: { maxRequests: 3 } });
  assert.deepEqual(origins(source), ['collections/tc_col_a.json']);
  assert.deepEqual(brief(source), ['TC-TOO-LARGE/error@collections/tc_col_b.json'], 'reported once, the rest follows the same rule');
});

test('A file nested deeper than the bound is skipped before it is parsed', async t => {
  const tree = using(t, makeTree({ 'collections/tc_col_a_deep.json': '{"colName":"a","requests":[],"x":' + '['.repeat(500) + ']'.repeat(500) + '}', 'collections/tc_col_b.json': collection('b') }));
  const source = await readSource(tree.root, { limits: { maxJsonDepth: 10 } });
  assert.deepEqual(origins(source), ['collections/tc_col_b.json']);
  assert.deepEqual(brief(source), ['TC-TOO-LARGE/error@collections/tc_col_a_deep.json']);
});

test('A text value over the bound skips its file', async t => {
  const tree = using(t, makeTree({ 'collections/tc_col_a.json': { colName: 'a', requests: [{ body: { raw: 'x'.repeat(200) } }] }, 'collections/tc_col_b.json': collection('b') }));
  const source = await readSource(tree.root, { limits: { maxStringBytes: 100 } });
  assert.deepEqual(origins(source), ['collections/tc_col_b.json']);
  assert.deepEqual(brief(source), ['TC-TOO-LARGE/error@collections/tc_col_a.json']);
});

test('A link is never followed: not a file, not a folder', async t => {
  const outside = using(t, makeTree({ 'real.json': collection('outside'), 'stolen/tc_col_x.json': collection('stolen') }));
  const tree = using(t, makeTree({ 'collections/tc_col_a.json': collection('a'), 'environments/tc_env_dev.json': environment('dev') }));
  if (!tryLink(outside.path('real.json'), tree.path('collections/tc_col_link.json'), 'file')) return t.skip('this system does not allow file links here');
  const source = await readSource(tree.root);
  assert.deepEqual(origins(source), ['collections/tc_col_a.json', 'environments/tc_env_dev.json']);
  assert.deepEqual(brief(source), ['TC-PARSE-ERROR/info@collections/tc_col_link.json']);

  const linkedFolder = using(t, makeTree({ 'environments/tc_env_dev.json': environment('dev') }));
  if (!tryLink(outside.path('stolen'), linkedFolder.path('collections'), 'junction')) return t.skip('this system does not allow folder links here');
  const second = await readSource(linkedFolder.root);
  assert.deepEqual(second.files.map(file => file.kind), [], 'nothing from the folder the link points to');
  assert.ok(second.findings.some(f => f.where === 'collections'), 'the skipped folder is reported');
});

test('Hidden and direction-changing characters in a name are made visible in what is returned', async t => {
  const tree = using(t, makeTree({}));
  const name = 'tc_col_a' + cp(0x202e) + 'b.json';
  try { tree.write('collections/' + name, collection('a')); } catch { return t.skip('this file system does not take this name'); }
  const source = await readSource(tree.root);
  assert.deepEqual(origins(source), ['collections/tc_col_a?b.json']);
});

test('The same data gives the same result whatever order it was created in', async t => {
  const files: Record<string, object> = { 'collections/tc_col_c.json': collection('c'), 'collections/tc_col_a.json': collection('a'), 'collections/tc_col_b.json': collection('b'), 'environments/tc_env_x.json': environment('x'), 'environments/tc_env_a.json': environment('a') };
  const forward = using(t, makeTree(files));
  const backward = using(t, makeTree(Object.fromEntries(Object.entries(files).reverse())));
  assert.deepEqual(await readSource(forward.root), await readSource(backward.root));
});

test('Reading changes nothing in the folder', async t => {
  const tree = using(t, makeTree({ 'collections/tc_col_a.json': collection('a'), 'environments/tc_env_dev.json': environment('dev'), 'thunderclient.json': '{ not json', 'files/x.bin': 'data' }));
  const before = snapshot(tree.root);
  await readSource(tree.root);
  await readSource(tree.root, { limits: { maxFileBytes: 1 } });
  assert.equal(snapshot(tree.root), before);
});

test('Export files given one by one, or as a list, are read by their content and sorted', async t => {
  const tree = using(t, makeTree({
    'thunder-collection_Shop.json': { client: 'Thunder Client', collectionName: 'Shop', version: '1.1', folders: [], requests: [] },
    'thunder-environment_Dev.json': { client: 'Thunder Client', environmentName: 'Dev', version: '1.0', variables: [] },
    'anything.json': { hello: 1 },
    'broken.json': '{ no'
  }));
  const one = await readSource(tree.path('thunder-collection_Shop.json'));
  assert.equal(one.layout, 'none');
  assert.deepEqual(kinds(one), ['thunder-collection_Shop.json=export-collection']);
  const two = await readSource([tree.path('thunder-environment_Dev.json'), tree.path('thunder-collection_Shop.json')]);
  assert.deepEqual(kinds(two), ['thunder-collection_Shop.json=export-collection', 'thunder-environment_Dev.json=export-environment']);
  assert.ok(!JSON.stringify(two).includes(tree.root), 'only the file name, never the folder');
  const bad = await readSource([tree.path('anything.json'), tree.path('broken.json')]);
  assert.deepEqual(brief(bad), ['TC-PARSE-ERROR/info@anything.json', 'TC-PARSE-ERROR/warn@broken.json']);
});

test('A path that is missing, unreadable or not a file or folder is refused with a clear error', async t => {
  const tree = using(t, makeTree({ 'a.json': {} }));
  await assert.rejects(readSource(tree.path('missing')), (error: unknown) => error instanceof SourceError && error.code === 'not-found');
  await assert.rejects(readSource(tree.path('a.json/below')), (error: unknown) => error instanceof SourceError && error.code === 'not-found');
  await assert.rejects(readSource([tree.root]), (error: unknown) => error instanceof SourceError && error.code === 'not-supported');
  await assert.rejects(readSource([tree.path('missing.json')]), (error: unknown) => error instanceof SourceError && error.code === 'not-found');
});

test('An aborted import stops before it reads anything', async t => {
  const tree = using(t, makeTree({ 'collections/tc_col_a.json': collection('a') }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readSource(tree.root, { signal: controller.signal }), (error: unknown) => (error as Error).name === 'AbortError');
});
