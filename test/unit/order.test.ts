import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sortBySourceOrder } from '../../src';
import { shuffled } from '../support/source';

/** Invisible and direction-changing characters are built from numbers: they must not appear in this source either. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const names = (items: { name?: string }[]) => items.map(item => item.name);
const sorted = (items: object[]) => names(sortBySourceOrder(items) as { name?: string }[]);

test('canonicalJson gives the same text whatever the order of the keys, at any depth', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]', 'array order is data and stays');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson('x"y'), '"x\\"y"');
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: '1' }));
});

test('canonicalJson keeps a __proto__ key as an ordinary key', () => {
  const parsed: unknown = JSON.parse('{"b":1,"__proto__":{"x":1},"a":2}');
  assert.equal(canonicalJson(parsed), '{"__proto__":{"x":1},"a":2,"b":1}');
});

test('N5: ascending sortNum, negative and fractional numbers included', () => {
  assert.deepEqual(sorted([{ name: 'c', sortNum: 30000 }, { name: 'a', sortNum: -2 }, { name: 'b', sortNum: 0.5 }, { name: 'd', sortNum: 1 }]), ['a', 'b', 'd', 'c']);
});

test('N5: a missing sortNum, or one that is not a finite number, counts as 0', () => {
  const items = [{ name: 'neg', sortNum: -1 }, { name: 'text', sortNum: '5' }, { name: 'none' }, { name: 'null', sortNum: null }, { name: 'inf', sortNum: Infinity }, { name: 'nan', sortNum: NaN }, { name: 'pos', sortNum: 1 }];
  const result = sorted(items);
  assert.equal(result[0], 'neg');
  assert.equal(result.at(-1), 'pos');
  assert.deepEqual(new Set(result.slice(1, 6)), new Set(['text', 'none', 'null', 'inf', 'nan']));
});

test('N5: a tie on sortNum goes to created, a missing created first', () => {
  assert.deepEqual(sorted([{ name: 'late', sortNum: 1, created: '2026-03-01T00:00:00.000Z' }, { name: 'early', sortNum: 1, created: '2025-12-31T23:59:59.999Z' }, { name: 'undated', sortNum: 1 }]), ['undated', 'early', 'late']);
});

test('N5: a tie on both goes to the name by code point, not by locale', () => {
  assert.deepEqual(sorted([{ name: 'a' }, { name: 'B' }, { name: 'b' }, { name: 'A' }]), ['A', 'B', 'a', 'b'], 'upper case before lower case');
  assert.deepEqual(sorted([{ name: cp(0x1f600) }, { name: cp(0xffff) }, { name: 'z' }]), ['z', cp(0xffff), cp(0x1f600)], 'an astral character after U+FFFF');
  assert.deepEqual(sorted([{ name: 'item 10' }, { name: 'item 9' }, { name: 'item 1' }]), ['item 1', 'item 10', 'item 9'], 'no natural numeric order');
});

test('N5: then by _id, and the other fields of the item settle what is left', () => {
  assert.deepEqual(sortBySourceOrder([{ name: 'x', _id: 'b' }, { name: 'x', _id: 'a' }]).map(item => item._id), ['a', 'b']);
  const a = { name: 'x', _id: 'same', url: '/a' };
  const b = { name: 'x', _id: 'same', url: '/b' };
  assert.deepEqual(sortBySourceOrder([b, a]), [a, b]);
  assert.deepEqual(sortBySourceOrder([a, b]), [a, b]);
});

test('N5: a collection is ordered by colName when asked to', () => {
  const result = sortBySourceOrder([{ colName: 'b' }, { colName: 'a' }], 'colName');
  assert.deepEqual(result.map(item => item.colName), ['a', 'b']);
});

test('N5: the input is not changed', () => {
  const input = [{ name: 'b', sortNum: 2 }, { name: 'a', sortNum: 1 }];
  const copy = structuredClone(input);
  const result = sortBySourceOrder(input);
  assert.deepEqual(input, copy);
  assert.notEqual(result, input);
});

test('N5: one order whatever the order of the input, even with many ties', () => {
  const items: object[] = [];
  for (let i = 0; i < 40; i++) items.push({ name: `n${i % 4}`, sortNum: i % 3, created: i % 5 === 0 ? undefined : `2026-01-0${(i % 5) + 1}`, _id: i % 7 === 0 ? 'dup' : `id${i % 9}`, url: `/${i}` });
  const expected = JSON.stringify(sortBySourceOrder(items));
  for (let seed = 1; seed <= 100; seed++) assert.equal(JSON.stringify(sortBySourceOrder(shuffled(items, seed))), expected, `seed ${seed}`);
});
