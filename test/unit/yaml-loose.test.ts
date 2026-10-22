import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOSE_LIMITS, parseLooseYaml, plainValue, type LooseValue } from '../../src/format/yaml/loose';

/** The reader of the YAML that other people's files are written in (an OpenAPI description, for one): what it reads, what it refuses, and how it behaves on hostile text. */

/** Plain data that compares equal to what JSON.parse gives (the objects of the reader have no prototype). */
const data = (value: LooseValue): unknown => JSON.parse(JSON.stringify(value));
const read = (text: string): LooseValue => {
  const result = parseLooseYaml(text);
  assert.ok(result.ok, result.ok ? '' : `${result.error.line}:${result.error.column} ${result.error.message}`);
  return result.value;
};
const fails = (text: string, pattern: RegExp, at?: { line: number; column: number }): void => {
  const result = parseLooseYaml(text);
  assert.equal(result.ok, false, `expected an error for ${JSON.stringify(text.slice(0, 60))}`);
  if (!result.ok) {
    assert.match(result.error.message, pattern);
    if (at !== undefined) assert.deepEqual({ line: result.error.line, column: result.error.column }, at);
  }
};
const E = String.fromCodePoint(0xe9);

test('Mappings and lists: nesting, a list at the margin of its key, a list of mappings, a list in a list, and empty values', () => {
  const text = [
    'openapi: 3.0.3',
    'info:',
    '  title: Pet Store',
    '  version: 1.2.0',
    'tags:',
    '- name: pets',
    '  description: Everything about pets',
    '- name: store',
    'paths:',
    '  /pets/{petId}:',
    '    get:',
    '      parameters:',
    '        - name: petId',
    '          in: path',
    '          required: true',
    '      responses:',
    "        '200':",
    '          description: ok',
    '        default:',
    'matrix:',
    '  - - 1',
    '    - 2',
    '  - - 3',
    'nothing:',
    ''
  ].join('\n');
  assert.deepEqual(data(read(text)), {
    openapi: '3.0.3', info: { title: 'Pet Store', version: '1.2.0' },
    tags: [{ name: 'pets', description: 'Everything about pets' }, { name: 'store' }],
    paths: { '/pets/{petId}': { get: { parameters: [{ name: 'petId', in: 'path', required: true }], responses: { 200: { description: 'ok' }, default: null } } } },
    matrix: [[1, 2], [3]], nothing: null
  });
});

test('A plain scalar is null, a flag, a number or text; a quoted one is always text', () => {
  const cases: [string, unknown][] = [
    ['~', null], ['null', null], ['Null', null], ['NULL', null], ['true', true], ['True', true], ['FALSE', false],
    ['0', 0], ['42', 42], ['-7', -7], ['+3', 3], ['1.5', 1.5], ['-0.25', -0.25], ['.5', 0.5], ['5.', 5], ['1e3', 1000], ['2.5E-2', 0.025], ['0x1F', 31], ['0o17', 15],
    ['007', '007'], ['1.2.3', '1.2.3'], ['3.0.3', '3.0.3'], ['12345678901234567890', '12345678901234567890'], ['1_000', '1_000'], ['yes', 'yes'], ['no', 'no'], ['on', 'on'], ['2020-01-01', '2020-01-01'],
    ['abc', 'abc'], ['--1', '--1'], ['1e', '1e'], ['e1', 'e1']
  ];
  for (const [text, expected] of cases) assert.deepEqual(data(read(`a: ${text}`)), { a: expected }, text);
  assert.equal(plainValue('.inf'), Infinity);
  assert.equal(plainValue('-.inf'), -Infinity);
  assert.ok(Number.isNaN(plainValue('.nan') as number));
  for (const text of ["'42'", '"42"', "'true'", '"null"', "''", '""']) assert.equal(typeof (read(`a: ${text}`) as { a: unknown }).a, 'string', text);
  assert.deepEqual(data(read('a: ""')), { a: '' });
});

test('Flow collections: lists, mappings, nesting, quotes, empty ones, trailing commas, several lines with comments, and a JSON document', () => {
  assert.deepEqual(data(read('a: [x, 1, true, null, "p, q", \'it\'\'s\']')), { a: ['x', 1, true, null, 'p, q', "it's"] });
  assert.deepEqual(data(read('a: {b: 1, "c d": [2, 3], e: {f: g}}')), { a: { b: 1, 'c d': [2, 3], e: { f: 'g' } } });
  assert.deepEqual(data(read('a: []\nb: {}\nc: [ ]\nd: { }')), { a: [], b: {}, c: [], d: {} });
  assert.deepEqual(data(read('a: [1, 2, ]\nb: {x: 1, }')), { a: [1, 2], b: { x: 1 } });
  assert.deepEqual(data(read(['required: [id,', '  name, # the name', '  tag]', 'next: 1'].join('\n'))), { required: ['id', 'name', 'tag'], next: 1 });
  assert.deepEqual(data(read('a: [b: 1, c]')), { a: [{ b: 1 }, 'c'] });
  assert.deepEqual(data(read('a: {x, y: 2}')), { a: { x: null, y: 2 } });
  assert.deepEqual(data(read('a: [http://example.com/x#frag, a#b]')), { a: ['http://example.com/x#frag', 'a#b'] });
  assert.deepEqual(data(read("a: [it's fine, \"x, y\", don't # a comment\n  , z]")), { a: ["it's fine", 'x, y', "don't", 'z'] });
  assert.deepEqual(data(read("a: [it's, b]\nc: 1")), { a: ["it's", 'b'], c: 1 }, 'an apostrophe inside a plain scalar does not open a quote that swallows the lines after it');
  const json = JSON.stringify({ openapi: '3.0.0', paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } }, list: [1, 2.5, null, true, 'x'] }, null, 2);
  assert.deepEqual(data(read(json)), JSON.parse(json));
  assert.deepEqual(data(read(JSON.stringify([1, [2, [3]]]))), [1, [2, [3]]]);
});

test('Quoted scalars: the escapes, the doubled quote, several lines folded with a space, an empty line as a line break, a backslash at the end of a line as a join', () => {
  assert.deepEqual(data(read('a: "x\\ny\\t\\"z\\" \\u00e9 \\x41 \\/"')), { a: `x\ny\t"z" ${E} A /` });
  assert.deepEqual(data(read("a: 'it''s'")), { a: "it's" });
  assert.deepEqual(data(read(['a: "first', '  second', '', '  third"', 'b: 1'].join('\n'))), { a: 'first second\nthird', b: 1 });
  assert.deepEqual(data(read(["a: 'one", '  two\'', 'b: 2'].join('\n'))), { a: 'one two', b: 2 });
  assert.deepEqual(data(read(['a: "abc\\', '  def"'].join('\n'))), { a: 'abcdef' });
  assert.deepEqual(data(read('"quoted key": 1\n\'other: key\': 2')), { 'quoted key': 1, 'other: key': 2 });
  assert.deepEqual(data(read('a: "x" # a comment')), { a: 'x' });
  assert.deepEqual(data(read('a: "has # inside"')), { a: 'has # inside' });
  fails('a: "x" y', /unexpected text after the closing quote/);
  fails('a: "never closed\nb: 1', /never closed|never/);
  fails('a: "bad \\q escape"', /unsupported escape/);
  fails('a: "\\U00110000"', /above U\+10FFFF/);
});

test('Plain scalars that go on over the lines under them, with comments, URLs and a colon inside', () => {
  assert.deepEqual(data(read(['description: This is a long', '  description that goes', '  on and on', 'next: 1'].join('\n'))), { description: 'This is a long description that goes on and on', next: 1 });
  assert.deepEqual(data(read(['description: one', '', '  two', 'next: 1'].join('\n'))), { description: 'one\ntwo', next: 1 });
  assert.deepEqual(data(read(['description: one # a comment', 'next: 1'].join('\n'))), { description: 'one', next: 1 });
  fails(['description: one # a comment', '  two'].join('\n'), /indented more than the key/);
  assert.deepEqual(data(read('url: http://example.com/a#frag\nnote: Returns: a list\nname: a:b')), { url: 'http://example.com/a#frag', note: 'Returns: a list', name: 'a:b' });
  assert.deepEqual(data(read(['- first line', '  second line', '- next'].join('\n'))), ['first line second line', 'next']);
  assert.deepEqual(data(read('just a scalar')), 'just a scalar');
  assert.deepEqual(data(read('- 1\n- two\n- 3.5')), [1, 'two', 3.5]);
});

test('Block scalars: literal and folded, clip, strip and keep, an indent digit, empty ones, lines indented more, and one in a list', () => {
  const text = (header: string): string => ['a: ' + header, '  line one', '  line two', '', '  line four', '', 'b: 1'].join('\n');
  assert.deepEqual(data(read(text('|'))), { a: 'line one\nline two\n\nline four\n', b: 1 });
  assert.deepEqual(data(read(text('|-'))), { a: 'line one\nline two\n\nline four', b: 1 });
  assert.deepEqual(data(read(text('|+'))), { a: 'line one\nline two\n\nline four\n\n', b: 1 });
  assert.deepEqual(data(read(text('>'))), { a: 'line one line two\nline four\n', b: 1 });
  assert.deepEqual(data(read(text('>-'))), { a: 'line one line two\nline four', b: 1 });
  assert.deepEqual(data(read(['a: |', '  keep', '    indented', '  back', 'b: 1'].join('\n'))), { a: 'keep\n  indented\nback\n', b: 1 });
  assert.deepEqual(data(read(['a: >', '  fold', '    more indented', '  fold again', 'b: 1'].join('\n'))), { a: 'fold\n  more indented\nfold again\n', b: 1 });
  assert.deepEqual(data(read(['a: |2', '    two spaces kept', '  x', 'b: 1'].join('\n'))), { a: '  two spaces kept\nx\n', b: 1 });
  assert.deepEqual(data(read(['a: |', 'b: 1'].join('\n'))), { a: '', b: 1 });
  assert.deepEqual(data(read(['a: |', '', 'b: 1'].join('\n'))), { a: '', b: 1 });
  assert.deepEqual(data(read(['items:', '  - |', '    first', '    second', '  - plain'].join('\n'))), { items: ['first\nsecond\n', 'plain'] });
  assert.deepEqual(data(read(['a:', '  b: |', '    deep', '  c: 2'].join('\n'))), { a: { b: 'deep\n', c: 2 } });
  fails('a: |x\n  text', /block scalar header/);
});

test('Comments, document markers, a byte order mark, carriage returns, and only the first document is read', () => {
  assert.deepEqual(data(read('# a comment\na: 1 # trailing\n\n# another\nb: 2\n')), { a: 1, b: 2 });
  assert.deepEqual(data(read('---\na: 1\n')), { a: 1 });
  assert.deepEqual(data(read('--- # note\na: 1\n')), { a: 1 });
  assert.deepEqual(data(read('--- text\n')), 'text');
  assert.deepEqual(data(read('a: 1\n---\nb: 2\n')), { a: 1 });
  assert.deepEqual(data(read('a: 1\n...\nignored: true\n')), { a: 1 });
  assert.deepEqual(data(read('%YAML 1.2\n---\na: 1\n')), { a: 1 });
  assert.deepEqual(data(read(`${String.fromCodePoint(0xfeff)}a: 1\n`)), { a: 1 });
  assert.deepEqual(data(read('a: 1\r\nb:\r\n  - x\r\n  - y\r\n')), { a: 1, b: ['x', 'y'] });
  assert.equal(read(''), null);
  assert.equal(read('# only a comment\n'), null);
  assert.equal(read('---\n'), null);
  // A marker after the first one ends the first document even when it had nothing in it: the second is not read, as for any other YAML reader.
  assert.equal(read('---\n---\nfoo: 1\n'), null);
  assert.equal(read('# note\n---\n# note\n---\nfoo: 1\n'), null);
});

test('A folded scalar keeps the line breaks that YAML keeps: a leading empty line, and the empty lines around a line that is indented more', () => {
  assert.deepEqual(data(read('x: >\n\n  folded\n  text here\ny: 1\n')), { x: '\nfolded text here\n', y: 1 });
  assert.deepEqual(data(read('x: >\n\n\n  a\n')), { x: '\n\na\n' });
  assert.deepEqual(data(read('x: >\n  a\n\n      c\n  b\n')), { x: 'a\n\n    c\nb\n' }, 'the break before the empty line is kept around a line that is indented more');
  assert.deepEqual(data(read('x: >\n  a\n    b\n\n  c\n')), { x: 'a\n  b\n\nc\n' });
  assert.deepEqual(data(read('x: >\n  a\n\n  b\n')), { x: 'a\nb\n' }, 'an empty line between two lines of the same indent is one line break');
  assert.deepEqual(data(read('x: |\n\n  lit\n')), { x: '\nlit\n' }, 'a literal one was right already');
});

test('A key that appears twice is counted and the last one wins; __proto__ is a key like any other and nothing has a prototype', () => {
  const twice = parseLooseYaml('a: 1\na: 2\nb: {c: 1, c: 3}');
  assert.ok(twice.ok);
  if (twice.ok) { assert.deepEqual(data(twice.value), { a: 2, b: { c: 3 } }); assert.equal(twice.duplicates, 2); }
  const proto = read('__proto__:\n  polluted: yes\nconstructor: {prototype: {x: 1}}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(proto), null);
  assert.deepEqual(Object.keys(proto), ['__proto__', 'constructor']);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  assert.equal(Object.getPrototypeOf((proto['__proto__'] as object)), null);
  const list = read('[{a: 1}]') as Record<string, unknown>[];
  assert.equal(Object.getPrototypeOf(list[0]), null);
});

test('What this reader does not read is refused with the reason and the place: anchors, aliases, tags, merge keys, complex keys, tabs, wrong indentation, open collections', () => {
  fails('a: &x 1\nb: *x', /anchors/, { line: 1, column: 4 });
  fails('a: *x', /aliases/);
  fails('a: !!str 1', /tags/);
  fails('a: [&x 1]', /anchors/);
  fails('a: [*x]', /aliases/);
  fails('base: {a: 1}\nb:\n  <<: {c: 1}', /merge keys/);
  fails('? a\n: b', /complex keys/);
  fails('a:\n\tb: 1', /tab/);
  fails('a: 1\n  b: 2', /indented more than the key/);
  fails('a:\n  b: 1\n  c: x\n    d: 2', /indented more than the key/);
  fails('a: -', /list item cannot follow a key/);
  fails('a:\n  b: 1\n c: 2', /indented differently|expected|indented/);
  fails('a: [1, 2', /never closed/);
  fails('a: {x: 1', /never closed/);
  fails('a: [1, 2}', /expected "," or "]"/);
  fails('a: {x: 1]', /expected "," or "}"/);
  fails('a: [,]', /missing before the comma/);
  fails('a: [[1]] x', /unexpected text after the end/);
  fails('- a\nb: 1', /(expected|key|indented)/);
  fails('a: - b', /list item cannot follow a key/);
  fails('a: %x', /cannot start with "%"/);
  fails(`a: ${String.fromCodePoint(1)}`, /control character/);
  fails('a: 1\nb 2', /expected "key: value"/, { line: 2, column: 1 });
});

test('The limits: the size of the text, the nesting of blocks and of flow collections, and the number of values', () => {
  const small = parseLooseYaml('a: 1\n'.repeat(10), { ...DEFAULT_LOOSE_LIMITS, maxChars: 20 });
  assert.equal(small.ok, false);
  if (!small.ok) assert.match(small.error.message, /larger than 20 characters/);
  const deepBlocks = Array.from({ length: 150 }, (_, level) => `${' '.repeat(level)}k${level}:`).join('\n');
  const blocks = parseLooseYaml(deepBlocks);
  assert.equal(blocks.ok, false);
  if (!blocks.ok) assert.match(blocks.error.message, /nested more than 100 levels/);
  const flow = parseLooseYaml(`a: ${'['.repeat(5000)}${']'.repeat(5000)}`);
  assert.equal(flow.ok, false);
  if (!flow.ok) assert.match(flow.error.message, /nested more than 100 levels/);
  const many = parseLooseYaml('- 1\n'.repeat(50), { ...DEFAULT_LOOSE_LIMITS, maxNodes: 40 });
  assert.equal(many.ok, false);
  if (!many.ok) assert.match(many.error.message, /more than 40 entries/);
  const manyFlow = parseLooseYaml(`a: [${'1,'.repeat(50)}]`, { ...DEFAULT_LOOSE_LIMITS, maxNodes: 40 });
  assert.equal(manyFlow.ok, false);
});

test('Hostile text is read in time that grows with its size: a million lines, an open quote over a hundred thousand lines, a collection that is never closed, a very long line', () => {
  const started = Date.now();
  const rows = parseLooseYaml('- item\n'.repeat(500_000));
  assert.ok(rows.ok);
  const quote = parseLooseYaml(`a: "open\n${'  more text\n'.repeat(100_000)}`);
  assert.equal(quote.ok, false);
  const open = parseLooseYaml(`a: [\n${'  1,\n'.repeat(100_000)}`);
  assert.equal(open.ok, false);
  const plain = parseLooseYaml(`a: start\n${'  continues\n'.repeat(100_000)}b: 1`);
  assert.ok(plain.ok);
  const long = parseLooseYaml(`a: ${'x'.repeat(2_000_000)}`);
  assert.ok(long.ok);
  const colons = parseLooseYaml(`a: ${'b: '.repeat(100_000)}`);
  assert.ok(colons.ok);
  const brackets = parseLooseYaml(`a: ${'[a, '.repeat(300_000)}`);
  assert.equal(brackets.ok, false);
  const folded = parseLooseYaml(`a: >\n${'  word\n'.repeat(200_000)}b: 1`);
  assert.ok(folded.ok);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
});

/** A small generator of values with a fixed seed, to compare the reader with JSON on what JSON can say. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

function generate(next: () => number, depth: number): unknown {
  const pick = Math.floor(next() * (depth > 3 ? 6 : 9));
  switch (pick) {
    case 0: return null;
    case 1: return next() < 0.5;
    case 2: return Math.floor(next() * 2000) - 1000;
    case 3: return Math.round(next() * 10000) / 100;
    case 4: return ['', 'a', 'hello world', 'x: y', '# not a comment', '- not a list', 'it\'s', 'say "hi"', 'tab\there', 'line\nbreak', E + 't' + E, '[x]', '{y}', 'null', 'true', '12', '1.5', '~'][Math.floor(next() * 18)];
    case 5: return `key${Math.floor(next() * 1000)}`;
    case 6: case 7: return Array.from({ length: Math.floor(next() * 4) }, () => generate(next, depth + 1));
    default: {
      const record: Record<string, unknown> = {};
      for (let index = Math.floor(next() * 4); index > 0; index--) record[`k${Math.floor(next() * 20)} ${depth}`] = generate(next, depth + 1);
      return record;
    }
  }
}

/** The values written as block YAML, with every string in double quotes (JSON strings are YAML strings). */
function block(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map(item => (typeof item === 'object' && item !== null && !(Array.isArray(item) && item.length === 0) && Object.keys(item).length > 0 ? `${pad}-\n${block(item, indent + 2)}` : `${pad}- ${scalar(item)}`)).join('\n');
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}{}`;
    return entries.map(([key, item]) => (typeof item === 'object' && item !== null && (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0) ? `${pad}${JSON.stringify(key)}:\n${block(item, indent + 2)}` : `${pad}${JSON.stringify(key)}: ${scalar(item)}`)).join('\n');
  }
  return `${pad}${scalar(value)}`;
}
const scalar = (value: unknown): string => (Array.isArray(value) ? '[]' : typeof value === 'object' && value !== null ? '{}' : JSON.stringify(value));

test('For what JSON can say, the reader agrees with JSON: written compact, pretty, as a block with quoted strings, and with the lines mixed', () => {
  const next = random(20261022);
  for (let round = 0; round < 400; round++) {
    const value = generate(next, 0);
    assert.deepEqual(data(read(JSON.stringify(value))), value, JSON.stringify(value));
    assert.deepEqual(data(read(JSON.stringify(value, null, 2))), value, JSON.stringify(value, null, 2));
    assert.deepEqual(data(read(JSON.stringify(value, null, '\t').replace(/\t/g, '    '))), value);
    const text = block(value, 0);
    assert.deepEqual(data(read(text)), value, text);
  }
});

test('An OpenAPI description as people write it is read as the JSON of it would be', () => {
  const text = [
    'openapi: "3.0.3"',
    'info:',
    '  title: Pet Store   # the name',
    '  description: >-',
    '    A store of pets.',
    '    It has a long description.',
    '  version: 1.0.0',
    'servers:',
    '  - url: https://{env}.example.com/v1',
    '    variables:',
    '      env: {default: api, enum: [api, staging]}',
    'paths:',
    '  /pets:',
    '    get:',
    '      operationId: listPets',
    '      parameters:',
    '        - $ref: "#/components/parameters/limit"',
    '      responses:',
    '        "200":',
    '          description: ok',
    '          content:',
    '            application/json:',
    '              schema:',
    '                type: array',
    '                items: {$ref: "#/components/schemas/Pet"}',
    'components:',
    '  schemas:',
    '    Pet:',
    '      type: object',
    '      required: [id, name]',
    '      properties:',
    '        id: {type: integer, format: int64, example: 10}',
    '        name: {type: string, example: doggie}',
    '  parameters:',
    '    limit:',
    '      name: limit',
    '      in: query',
    '      schema: {type: integer, default: 20}',
    ''
  ].join('\n');
  const value = data(read(text)) as { info: { description: string; title: string }; servers: unknown[]; paths: Record<string, unknown> };
  assert.equal(value.info.title, 'Pet Store');
  assert.equal(value.info.description, 'A store of pets. It has a long description.');
  assert.deepEqual(value.servers, [{ url: 'https://{env}.example.com/v1', variables: { env: { default: 'api', enum: ['api', 'staging'] } } }]);
  assert.deepEqual(Object.keys(value.paths), ['/pets']);
});
