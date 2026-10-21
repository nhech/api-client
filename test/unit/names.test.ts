import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, slugify, uniqueSlugs } from '../../src';

const slug = (name: string) => slugify(name).slug;
/** Invisible and direction-changing characters are built from numbers: they must not appear in this source either. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

test('A plain name stays as it is', () => {
  assert.deepEqual(slugify('Shop API'), { slug: 'Shop API', changed: false });
  assert.deepEqual(slugify('orders-v2_final'), { slug: 'orders-v2_final', changed: false });
  const vietnamese = 'D' + cp(0x1a1) + 'n h' + cp(0xe0) + 'ng';
  assert.equal(slug(vietnamese), vietnamese);
});

test('Characters that are not allowed in a file name become a hyphen, and hyphens do not pile up', () => {
  assert.equal(slug('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(slug('a / b'), 'a - b');
  assert.equal(slug('a//b'), 'a-b');
  assert.equal(slug('tab\tnew\nline'), 'tab-new-line');
});

test('A name can never climb out of its folder', () => {
  assert.equal(slug('../x'), 'x');
  assert.equal(slug('..'), 'unnamed');
  assert.equal(slug('a/../b'), 'a-b');
  assert.equal(slug('.hidden'), 'hidden');
  for (const hostile of ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path', 'C:\\x', '\\\\server\\share', '....//....//x']) {
    const result = slug(hostile);
    assert.ok(!result.includes('/') && !result.includes('\\') && !result.includes('..') && !result.startsWith('.'), `${hostile} -> ${result}`);
  }
});

test('Dots and spaces at the ends are cut, as Windows does not keep them', () => {
  assert.equal(slug('name. '), 'name');
  assert.equal(slug('  padded  '), 'padded');
  assert.equal(slug('...'), 'unnamed');
});

test('Windows reserved names get an underscore after the part before the first dot', () => {
  assert.equal(slug('CON'), 'CON_');
  assert.equal(slug('aux'), 'aux_');
  assert.equal(slug('aux.txt'), 'aux_.txt');
  assert.equal(slug('Nul.v2.json'), 'Nul_.v2.json');
  assert.equal(slug('COM1'), 'COM1_');
  assert.equal(slug('lpt9'), 'lpt9_');
  const superscript = 'LPT' + cp(0xb9);
  assert.equal(slug(superscript), superscript + '_');
  assert.equal(slug('conin$'), 'conin$_');
  for (const fine of ['console', 'com10', 'auxiliary', 'null', 'con-x', 'a.con']) assert.equal(slug(fine), fine, fine);
});

test('Characters that reorder or hide text are replaced', () => {
  for (const hidden of [0x202e, 0x202a, 0x2066, 0x2069, 0x200b, 0x200f, 0x00, 0x7f, 0x85]) assert.equal(slug('a' + cp(hidden) + 'b'), 'a-b', `U+${hidden.toString(16)}`);
  assert.equal(slug(cp(0xfeff) + 'name'), 'name', 'replaced like any other unsafe character, and no name starts with a hyphen');
});

test('The name is normalised to NFC so the same text always gives the same file name', () => {
  const decomposed = 'e' + cp(0x301);
  assert.equal(slug(decomposed), cp(0xe9));
  assert.equal(slugify(decomposed).changed, true);
});

test('An empty name becomes "unnamed", and a long one is cut by code points, not in the middle of a character', () => {
  assert.equal(slug(''), 'unnamed');
  assert.equal(slug('   '), 'unnamed');
  assert.equal(slug('/'), 'unnamed');
  assert.equal(slug('---'), 'unnamed');
  assert.equal(slug('-a-'), 'a-', 'no name starts with a hyphen (a shell would read it as an option), but one inside or at the end stays');
  assert.equal(slug('a-b'), 'a-b');
  assert.equal(Array.from(slug('x'.repeat(500))).length, LIMITS.maxSlugChars);
  const emoji = cp(0x1f600).repeat(100);
  const result = slug(emoji);
  assert.equal(Array.from(result).length, LIMITS.maxSlugChars);
  assert.equal(Buffer.from(result, 'utf8').toString('utf8'), result, 'no lone surrogate: the text survives UTF-8');
  assert.equal(slug('a'.repeat(59) + '. . .b'), 'a'.repeat(59), 'the cut does not leave a trailing dot');
});

test('The slug is idempotent: slugifying a slug changes nothing', () => {
  for (const name of ['a/b', 'aux.txt', '../x', '  ', 'e' + cp(0x301), 'CON', 'x'.repeat(200), 'a' + cp(0x202e) + 'b', cp(0x1f600).repeat(70)]) {
    const once = slug(name);
    assert.equal(slug(once), once, name);
  }
});

test('Repeated slugs get -2, -3 in the order given, ignoring letter case', () => {
  const result = uniqueSlugs(['Orders', 'orders', 'ORDERS', 'Other']);
  assert.deepEqual(result.map(r => r.slug), ['Orders', 'orders-2', 'ORDERS-3', 'Other']);
  assert.deepEqual(result.map(r => r.collided), [false, true, true, false]);
  assert.deepEqual(result.map(r => r.changed), [false, true, true, false]);
});

test('Names that clash only after cleaning are told apart too', () => {
  assert.deepEqual(uniqueSlugs(['a/b', 'a:b', 'a-b']).map(r => r.slug), ['a-b', 'a-b-2', 'a-b-3']);
});

test('A suffix still fits inside the limit', () => {
  const name = 'y'.repeat(100);
  const result = uniqueSlugs([name, name, name]);
  assert.ok(result.every(r => Array.from(r.slug).length <= LIMITS.maxSlugChars));
  assert.equal(new Set(result.map(r => r.slug.toLowerCase())).size, 3);
  assert.ok(result[1]?.slug.endsWith('-2') && result[2]?.slug.endsWith('-3'));
});

test('A suffixed slug is not taken by a later name that is already called that', () => {
  assert.deepEqual(uniqueSlugs(['a', 'a', 'a-2']).map(r => r.slug), ['a', 'a-2', 'a-2-2']);
});

test('The result depends only on the names and their order', () => {
  const names = ['B', 'a', 'A', 'b', 'con', 'CON', '..', ''];
  assert.deepEqual(uniqueSlugs(names), uniqueSlugs([...names]));
});

test('Characters that draw nothing cannot hide in a folder or file name, and an emoji with its variation selector is kept', () => {
  for (const code of [0xad, 0x34f, 0x61c, 0x2060, 0x3164, 0x180e, 0xe0041, 0x206a]) {
    const result = slugify('Shop' + cp(code) + 'End');
    assert.equal(result.changed, true, `U+${code.toString(16)}`);
    assert.ok(!Array.from(result.slug).some(char => (char.codePointAt(0) ?? 0) === code), `U+${code.toString(16)} is not in ${result.slug}`);
  }
  const heart = cp(0x2764, 0xfe0f) + ' Orders';
  assert.equal(slug(heart), heart);
});
