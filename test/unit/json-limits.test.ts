import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exceedsDepth, hasOversizedString } from '../../src';

const nest = (depth: number, open = '[', close = ']') => open.repeat(depth) + close.repeat(depth);

test('Depth counts the nesting of arrays and objects in the text', () => {
  assert.equal(exceedsDepth('1', 64), false);
  assert.equal(exceedsDepth('[]', 1), false);
  assert.equal(exceedsDepth('[[]]', 1), true);
  assert.equal(exceedsDepth(nest(64), 64), false);
  assert.equal(exceedsDepth(nest(65), 64), true);
  assert.equal(exceedsDepth('{"a":{"b":{"c":1}}}', 3), false);
  assert.equal(exceedsDepth('{"a":{"b":{"c":1}}}', 2), true);
  assert.equal(exceedsDepth('[{"a":[{"b":[1]}]}]', 5), false);
  assert.equal(exceedsDepth('[{"a":[{"b":[1]}]}]', 4), true);
});

test('Brackets inside strings do not count, with or without escaped quotes', () => {
  assert.equal(exceedsDepth('"[[[[[[[["', 2), false);
  assert.equal(exceedsDepth('{"k":"[[[[[[[["}', 2), false);
  assert.equal(exceedsDepth('{"k":"a \\" [[[[[[[[ \\" b"}', 2), false);
  assert.equal(exceedsDepth('{"k":"back\\\\"}[[[[', 2), true, 'an escaped backslash does not escape the closing quote');
});

test('A hostile depth is refused without recursion', () => {
  assert.equal(exceedsDepth(nest(1_000_000), 64), true);
  assert.equal(exceedsDepth(nest(1_000_000, '{"a":', '}'), 64), true);
});

test('A text longer than the limit is found in a value, in an array and as an object key', () => {
  assert.equal(hasOversizedString('abc', 10), false);
  assert.equal(hasOversizedString('x'.repeat(11), 10), true);
  assert.equal(hasOversizedString({ a: ['ok', { b: 'x'.repeat(30) }] }, 10), true);
  assert.equal(hasOversizedString({ ['k'.repeat(30)]: 1 }, 10), true);
  assert.equal(hasOversizedString({ a: 1, b: [true, null, 'short'] }, 10), false);
  assert.equal(hasOversizedString(null, 10), false);
  assert.equal(hasOversizedString([], 10), false);
});

test('The limit is in bytes of UTF-8, not in characters', () => {
  const threeBytes = String.fromCodePoint(0x20ac); // euro sign
  assert.equal(hasOversizedString(threeBytes.repeat(4), 10), true, '12 bytes');
  assert.equal(hasOversizedString(threeBytes.repeat(3), 10), false, '9 bytes');
});

test('A deeply nested parsed value is walked without recursion', () => {
  let value: unknown = 'x'.repeat(50);
  for (let i = 0; i < 100_000; i++) value = [value];
  assert.equal(hasOversizedString(value, 10), true);
});

test('A parsed __proto__ key is read as an own key, never as the prototype', () => {
  const parsed: unknown = JSON.parse('{"__proto__":"' + 'x'.repeat(30) + '"}');
  assert.equal(hasOversizedString(parsed, 10), true);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});
