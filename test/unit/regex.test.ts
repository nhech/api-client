import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompiledRegex, REGEX_LIMITS, RegexError, splitRegexLiteral, type RegexFlags } from '../../src/core/regex';

const matches = (pattern: string, text: string, flags: Partial<RegexFlags> = {}): boolean => CompiledRegex.compile(pattern, flags).test(text);
const refused = (pattern: string): string => {
  try { CompiledRegex.compile(pattern); } catch (error) { assert.ok(error instanceof RegexError, String(error)); return error.message; }
  return assert.fail(`${pattern} was accepted`);
};

test('Literals, the dot, classes and the escapes match what they do in JavaScript', () => {
  assert.equal(matches('abc', 'xxabcxx'), true);
  assert.equal(matches('abc', 'ab'), false);
  assert.equal(matches('a.c', 'abc'), true);
  assert.equal(matches('a.c', 'a\nc'), false, 'the dot stops at a line break');
  assert.equal(matches('a.c', 'a\nc', { dotAll: true }), true);
  assert.equal(matches('[a-c]+z', 'xxbcz'), true);
  assert.equal(matches('[^a-c]', 'abc'), false);
  assert.equal(matches('[^a-c]', 'abcd'), true);
  assert.equal(matches('\\d{3}-\\d{4}', 'call 555-1234 now'), true);
  assert.equal(matches('\\D', '123'), false);
  assert.equal(matches('^\\w+$', 'hello_World9'), true);
  assert.equal(matches('^\\w+$', 'hello world'), false);
  assert.equal(matches('\\s', 'a\tb'), true);
  assert.equal(matches('[\\d.]+', 'v1.25'), true);
  assert.equal(matches('[\\w-]+@', 'ann-lee@x'), true);
  assert.equal(matches('\\.', 'a.b'), true);
  assert.equal(matches('\\.', 'ab'), false);
  assert.equal(matches('\\u0041\\x42', 'AB'), true);
  assert.equal(matches('\\u{1F600}', '\u{1F600}'), true);
  assert.equal(matches('^.$', '\u{1F600}'), true, 'a character outside the BMP is one character');
  assert.equal(matches('[]', 'a'), false, 'an empty class matches nothing, as in JavaScript');
  assert.equal(matches('[^]', '\n'), true);
  assert.equal(matches('a{', 'a{'), true, 'a brace that is not a count is a brace');
  assert.equal(matches('a{,2}', 'a{,2}'), true);
});

test('Anchors, boundaries, groups and alternation', () => {
  assert.equal(matches('^abc', 'abcd'), true);
  assert.equal(matches('^abc', 'xabc'), false);
  assert.equal(matches('abc$', 'xabc'), true);
  assert.equal(matches('abc$', 'abc\n'), false, 'with no m flag $ is the end of the text');
  assert.equal(matches('^b', 'a\nb', { multiline: true }), true);
  assert.equal(matches('^b', 'a\nb'), false);
  assert.equal(matches('a$', 'a\nb', { multiline: true }), true);
  assert.equal(matches('\\bcat\\b', 'a cat sat'), true);
  assert.equal(matches('\\bcat\\b', 'concatenate'), false);
  assert.equal(matches('\\Bcat', 'concatenate'), true);
  assert.equal(matches('(ab)+c', 'ababc'), true);
  assert.equal(matches('(?:ab)+c', 'abac'), false);
  assert.equal(matches('^(foo|bar|baz)$', 'bar'), true);
  assert.equal(matches('^(foo|bar|baz)$', 'barn'), false);
  assert.equal(matches('a|', 'zzz'), true, 'an empty branch matches the empty text');
  assert.equal(matches('', 'anything'), true);
  assert.equal(matches('^$', ''), true);
  assert.equal(matches('colou?r', 'the color'), true);
  assert.equal(matches('^a{2,3}$', 'aaaa'), false);
  assert.equal(matches('^a{2,3}$', 'aaa'), true);
  assert.equal(matches('^a{2,}$', 'a'.repeat(50)), true);
  assert.equal(matches('^(a|b)*c$', 'abbac'), true);
});

test('Ignoring case works for literals and classes', () => {
  assert.equal(matches('HELLO', 'say hello', { ignoreCase: true }), true);
  assert.equal(matches('hello', 'say HELLO'), false);
  assert.equal(matches('[a-c]+', 'XBZ', { ignoreCase: true }), true);
  assert.equal(matches('[^a]', 'A', { ignoreCase: true }), false);
  assert.equal(matches(String.fromCodePoint(0xe9), String.fromCodePoint(0xc9), { ignoreCase: true }), true);
});

test('What cannot be run in bounded time is refused with a sentence', () => {
  assert.match(refused('(?=a)b'), /look-around/);
  assert.match(refused('(?!a)'), /look-around/);
  assert.match(refused('(?<n>a)'), /named groups|look-around/);
  assert.match(refused('(a)\\1'), /back-reference/);
  assert.match(refused('\\k<n>'), /not supported/);
  assert.match(refused('\\p{L}'), /not supported/);
  assert.match(refused('(a'), /never closed/);
  assert.match(refused('a)'), /no \( before/);
  assert.match(refused('[a'), /never closed/);
  assert.match(refused('*a'), /nothing before/);
  assert.match(refused('^*'), /anchor cannot be repeated/);
  assert.match(refused('a\\'), /backslash/);
  assert.match(refused('[z-a]'), /more to less/);
  assert.match(refused('a{3,2}'), /more to less/);
  assert.match(refused('a{5000}'), /limited/);
  assert.match(refused('a{5000,}'), /limited/);
  assert.match(refused('\\x4'), /hexadecimal/);
  assert.match(refused('x'.repeat(REGEX_LIMITS.patternChars + 1)), /limited to/);
  assert.match(refused('(a{1000}){1000}'), /too large/);
});

test('A pattern that takes exponential time in JavaScript takes linear time here', () => {
  const started = Date.now();
  assert.equal(matches('^(a+)+$', `${'a'.repeat(30_000)}b`), false);
  assert.equal(matches('(a|aa)+$', `${'a'.repeat(30_000)}b`), false);
  assert.equal(matches('(x+x+)+y', 'x'.repeat(30_000)), false);
  assert.equal(matches('^(\\w+\\s?)*$', `${'word '.repeat(5000)}!`), false);
  assert.equal(matches('(.*)*z', 'a'.repeat(30_000)), false);
  assert.equal(matches('(a?){300}a{300}', 'a'.repeat(300)), true, 'the classic that is exponential for a backtracking engine');
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
});

test('A text that is too long is refused instead of searched', () => {
  assert.throws(() => matches('a', 'x'.repeat(REGEX_LIMITS.textChars + 1)), /not searched/);
});

test('A value written as /pattern/flags is split; anything else is the pattern', () => {
  assert.deepEqual(splitRegexLiteral('/ab+c/i'), { pattern: 'ab+c', flags: { ignoreCase: true, multiline: false, dotAll: false } });
  assert.deepEqual(splitRegexLiteral('/a/ms'), { pattern: 'a', flags: { ignoreCase: false, multiline: true, dotAll: true } });
  assert.deepEqual(splitRegexLiteral('/a/'), { pattern: 'a', flags: { ignoreCase: false, multiline: false, dotAll: false } });
  assert.deepEqual(splitRegexLiteral('a/b'), { pattern: 'a/b', flags: {} });
  assert.deepEqual(splitRegexLiteral('/a/b/'), { pattern: 'a/b', flags: { ignoreCase: false, multiline: false, dotAll: false } });
  assert.deepEqual(splitRegexLiteral('plain'), { pattern: 'plain', flags: {} });
  assert.throws(() => splitRegexLiteral('/a/g'), /flag "g" is not supported/);
  assert.throws(() => splitRegexLiteral('/a/ii'), /repeated/);
});

// ---- the oracle: the engine of JavaScript, on patterns it can run quickly ----

test('Property: on 3000 random patterns and texts the answer is the one of the engine of JavaScript', () => {
  let state = 987654321;
  const random = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor((state / 0x100000000) * limit); };
  const pick = <T>(items: readonly T[]): T => items[random(items.length)] as T;
  const ALPHABET = ['a', 'b', 'A', 'c', ' ', '\n', '_', '1'];
  const atom = (depth: number): string => {
    const kind = random(depth > 2 ? 7 : 10);
    switch (kind) {
      case 0: case 1: return pick(['a', 'b', 'c', 'A']);
      case 2: return '.';
      case 3: return pick(['[ab]', '[^a]', '[a-c]', '[^\\d]', '[\\w ]', '[A-Z]']);
      case 4: return pick(['\\d', '\\w', '\\s', '\\W', '\\S']);
      case 5: return pick(['^', '$', '\\b', '\\B']);
      case 6: return pick(['_', '1', ' ']);
      default: return `(${random(2) === 0 ? '?:' : ''}${alternation(depth + 1)})`;
    }
  };
  const quantified = (depth: number): string => {
    const piece = atom(depth);
    if (/^(?:\^|\$|\\b|\\B)$/.test(piece)) return piece;
    return piece + pick(['', '', '', '*', '+', '?', '{2}', '{1,2}', '{0,2}', '*?', '+?', '??', '{2,}']);
  };
  const sequence = (depth: number): string => Array.from({ length: 1 + random(4) }, () => quantified(depth)).join('');
  const alternation = (depth: number): string => (random(4) === 0 ? `${sequence(depth)}|${sequence(depth)}` : sequence(depth));
  let compared = 0;
  for (let round = 0; round < 3000; round++) {
    const pattern = alternation(0);
    const flags: Partial<RegexFlags> = { ignoreCase: random(3) === 0, multiline: random(3) === 0, dotAll: random(3) === 0 };
    const letters = `${flags.ignoreCase ? 'i' : ''}${flags.multiline ? 'm' : ''}${flags.dotAll ? 's' : ''}`;
    let oracle: RegExp;
    try { oracle = new RegExp(pattern, letters); } catch { continue; }
    const mine = CompiledRegex.compile(pattern, flags);
    for (let sample = 0; sample < 4; sample++) {
      const text = Array.from({ length: random(9) }, () => pick(ALPHABET)).join('');
      assert.equal(mine.test(text), oracle.test(text), `/${pattern}/${letters} on ${JSON.stringify(text)}`);
      compared++;
    }
  }
  assert.ok(compared > 8000, `only ${compared} comparisons`);
});
