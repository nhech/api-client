import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCodePoints, isHiddenChar, isUnsafeInName, printable } from '../../src';

/** Invisible and direction-changing characters are built from numbers: they must not appear in this source either. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

test('Hidden characters are the controls, zero-width characters, the line and paragraph separators, direction controls and the byte order mark', () => {
  for (const code of [0x00, 0x1f, 0x7f, 0x85, 0x9f, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x3164, 0xffa0, 0x180e, 0x2060, 0x2064, 0x206a, 0x206f, 0xfff9, 0xfffb, 0xe0000, 0xe0041, 0xe007f]) assert.equal(isHiddenChar(cp(code)), true, `U+${code.toString(16)}`);
  for (const code of [0x20, 0x41, 0xa0, 0xe9, 0x2010, 0x202f, 0x1f600, 0xfe0f, 0x2764, 0x3042, 0xe0080, 0x2065]) assert.equal(isHiddenChar(cp(code)), false, `U+${code.toString(16)}`);
});

test('A name may not keep the punctuation of Windows file names or any hidden character', () => {
  for (const char of ['<', '>', ':', '"', '/', '\\', '|', '?', '*', cp(0x202e)]) assert.equal(isUnsafeInName(char), true, char);
  for (const char of ['a', '-', '_', '.', ' ', '(', ')', '#', '$']) assert.equal(isUnsafeInName(char), false, char);
});

test('printable() makes hidden characters visible and leaves the rest alone', () => {
  assert.equal(printable('tc_col_a.json'), 'tc_col_a.json');
  assert.equal(printable('a' + cp(0x202e) + 'b' + cp(0x07) + 'c'), 'a?b?c');
  assert.equal(printable(cp(0x1f600) + cp(0xfeff)), cp(0x1f600) + '?');
});

test('compareCodePoints orders by code point, not by UTF-16 unit', () => {
  assert.equal(compareCodePoints('a', 'b'), -1);
  assert.equal(compareCodePoints('b', 'a'), 1);
  assert.equal(compareCodePoints('a', 'a'), 0);
  assert.equal(compareCodePoints('a', 'ab'), -1);
  assert.equal(compareCodePoints('ab', 'a'), 1);
  assert.equal(compareCodePoints('', ''), 0);
  assert.equal(compareCodePoints('', 'a'), -1);
  // U+FFFF sorts before U+1F600 by code point; by UTF-16 unit (0xD83D) the emoji would come first.
  assert.equal(compareCodePoints(cp(0xffff), cp(0x1f600)), -1);
  assert.equal(compareCodePoints(cp(0x1f600), cp(0xffff)), 1);
  assert.equal(compareCodePoints(cp(0x1f600) + 'a', cp(0x1f600) + 'b'), -1);
});

test('Sorting with compareCodePoints gives one order whatever the input order', () => {
  const names = ['tc_col_b.json', 'tc_col_a.json', 'TC_COL_C.json', 'tc_col_' + cp(0x1f600), 'tc_col_' + cp(0xffff), ''];
  const expected = [...names].sort(compareCodePoints);
  for (let i = 0; i < 6; i++) assert.deepEqual([...names].reverse().sort(compareCodePoints), expected);
  assert.deepEqual(expected, ['', 'TC_COL_C.json', 'tc_col_' + cp(0xffff), 'tc_col_' + cp(0x1f600), 'tc_col_a.json', 'tc_col_b.json'].sort(compareCodePoints));
  assert.equal(expected[0], '');
  assert.equal(expected.indexOf('tc_col_' + cp(0xffff)) < expected.indexOf('tc_col_' + cp(0x1f600)), true);
});
