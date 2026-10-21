import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePending, previewOf, type PendingScript } from '../../src/script/consent';

/** The question that asks whether to run a script is all that stands between a hostile script and the person: what it shows has to be what the script is. */

const U = (...codes: number[]): string => String.fromCodePoint(...codes);

test('The question shows the lines of a script as lines: a line break is kept, a tab is two spaces, and what is hidden in a line is made visible', () => {
  const code = ['// sign the request', 'const t = Date.now();', "\tpm.request.headers.upsert({ key: 'X-Sign', value: String(t) });", '', "pm.test('ok', () => {});"].join('\n');
  assert.equal(previewOf(code, 12, 1500), "// sign the request\nconst t = Date.now();\n  pm.request.headers.upsert({ key: 'X-Sign', value: String(t) });\n\npm.test('ok', () => {});");
  assert.equal(previewOf('a\r\nb\rc', 12, 1500), 'a\nb\nc', 'every kind of line end');
  assert.equal(previewOf(`safe();${U(0x202e)} hidden();${U(0x200b)}`, 12, 1500), 'safe();? hidden();?', 'a character that reverses the text or is invisible');
  assert.equal(previewOf('', 12, 1500), '');
});

test('The other line ends of a text (NEL and the separators of Unicode) are line ends in the question as well, and in its count', () => {
  const code = `first();${U(0x2028)}second();${U(0x2029)}third();${U(0x85)}fourth();`;
  assert.equal(previewOf(code, 12, 1500), 'first();\nsecond();\nthird();\nfourth();');
  const pending: PendingScript = { key: 'pre|1', phase: 'pre', from: 'the request', code, status: 'new' } as unknown as PendingScript;
  assert.match(describePending([pending])[0] ?? '', /\(4 lines\)$/);
  assert.match(describePending([{ ...pending, code: 'one line' }])[0] ?? '', /\(1 line\)$/);
});

test('A run of empty lines is shown as one, so that code cannot be pushed out of sight below a page of them', () => {
  const code = ['safe();', ...Array.from({ length: 40 }, () => ''), '   ', '\t', 'dangerous();'].join('\n');
  assert.equal(previewOf(code, 12, 1500), 'safe();\n\ndangerous();');
});

test('A long line shows its beginning and says how much more there is, so that the lines below it are still in sight', () => {
  const code = `${'x'.repeat(2000)}\nsecond();\nthird();`;
  const shown = previewOf(code, 12, 1500).split('\n');
  assert.equal(shown.length, 3);
  assert.equal(shown[0], `${'x'.repeat(160)} [... 1840 more characters on this line]`);
  assert.deepEqual(shown.slice(1), ['second();', 'third();']);
  const one = previewOf('y'.repeat(1_000_000), 12, 1500);
  assert.ok(one.length < 300 && one.endsWith('[... 999840 more characters on this line]'), one.slice(-60));
});

test('Twelve lines are shown, then a mark that there is more; a cut of characters is marked too', () => {
  const long = Array.from({ length: 30 }, (_, index) => `line ${index};`).join('\n');
  const shown = previewOf(long, 12, 1500).split('\n');
  assert.equal(shown.length, 13);
  assert.deepEqual([shown[0], shown[11], shown[12]], ['line 0;', 'line 11;', '...']);
  const wide = Array.from({ length: 12 }, () => 'z'.repeat(150)).join('\n');
  assert.ok(previewOf(wide, 12, 1500).endsWith('...\n...'), 'more characters than the question shows');
});
