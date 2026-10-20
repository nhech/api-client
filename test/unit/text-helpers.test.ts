import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coercions } from '../../src/normalize/coerce';
import { cleanLine, hasLiteral, indexOutsideVariables, mapLiteral, oneLine, splitOutsideVariables, splitVariables, variableSpans } from '../../src/convert/text';

/** Invisible and direction-changing characters are built from numbers: they must not appear in this source either. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

test('Variables are found with nested braces, and an unclosed {{ is plain text', () => {
  assert.deepEqual(variableSpans('a{{x}}b{{y}}'), [[1, 6], [7, 12]]);
  assert.deepEqual(variableSpans('{{#date, {year: -1, day: 3}}}'), [[0, 29]]);
  assert.deepEqual(variableSpans('{{#date,\'YYYY\', {year: -1}}}!'), [[0, 28]]);
  assert.deepEqual(variableSpans('{{unclosed'), []);
  assert.deepEqual(variableSpans('{{a}} {{b'), [[0, 5]]);
  assert.deepEqual(variableSpans('{ {x} }'), []);
  assert.deepEqual(variableSpans(''), []);
});

test('splitVariables keeps every character and marks which pieces are variables', () => {
  const text = 'https://{{host}}/a/{{#number, 1, 2}}?q={{q}}';
  const pieces = splitVariables(text);
  assert.equal(pieces.map(p => p.text).join(''), text);
  assert.deepEqual(pieces.filter(p => p.variable).map(p => p.text), ['{{host}}', '{{#number, 1, 2}}', '{{q}}']);
});

test('mapLiteral edits what is between variables only', () => {
  assert.equal(mapLiteral('a b {{x y}} c d', s => s.replaceAll(' ', '_')), 'a_b_{{x y}}_c_d');
  assert.equal(mapLiteral('', s => s + '!'), '');
});

test('Splitting and searching ignore separators inside variables', () => {
  assert.deepEqual(splitOutsideVariables('a=1&b={{x&y}}&c', '&'), ['a=1', 'b={{x&y}}', 'c']);
  assert.deepEqual(splitOutsideVariables('', '&'), ['']);
  assert.deepEqual(splitOutsideVariables('a&&b', '&'), ['a', '', 'b']);
  assert.equal(indexOutsideVariables('{{a?b}}?c', '?'), 7);
  assert.equal(indexOutsideVariables('{{#guid}}', '#'), -1, 'the # of a dynamic variable is not a fragment');
  assert.equal(indexOutsideVariables('abc', 'x'), -1);
  assert.equal(indexOutsideVariables('a?b?c', '?', 2), 3);
});

test('A literal is anything but variables and white space', () => {
  assert.equal(hasLiteral('{{token}}'), false);
  assert.equal(hasLiteral(' {{a}} {{b}} '), false);
  assert.equal(hasLiteral(''), false);
  assert.equal(hasLiteral('abc'), true);
  assert.equal(hasLiteral('{{a}}x'), true);
});

test('A one-line value never carries a line break, and hidden characters are made visible', () => {
  assert.deepEqual(oneLine('a\r\nb\nc\rd'), { text: 'a  b c d', lineBreak: true });
  assert.deepEqual(oneLine('a\tb'), { text: 'a b', lineBreak: false });
  assert.deepEqual(oneLine('x' + cp(0x202e) + 'y' + cp(0x00) + 'z'), { text: 'x?y?z', lineBreak: false });
  assert.deepEqual(oneLine('plain'), { text: 'plain', lineBreak: false });
  assert.deepEqual(cleanLine('  a\nb  '), { text: 'a b', lineBreak: true });
});

test('Coercions count what was converted and leave a missing value alone', () => {
  const c = new Coercions();
  assert.equal(c.string('x'), 'x');
  assert.equal(c.string(undefined), '');
  assert.equal(c.count, 0);
  assert.equal(c.string(5), '5');
  assert.equal(c.string(false), 'false');
  assert.equal(c.string(null), '');
  assert.equal(c.string({ a: 1 }), '');
  assert.equal(c.count, 4);
  assert.equal(c.flag(true), true);
  assert.equal(c.flag(undefined), false);
  assert.equal(c.flag(false), false);
  assert.equal(c.count, 4);
  assert.equal(c.flag('yes'), false);
  assert.equal(c.count, 5);
});
