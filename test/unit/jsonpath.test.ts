import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJsonPath, JSONPATH_LIMITS, parseJsonPath } from '../../src/core/jsonpath';

const STORE = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 }
    ],
    bicycle: { color: 'red', price: 19.95 }
  },
  'odd key': { 'a.b': 1, "it's": 2, 'x"y': 3 },
  list: [1, 2, 3, 4],
  nothing: null
};

const query = (path: string, document: unknown = STORE): unknown[] => {
  const result = evaluateJsonPath(document, path);
  assert.ok(result.ok, result.ok ? '' : `${path}: ${result.error}`);
  return result.ok ? result.value : [];
};
const refused = (path: string): string => {
  const result = evaluateJsonPath(STORE, path);
  assert.equal(result.ok, false, path);
  return result.ok ? '' : result.error;
};

test('The root, keys and elements', () => {
  assert.deepEqual(query('$', { a: 1 }), [{ a: 1 }]);
  assert.deepEqual(query('$.store.bicycle.color'), ['red']);
  assert.deepEqual(query("$['store']['bicycle']['color']"), ['red']);
  assert.deepEqual(query('$["store"].bicycle.price'), [19.95]);
  assert.deepEqual(query('$.store.book[0].title'), ['Sayings of the Century']);
  assert.deepEqual(query('$.store.book[-1].title'), ['Moby Dick']);
  assert.deepEqual(query('$.store.book[3]'), [], 'past the end');
  assert.deepEqual(query('$.store.book[-4]'), [], 'before the start');
  assert.deepEqual(query('$.list[1]'), [2]);
  assert.deepEqual(query('$.nothing'), [null], 'a key whose value is null is there');
  assert.deepEqual(query('$.missing.deeper'), []);
  assert.deepEqual(query('$.store.book.title'), [], 'a key of an array selects nothing');
  assert.deepEqual(query('$.store[0]'), [], 'an index of an object selects nothing');
  assert.deepEqual(query('$.list[0].x'), []);
});

test('Keys that are not plain names are written in quotes, with a backslash for a quote', () => {
  assert.deepEqual(query("$['odd key']['a.b']"), [1]);
  assert.deepEqual(query("$['odd key']['it\\'s']"), [2]);
  assert.deepEqual(query('$["odd key"]["x\\"y"]'), [3]);
  assert.deepEqual(query('$[ \'odd key\' ][ \'a.b\' ]'), [1], 'spaces inside the brackets');
});

test('Wildcards, unions and everything below', () => {
  assert.deepEqual(query('$.store.book[*].price'), [8.95, 12.99, 8.99]);
  assert.deepEqual(query('$.store.book.*.price'), [8.95, 12.99, 8.99]);
  assert.deepEqual(query('$.store.bicycle.*'), ['red', 19.95]);
  assert.deepEqual(query('$.list[*]'), [1, 2, 3, 4]);
  assert.deepEqual(query('$.list[0,2]'), [1, 3]);
  assert.deepEqual(query('$.list[-1, 0]'), [4, 1]);
  assert.deepEqual(query("$.store.bicycle['color','price']"), ['red', 19.95]);
  assert.deepEqual(query('$..author'), ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville']);
  assert.deepEqual(query('$..price'), [8.95, 12.99, 8.99, 19.95], 'in the order of the document');
  assert.deepEqual(query('$..book[2].title'), ['Moby Dick']);
  assert.deepEqual(query('$..[0]'), [STORE.store.book[0], 1], 'an index below everything: the first element of every array');
  assert.deepEqual(query('$..isbn'), ['0-553-21311-3']);
  assert.deepEqual(query('$.store..color'), ['red']);
  assert.equal(query('$..*').length, 31, 'every node below the root, once');
  assert.deepEqual(query('$..nothing'), [null]);
});

test('Keys that look like trouble are keys', () => {
  const document = JSON.parse('{"__proto__":{"x":1},"constructor":2,"$id":"abc","a-b":3}');
  assert.deepEqual(query('$.__proto__.x', document), [1]);
  assert.deepEqual(query('$.constructor', document), [2]);
  assert.deepEqual(query('$.$id', document), ['abc']);
  assert.deepEqual(query('$.a-b', document), [3]);
  assert.deepEqual(query('$.toString', { a: 1 }), [], 'what an object inherits is not in the document');
  assert.deepEqual(query('$.hasOwnProperty', {}), []);
  assert.equal(({} as Record<string, unknown>)['x'], undefined);
});

test('A path that is not in the subset says why', () => {
  assert.match(refused('store.book'), /starts with \$/);
  assert.match(refused(''), /starts with \$/);
  assert.match(refused('$.'), /key name was expected/);
  assert.match(refused('$.a.[0]'), /key name was expected/);
  assert.match(refused('$.a b'), /unexpected " " at position 3/);
  assert.match(refused('$.store.book[?(@.price < 10)]'), /filters/);
  assert.match(refused('$.list[1:3]'), /slices/);
  assert.match(refused('$.list[:3]'), /slices/);
  assert.match(refused('$.list[0'), /never closed|, or \] was expected/);
  assert.match(refused("$['a"), /never closed/);
  assert.match(refused('$.list[x]'), /unexpected "x"/);
  assert.match(refused('$.list[1 2]'), /, or \] was expected/);
  assert.match(refused('$[]'), /unexpected "\]"/);
  assert.match(refused('$' + '.a'.repeat(JSONPATH_LIMITS.segments + 1)), /limited to 64 steps/);
  assert.match(refused('$.' + 'a'.repeat(JSONPATH_LIMITS.pathChars)), /limited to 1000 characters/);
});

test('A walk is bounded in what it visits and what it returns', () => {
  const wide = Array.from({ length: JSONPATH_LIMITS.matches + 1 }, (_, index) => index);
  const tooMany = evaluateJsonPath(wide, '$[*]');
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.ok ? '' : tooMany.error, /too much/);
  assert.equal(evaluateJsonPath(wide.slice(1), '$[*]').ok, true, 'one less is fine');
  let deep: unknown = 1;
  for (let level = 0; level < 5000; level++) deep = { a: deep };
  const result = evaluateJsonPath(deep, '$..a');
  assert.ok(result.ok && result.value.length === 5000, 'a deep document is walked without recursion');
  const grid = Array.from({ length: 1100 }, () => Array.from({ length: 1100 }, () => 0));
  const big = evaluateJsonPath(grid, '$..*');
  assert.equal(big.ok, false, 'a document of over a million nodes is not walked to the end');
  const silent = evaluateJsonPath(grid, '$..nothing');
  assert.equal(silent.ok, false, 'nor when almost nothing is selected: the walk itself is limited');
});

test('A parsed path can be used again and holds no state', () => {
  const parsed = parseJsonPath('$.list[*]');
  assert.ok(parsed.ok);
  assert.equal(parsed.ok ? parsed.value.source : '', '$.list[*]');
});
