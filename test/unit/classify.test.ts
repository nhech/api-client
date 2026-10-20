import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContent } from '../../src';

test('A file is classified by its content, for every kind of the spec', () => {
  const table: [unknown, string][] = [
    [{ colName: 'a', requests: [], folders: [] }, 'v4-collection'],
    [{ name: 'dev', data: [] }, 'v4-environment'],
    [{ collectionName: 'a', requests: [] }, 'export-collection'],
    [{ environmentName: 'a', variables: [] }, 'export-environment'],
    [[{ _id: '1', colName: 'a', folders: [] }], 'v3-collections'],
    [[{ colId: 'c', url: 'u' }], 'v3-requests'],
    [[{ name: 'dev', data: [] }], 'v3-environments']
  ];
  for (const [json, kind] of table) assert.equal(classifyContent(json), kind, JSON.stringify(json));
});

test('Things that are not Thunder data are unrecognised, whatever their shape', () => {
  for (const json of [null, undefined, 1, 'text', true, [], [1, 2], [null, 'x'], {}, { requests: [] }, { colName: 'a' }, { colName: 'a', requests: 'no' }, { name: 'a', data: {} }]) {
    assert.equal(classifyContent(json), 'unrecognized', JSON.stringify(json));
  }
});

test('An array is judged by its first element that is an object', () => {
  assert.equal(classifyContent([1, null, { colName: 'a' }]), 'v3-collections');
  assert.equal(classifyContent([{ colId: 'history', url: 'u' }, { colName: 'ignored' }]), 'v3-requests');
});

test('A parsed __proto__ or constructor key does not make a file look like another kind', () => {
  assert.equal(classifyContent(JSON.parse('{"__proto__":{"colName":"x"},"requests":[]}')), 'unrecognized');
  assert.equal(classifyContent(JSON.parse('{"constructor":{"colName":"x"},"requests":[]}')), 'unrecognized');
  assert.equal(classifyContent(JSON.parse('[{"__proto__":{"colName":"x"}}]')), 'unrecognized');
});
