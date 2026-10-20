import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readText } from '../../src';

test('A text field is the same whether it is a string or an array of lines', () => {
  assert.deepEqual(readText('a\nb'), { text: 'a\nb', coerced: false });
  assert.deepEqual(readText(['a', 'b']), { text: 'a\nb', coerced: false });
  assert.deepEqual(readText(['{', '  "x": 1', '}']), readText('{\n  "x": 1\n}'));
  assert.deepEqual(readText([]), { text: '', coerced: false });
  assert.deepEqual(readText(['']), { text: '', coerced: false });
  assert.deepEqual(readText(['', '']), { text: '\n', coerced: false });
});

test('A missing field is empty and not a coercion', () => {
  assert.deepEqual(readText(undefined), { text: '', coerced: false });
});

test('A value of the wrong type is converted and flagged', () => {
  assert.deepEqual(readText(5), { text: '5', coerced: true });
  assert.deepEqual(readText(false), { text: 'false', coerced: true });
  assert.deepEqual(readText(null), { text: '', coerced: true });
  assert.deepEqual(readText({ a: 1 }), { text: '', coerced: true });
  assert.deepEqual(readText(['a', 1, null, { x: 1 }, true]), { text: 'a\n1\n\n\ntrue', coerced: true });
});
