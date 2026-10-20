import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, readSource } from '../../src';
import type { SourceFile, TreeCollection } from '../../src';
import { file, folder, project, req, shape, shuffled, source, v4 } from '../support/source';
import { collection, environment, makeTree, request } from '../support/tree';

const brief = (tree: ReturnType<typeof buildTree>) => tree.findings.map(f => `${f.code}@${f.where}`);
const named = (tree: ReturnType<typeof buildTree>) => tree.collections.map(c => `${c.kind}:${c.name}`);

/** A v3 source: two collections, one with a folder, and the requests of thunderclient.json for all of them. */
function v3Files(): SourceFile[] {
  return [
    file('thunderCollection.json', 'v3-collections', [
      { _id: 'c1', colName: 'Shop', sortNum: 2, folders: [folder('f1', 'Auth')], settings: { options: { baseUrl: 'https://shop.example' } } },
      { _id: 'c2', colName: 'Blog', sortNum: 1, folders: [] }
    ]),
    file('thunderclient.json', 'v3-requests', [
      req('login', 'f1', { colId: 'c1' }), req('post', '', { colId: 'c2' }), req('cart', '', { colId: 'c1', sortNum: 1 }),
      { colId: 'history', name: 'old one' }, { colId: 'history', name: 'old two' },
      req('lost1', 'zzz', { colId: 'ghost' }), { name: 'nocol' }
    ])
  ];
}

test('N7 (v3): requests are joined to their collection by colId, the collections come in N5 order and "Unsorted" is last', () => {
  const tree = buildTree(source(...v3Files()));
  assert.deepEqual(named(tree), ['v3:Blog', 'v3:Shop', 'unsorted:Unsorted']);
  const [blog, shop, unsorted] = tree.collections as [TreeCollection, TreeCollection, TreeCollection];
  assert.deepEqual(shape(blog), { requests: ['post'], folders: [] });
  assert.deepEqual(shape(shop), { requests: ['cart'], folders: [{ name: 'Auth', requests: ['login'], folders: [] }] });
  assert.deepEqual(shape(unsorted), { requests: ['lost1', 'nocol'], folders: [] });
  assert.deepEqual(shop.settings, { options: { baseUrl: 'https://shop.example' } });
  assert.deepEqual([shop.id, shop.origin, unsorted.id, unsorted.origin], ['c1', 'thunderCollection.json', '', '']);
});

test('N7 (v3): history entries are dropped and counted once per file; requests with no collection are reported, but not for their folder', () => {
  const tree = buildTree(source(...v3Files()));
  assert.deepEqual(brief(tree), ['TC-HISTORY-SKIPPED@thunderclient.json', 'TC-ORPHAN-REQUEST@Unsorted / lost1', 'TC-ORPHAN-REQUEST@Unsorted / nocol']);
  assert.equal(tree.findings[0]?.severity, 'info');
  assert.equal(tree.findings[0]?.message, '2 history entries were skipped.');
  assert.ok(!brief(tree).some(f => f.includes('missing folder')), 'the containerId of an unsorted request points nowhere and is not a second error');
});

test('N7 (v3): one history entry is said in the singular, and a collection with no orphans makes no "Unsorted"', () => {
  const tree = buildTree(source(
    file('thunderCollection.json', 'v3-collections', [{ _id: 'c', colName: 'Only', folders: [] }]),
    file('thunderclient.json', 'v3-requests', [req('a', '', { colId: 'c' }), { colId: 'history' }])
  ));
  assert.deepEqual(named(tree), ['v3:Only']);
  assert.equal(tree.findings[0]?.message, '1 history entry was skipped.');
});

test('N7 (v3): a colId shared by two collections belongs to the first of them in N5 order', () => {
  const tree = buildTree(source(
    file('thunderCollection.json', 'v3-collections', [{ _id: 'dup', colName: 'Second', sortNum: 2, folders: [] }, { _id: 'dup', colName: 'First', sortNum: 1, folders: [] }]),
    file('thunderclient.json', 'v3-requests', [req('r', '', { colId: 'dup' })])
  ));
  assert.deepEqual(tree.collections.map(c => [c.name, c.requests.length]), [['First', 1], ['Second', 0]]);
});

test('N7: a v4 file owns its requests whatever their colId says; history entries inside it are dropped too', () => {
  const tree = buildTree(source(file('collections/tc_col_shop.json', 'v4-collection', v4('Shop', [], [req('a', '', { colId: 'other' }), req('b'), { colId: 'history', name: 'old' }], { settings: { auth: { type: 'none' } } }))));
  const [shop] = tree.collections as [TreeCollection];
  assert.deepEqual([shop.kind, shop.id, shop.name, shop.origin], ['v4', 'col-Shop', 'Shop', 'collections/tc_col_shop.json']);
  assert.deepEqual(shape(shop).requests, ['a', 'b']);
  assert.deepEqual(shop.settings, { auth: { type: 'none' } });
  assert.deepEqual(brief(tree), ['TC-HISTORY-SKIPPED@collections/tc_col_shop.json']);
});

test('N7: an export file is a collection of its own, named by collectionName, with an id made from its file', () => {
  const tree = buildTree(source(file('thunder-collection_Shop.json', 'export-collection', { client: 'Thunder Client', collectionName: 'Shop', version: '1.1', folders: [folder('f1', 'Auth')], requests: [req('login', 'f1', { colId: 'whatever' })] })));
  const [shop] = tree.collections as [TreeCollection];
  assert.deepEqual([shop.kind, shop.id, shop.name, shop.settings], ['export', 'export:thunder-collection_Shop.json', 'Shop', undefined]);
  assert.deepEqual(shape(shop), { requests: [], folders: [{ name: 'Auth', requests: ['login'], folders: [] }] });
});

test('N5 across kinds: collections by sortNum, created, name; the unnamed and the missing first by their own keys', () => {
  const tree = buildTree(source(
    file('collections/tc_col_z.json', 'v4-collection', v4('Zeta', [], [], { sortNum: 5 })),
    file('thunder-collection_Alpha.json', 'export-collection', { collectionName: 'Alpha', requests: [] }),
    file('thunderCollection.json', 'v3-collections', [{ _id: 'c', colName: 'Beta', sortNum: -1, folders: [] }]),
    file('thunderclient.json', 'v3-requests', [req('orphan', '', { colId: 'nobody' })])
  ));
  assert.deepEqual(named(tree), ['v3:Beta', 'export:Alpha', 'v4:Zeta', 'unsorted:Unsorted']);
});

test('N5: environments of every kind come in order, ties by origin', () => {
  const tree = buildTree(source(
    file('environments/tc_env_b.json', 'v4-environment', { _id: 'e2', name: 'b', sortNum: 2, data: [] }),
    file('thunder-environment_Dev.json', 'export-environment', { environmentName: 'Dev', variables: [] }),
    file('thunderEnvironment.json', 'v3-environments', [{ name: 'x', sortNum: -1, data: [] }, { name: 'y', data: [] }, 'not an object']),
    file('environments/tc_env_a.json', 'v4-environment', { _id: 'e1', name: 'same', data: [] }),
    file('environments/tc_env_c.json', 'v4-environment', { _id: 'e1', name: 'same', data: [] })
  ));
  assert.deepEqual(project(tree).environments, [
    'v3:thunderEnvironment.json:x', // sortNum -1
    'export:thunder-environment_Dev.json:Dev', // sortNum 0, then by name: D, s, y
    'v4:environments/tc_env_a.json:same',
    'v4:environments/tc_env_c.json:same', // the same keys: by origin
    'v3:thunderEnvironment.json:y',
    'v4:environments/tc_env_b.json:b' // sortNum 2
  ]);
});

test('Wrong types in the data are read as empty, never as a failure', () => {
  const tree = buildTree(source(
    file('collections/tc_col_a.json', 'v4-collection', { colName: 'A', folders: 'not a list', requests: [] }),
    file('thunderCollection.json', 'v3-collections', [5, null, 'x', { _id: 7, colName: 12, folders: {} }]),
    file('thunderclient.json', 'v3-requests', ['x', 3, null, { name: 'only valid one', colId: 'nobody' }]),
    file('environments/tc_env_a.json', 'v4-environment', 'not an object')
  ));
  assert.deepEqual(tree.collections.map(c => c.name), ['', 'A', 'Unsorted']);
  assert.deepEqual(tree.environments, []);
});

test('The same tree whatever order the files, the arrays inside them and the entries came in', () => {
  const files: SourceFile[] = [
    ...v3Files(),
    file('collections/tc_col_shop.json', 'v4-collection', v4('Shop v4', [folder('a', 'A', '', { sortNum: 1 }), folder('b', 'B', 'a'), folder('c', 'C', 'b'), folder('x', 'X', 'y'), folder('y', 'Y', 'x')], [req('r1', 'a'), req('r2', 'c'), req('r3', 'gone'), { colId: 'history' }])),
    file('thunder-collection_Export.json', 'export-collection', { collectionName: 'Export', folders: [], requests: [req('e1'), req('e2')] }),
    file('environments/tc_env_dev.json', 'v4-environment', { name: 'dev', data: [] }),
    file('thunderEnvironment.json', 'v3-environments', [{ name: 'p' }, { name: 'q', sortNum: -3 }])
  ];
  const expected = project(buildTree(source(...files), { maxFolderDepth: 2 }));
  assert.ok(expected.findings.length >= 6);
  const mix = (items: unknown[], seed: number): unknown[] => shuffled(items, seed);
  for (let seed = 1; seed <= 50; seed++) {
    const reordered = shuffled(files, seed).map(f => ({ ...f, json: Array.isArray(f.json) ? mix(f.json, seed + 1) : f.json }));
    assert.deepEqual(project(buildTree(source(...reordered), { maxFolderDepth: 2 })), expected, `seed ${seed}`);
  }
});

test('The source is not changed', () => {
  const input = source(...v3Files(), file('collections/tc_col_a.json', 'v4-collection', v4('A', [folder('f', 'F', 'f')], [req('r', 'nope')])));
  const copy = structuredClone(input);
  buildTree(input);
  assert.deepEqual(input, copy);
});

test('From a folder on disk to the tree: reader and normaliser together', async t => {
  const tree = makeTree({
    'thunderCollection.json': [{ _id: 'c1', colName: 'Shop', sortNum: 1, folders: [folder('f1', 'Auth')] }],
    'thunderclient.json': [request('c1', 'cart'), { ...request('c1', 'login'), containerId: 'f1' }, { ...request('history', 'old') }],
    'thunderEnvironment.json': [{ _id: 'e1', name: 'dev', data: [] }]
  });
  t.after(() => tree.cleanup());
  const result = buildTree(await readSource(tree.root));
  assert.deepEqual(project(result).collections.map(c => ({ name: c.name, requests: c.requests, folders: c.folders })), [{ name: 'Shop', requests: ['cart'], folders: [{ name: 'Auth', requests: ['login'], folders: [] }] }]);
  assert.deepEqual(project(result).environments, ['v3:thunderEnvironment.json:dev']);
  assert.deepEqual(brief(result), ['TC-HISTORY-SKIPPED@thunderclient.json']);
});

test('From a v4 folder on disk: one collection per file, environments from their own folder', async t => {
  const tree = makeTree({ 'collections/tc_col_a.json': collection('A', [request('c', 'one')]), 'collections/tc_col_b.json': collection('B'), 'environments/tc_env_dev.json': environment('dev') });
  t.after(() => tree.cleanup());
  const result = buildTree(await readSource(tree.root));
  assert.deepEqual(named(result), ['v4:A', 'v4:B']);
  assert.deepEqual(result.collections[0]?.requests.map(r => r.request.name), ['one']);
  assert.deepEqual(result.findings, []);
});
