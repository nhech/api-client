import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestorFolders, buildTree, flattenRequests } from '../../src';
import type { TreeCollection } from '../../src';
import { file, folder, project, req, shape, shuffled, source, v4 } from '../support/source';

/** Invisible and direction-changing characters are built from numbers: they must not appear in this source either. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/** One v4 collection called "Shop" through the whole normaliser. */
function tree(folders: object[], requests: object[], options?: { maxFolderDepth: number }) {
  const result = buildTree(source(file('collections/tc_col_shop.json', 'v4-collection', v4('Shop', folders, requests))), options);
  const collection = result.collections[0] as TreeCollection;
  return { collection, findings: result.findings.map(f => `${f.code}@${f.where}`), all: result.findings };
}

test('N6: folders and requests are placed by containerId, each level in N5 order', () => {
  const { collection, findings } = tree(
    [folder('f2', 'Orders', '', { sortNum: 20000 }), folder('f1', 'Auth', '', { sortNum: 10000 }), folder('f3', 'Admin', 'f2'), folder('f4', 'Login', 'f1')],
    [req('top-b', '', { sortNum: 2 }), req('top-a', '', { sortNum: 1 }), req('in-orders', 'f2'), req('in-admin', 'f3'), req('in-login', 'f4')]
  );
  assert.deepEqual(shape(collection), {
    requests: ['top-a', 'top-b'],
    folders: [
      { name: 'Auth', requests: [], folders: [{ name: 'Login', requests: ['in-login'], folders: [] }] },
      { name: 'Orders', requests: ['in-orders'], folders: [{ name: 'Admin', requests: ['in-admin'], folders: [] }] }
    ]
  });
  assert.deepEqual(findings, []);
});

test('N6: an empty, missing or non-text containerId is the top of the collection, without a finding', () => {
  const { collection, findings } = tree([folder('f1', 'A', ''), { _id: 'f2', name: 'B' }, { _id: 'f3', name: 'C', containerId: 5 }], [req('one', ''), { name: 'two' }, req('three', undefined), { name: 'four', containerId: 7 }]);
  assert.deepEqual(shape(collection).folders.map(f => f.name), ['A', 'B', 'C']);
  assert.equal(shape(collection).requests.length, 4);
  assert.deepEqual(findings, []);
});

test('N6: a folder whose parent does not exist moves to the top with its children, and the report says so', () => {
  const { collection, findings } = tree([folder('f1', 'Lost', 'gone'), folder('f2', 'Child', 'f1')], [req('inside', 'f2')]);
  assert.deepEqual(shape(collection), { requests: [], folders: [{ name: 'Lost', requests: [], folders: [{ name: 'Child', requests: ['inside'], folders: [] }] }] });
  assert.deepEqual(findings, ['TC-ORPHAN-FOLDER@Shop / Lost']);
});

test('N6: a request whose folder does not exist moves to the top of the collection', () => {
  const { collection, findings } = tree([folder('f1', 'Real')], [req('ok', 'f1'), req('lost', 'nowhere')]);
  assert.deepEqual(shape(collection), { requests: ['lost'], folders: [{ name: 'Real', requests: ['ok'], folders: [] }] });
  assert.deepEqual(findings, ['TC-ORPHAN-REQUEST@Shop / lost']);
});

test('N6: a folder that is its own parent is cut and placed at the top', () => {
  const { collection, findings } = tree([folder('f1', 'Loop', 'f1')], [req('r', 'f1')]);
  assert.deepEqual(shape(collection), { requests: [], folders: [{ name: 'Loop', requests: ['r'], folders: [] }] });
  assert.deepEqual(findings, ['TC-CYCLE@Shop / Loop']);
});

test('N6: a cycle is cut at its first folder in N5 order, wherever the data lists it', () => {
  const folders = [folder('b', 'B', 'a', { sortNum: 20 }), folder('a', 'A', 'b', { sortNum: 10 })];
  for (const order of [folders, [...folders].reverse()]) {
    const { collection, findings } = tree(order, [req('r', 'b')]);
    assert.deepEqual(shape(collection), { requests: [], folders: [{ name: 'A', requests: [], folders: [{ name: 'B', requests: ['r'], folders: [] }] }] });
    assert.deepEqual(findings, ['TC-CYCLE@Shop / A']);
  }
});

test('N6: folders that lead into a cycle keep their place, and two cycles are two findings', () => {
  const { collection, findings } = tree([
    folder('a', 'A', 'c', { sortNum: 1 }), folder('b', 'B', 'a', { sortNum: 2 }), folder('c', 'C', 'b', { sortNum: 3 }),
    folder('tail', 'Tail', 'c', { sortNum: 4 }),
    folder('x', 'X', 'y', { sortNum: 5 }), folder('y', 'Y', 'x', { sortNum: 6 })
  ], []);
  assert.deepEqual(shape(collection).folders.map(f => f.name), ['A', 'X']);
  assert.deepEqual(shape(collection).folders[0], { name: 'A', requests: [], folders: [{ name: 'B', requests: [], folders: [{ name: 'C', requests: [], folders: [{ name: 'Tail', requests: [], folders: [] }] }] }] });
  assert.deepEqual(findings, ['TC-CYCLE@Shop / A', 'TC-CYCLE@Shop / X']);
});

test('N6: an id used by two folders belongs to the first in N5 order; the other stays where it is, childless', () => {
  const { collection } = tree([folder('dup', 'First', '', { sortNum: 1 }), folder('dup', 'Second', '', { sortNum: 2 }), folder('kid', 'Kid', 'dup')], [req('r', 'dup')]);
  assert.deepEqual(shape(collection), {
    requests: [],
    folders: [{ name: 'First', requests: ['r'], folders: [{ name: 'Kid', requests: [], folders: [] }] }, { name: 'Second', requests: [], folders: [] }]
  });
});

test('N6: a folder without an _id is kept, and nothing can point at it', () => {
  const { collection, findings } = tree([{ name: 'No id' }, folder('', 'Empty id'), folder('x', 'Child of nothing', '')], [req('r', '')]);
  assert.deepEqual(shape(collection).folders.map(f => f.name), ['Child of nothing', 'Empty id', 'No id']);
  assert.deepEqual(findings, []);
});

test('N6: entries that are not objects are ignored', () => {
  const result = buildTree(source(file('collections/tc_col_a.json', 'v4-collection', { colName: 'A', folders: ['x', 3, null, [], folder('f', 'Real')], requests: [null, 'y', req('ok', 'f')] })));
  assert.deepEqual(shape(result.collections[0] as TreeCollection), { requests: [], folders: [{ name: 'Real', requests: ['ok'], folders: [] }] });
});

test('N6: folders deeper than the limit are merged into their ancestor, and requests keep the whole chain of ancestors', () => {
  const { collection, findings, all } = tree(
    [folder('f1', 'L1', '', { settings: { auth: { type: 'bearer' } } }), folder('f2', 'L2', 'f1'), folder('f3', 'L3', 'f2', { settings: { headers: [{ name: 'X-Deep', value: '1' }] } }), folder('f4', 'L4', 'f3')],
    [req('in-l3', 'f3'), req('in-l4', 'f4'), req('in-l2', 'f2')],
    { maxFolderDepth: 2 }
  );
  assert.deepEqual(shape(collection), { requests: [], folders: [{ name: 'L1', requests: [], folders: [{ name: 'L2', requests: ['in-l2', 'in-l3', 'in-l4'], folders: [] }] }] });
  assert.deepEqual(findings, ['TC-DEPTH@Shop']);
  assert.match(all[0]?.message ?? '', /^2 folders nested deeper than 2 levels/);
  const deep = flattenRequests(collection).find(r => r.request.name === 'in-l4');
  assert.deepEqual(ancestorFolders(deep?.ancestry).map(f => f.name), ['L4', 'L3', 'L2', 'L1'], 'nearest first, merged folders included');
  assert.deepEqual(ancestorFolders(deep?.ancestry).map(f => (f.settings ? Object.keys(f.settings) : [])), [[], ['headers'], [], ['auth']]);
});

test('N6: a folder exactly at the limit stays, and with a limit of 1 every request lands in a top-level folder', () => {
  const folders = [folder('a', 'A'), folder('b', 'B', 'a'), folder('c', 'C', 'b')];
  assert.deepEqual(shape(tree(folders, [req('r', 'c')], { maxFolderDepth: 3 }).collection).folders[0]?.folders[0]?.folders[0]?.requests, ['r']);
  assert.deepEqual(shape(tree(folders, [req('r', 'c')], { maxFolderDepth: 1 }).collection), { requests: [], folders: [{ name: 'A', requests: ['r'], folders: [] }] });
});

test('N6: ancestry of a request outside any folder is empty', () => {
  const { collection } = tree([folder('f', 'F')], [req('top')]);
  assert.deepEqual(ancestorFolders(collection.requests[0]?.ancestry), []);
});

test('N6: a chain of 100,000 folders costs time and memory in proportion, and nothing overflows', () => {
  const count = 100_000;
  const folders = Array.from({ length: count }, (_, i) => folder(`f${i}`, `F${String(i).padStart(6, '0')}`, i === 0 ? '' : `f${i - 1}`, { sortNum: i }));
  const started = Date.now();
  const { collection, findings } = tree(folders, [req('deepest', `f${count - 1}`)]);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.deepEqual(findings, ['TC-DEPTH@Shop']);
  const only = flattenRequests(collection);
  assert.equal(only.length, 1);
  let depth = 0;
  for (let link = only[0]?.ancestry; link !== undefined; link = link.up) depth++;
  assert.equal(depth, count);
});

test('N6: a cycle of 100,000 folders is cut once, quickly', () => {
  const count = 100_000;
  const folders = Array.from({ length: count }, (_, i) => folder(`f${i}`, `F${String(i).padStart(6, '0')}`, `f${(i + 1) % count}`, { sortNum: i }));
  const started = Date.now();
  const { findings } = tree(folders, []);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.equal(findings.filter(f => f.startsWith('TC-CYCLE')).length, 1);
});

test('N6: the report keeps the first 20 findings of a kind in a collection and counts the rest', () => {
  const requests = Array.from({ length: 25 }, (_, i) => req(`r${String(i).padStart(2, '0')}`, 'missing'));
  const { all } = tree([], shuffled(requests, 7));
  assert.equal(all.length, 21);
  assert.deepEqual(all.slice(0, 20).map(f => f.where), Array.from({ length: 20 }, (_, i) => `Shop / r${String(i).padStart(2, '0')}`), 'the same 20 whatever the input order');
  assert.deepEqual([all[20]?.code, all[20]?.where, all[20]?.message], ['TC-ORPHAN-REQUEST', 'Shop', '5 more like the ones above were found here.']);
});

test('N6: a name with hidden characters is shown with them made visible, and a missing name has a placeholder', () => {
  const result = buildTree(source(file('collections/tc_col_a.json', 'v4-collection', v4('A' + cp(0x202e) + 'B', [{ _id: 'x', containerId: 'gone' }], []))));
  assert.deepEqual(result.findings.map(f => f.where), ['A?B / <unnamed>']);
});

test('N6: the same tree whatever order the folders and requests were listed in', () => {
  const folders = [folder('a', 'A', '', { sortNum: 1 }), folder('b', 'B', 'a', { sortNum: 2 }), folder('c', 'C', 'b', { sortNum: 1 }), folder('d', 'D', 'c', { sortNum: 1 }),
    folder('lost', 'Lost', 'gone'), folder('x', 'X', 'y', { sortNum: 3 }), folder('y', 'Y', 'x', { sortNum: 4 }), folder('dup', 'Dup1', '', { sortNum: 9 }), folder('dup', 'Dup2', '', { sortNum: 9, created: 'later' })];
  const requests = [req('r1', 'a'), req('r2', 'a', { sortNum: 5 }), req('r3', 'd'), req('r4', 'x'), req('r5', 'gone'), req('r6', 'dup'), req('r7', ''), req('r8', 'lost')];
  const expected = project(buildTree(source(file('collections/tc_col_a.json', 'v4-collection', v4('A', folders, requests))), { maxFolderDepth: 3 }));
  assert.ok(expected.findings.length >= 4, 'the sample exercises orphans, cycles and depth');
  for (let seed = 1; seed <= 60; seed++) {
    const result = project(buildTree(source(file('collections/tc_col_a.json', 'v4-collection', v4('A', shuffled(folders, seed), shuffled(requests, seed + 1000)))), { maxFolderDepth: 3 }));
    assert.deepEqual(result, expected, `seed ${seed}`);
  }
});
