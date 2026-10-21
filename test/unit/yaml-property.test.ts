import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitYaml, parseYaml, type YMap, type YValue } from '../../src/format/yaml';

/** A small seeded generator, so that a failure can be repeated from its seed. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T };
}
type Random = ReturnType<typeof generator>;

const ATOMS = [
  'a', 'b', 'word', 'Content-Type', 'x y', '10', '007', '1e3', 'true', 'False', 'null', '~', '-', '- ', '{{v}}', '{{a}}/{{b}}', 'a: b', 'k:', ' #', '#', 'a#b', "it's", '"q"', '\\', '\t', '\n', '\n\n', ' ', '', '=', '[', ']', '{', '}', '&', '*', '!', '|', '>', '%',
  '@', '`', ',', '?', ':', '\u00e9', '\u1ea5', '\u{1F600}', '\u202e', '\u2028', '\u200b', '\ufeff', '\u0000', '\u007f', '\ud800', 'x'.repeat(40)
];

const text = (random: Random): string => Array.from({ length: random.int(5) }, () => random.pick(ATOMS)).join(random.int(3) === 0 ? ' ' : '');

function value(random: Random, depth: number): YValue {
  const kind = depth <= 0 ? 0 : random.int(4);
  if (kind <= 1) return text(random);
  if (kind === 2) return Array.from({ length: random.int(4) }, () => (random.int(2) === 0 ? text(random) : mapping(random, depth - 1)));
  return mapping(random, depth - 1);
}
function mapping(random: Random, depth: number): YMap {
  const map: YMap = new Map();
  for (let count = random.int(5); count > 0; count--) map.set(text(random), value(random, depth));
  return map;
}
const plain = (v: YValue): unknown => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(plain) : { map: [...v].map(([key, item]) => [key, plain(item)]) });
const root = (random: Random): YValue => (random.int(5) === 0 ? Array.from({ length: random.int(4) }, () => (random.int(2) === 0 ? text(random) : mapping(random, 2))) : mapping(random, 4));

test('Property: what is written is read back exactly, and writing it again changes nothing (3000 random documents)', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const random = generator(seed);
    const document = root(random);
    const written = emitYaml(document);
    const back = parseYaml(written);
    assert.ok(back.ok, `seed ${seed}: ${back.ok ? '' : `${back.error.line}:${back.error.column} ${back.error.message}`}\n${written}`);
    if (!back.ok) return;
    assert.deepEqual(plain(back.value), plain(document), `seed ${seed}\n${written}`);
    assert.equal(emitYaml(back.value), written, `seed ${seed}: writing again changed the text`);
  }
});

test('Property: a mutated or random text is read or refused, never thrown at, and anything it reads is written back to the same value (4000 cases)', () => {
  const FRAGMENTS = ['a: 1', 'b:', '  c: x', '- item', '  - nested', '- k: v', '    value: 2', 'key: |', '  text', 'key: |-', 'k: "q\\n"', "k: 'q'", '# comment', '', '---', '\t', 'x: [', 'y: {a: 1}', '- - z', '&a b: c', 'k: &x v', 'k: *x', '? k', ': v', 'k: >', 'k: !t v'];
  let accepted = 0;
  for (let seed = 1; seed <= 4000; seed++) {
    const random = generator(seed * 7919);
    let input: string;
    if (random.int(2) === 0) {
      input = Array.from({ length: random.int(8) }, () => random.pick(FRAGMENTS)).join('\n');
    } else {
      input = emitYaml(root(random));
      for (let edits = 1 + random.int(4); edits > 0; edits--) {
        const at = random.int(input.length + 1);
        const kind = random.int(3);
        if (kind === 0) input = input.slice(0, at) + input.slice(at + 1 + random.int(3));
        else if (kind === 1) input = input.slice(0, at) + random.pick(ATOMS) + input.slice(at);
        else input = input.slice(0, at) + ' '.repeat(random.int(4)) + input.slice(at);
      }
    }
    const result = parseYaml(input);
    if (!result.ok) {
      assert.ok(result.error.line >= 1 && result.error.column >= 1 && result.error.message.length > 0, `seed ${seed}`);
      continue;
    }
    accepted++;
    const again = parseYaml(emitYaml(result.value));
    assert.ok(again.ok, `seed ${seed}: what was read could not be written and read again\n${JSON.stringify(input)}`);
    if (again.ok) assert.deepEqual(plain(again.value), plain(result.value), `seed ${seed}\n${JSON.stringify(input)}`);
  }
  assert.ok(accepted > 300, `only ${accepted} of the cases were accepted: the generator is too hostile to prove anything`);
});
