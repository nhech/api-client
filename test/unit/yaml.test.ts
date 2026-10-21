import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_YAML_LIMITS, emitYaml, parseYaml, type YValue } from '../../src/format/yaml';

/** A value as nested plain data that keeps the order of the keys, so that deepEqual compares order too. */
const plain = (value: YValue): unknown => (typeof value === 'string' ? value : Array.isArray(value) ? value.map(plain) : { map: [...value].map(([key, item]) => [key, plain(item)]) });
const parse = (text: string): YValue => {
  const result = parseYaml(text);
  assert.ok(result.ok, result.ok ? '' : `${result.error.line}:${result.error.column} ${result.error.message}`);
  return result.value;
};
const fails = (text: string, pattern: RegExp, at?: { line: number; column: number }) => {
  const result = parseYaml(text);
  assert.equal(result.ok, false, `expected an error for ${JSON.stringify(text.slice(0, 60))}`);
  if (!result.ok) {
    assert.match(result.error.message, pattern);
    if (at) assert.deepEqual({ line: result.error.line, column: result.error.column }, at);
  }
};

test('A request file in the canonical form is read, and written back unchanged', () => {
  const text = [
    'schema: 1',
    'id: 01J9Z4V0N2XK7Q3M8T5R6Y1ABC',
    'name: List pets',
    'method: GET',
    "url: '{{baseUrl}}/pets'",
    'query:',
    '  - name: limit',
    '    value: 10',
    '  - name: sort',
    '    value: name',
    '    enabled: false',
    'headers: []',
    'auth:',
    '  kind: bearer',
    "  token: '{{token}}'",
    'body:',
    '  kind: json',
    '  text: |-',
    '    {',
    '      "name": "Rex"',
    '    }',
    'tests:',
    '  - status == 200',
    ''
  ].join('\n');
  const value = parse(text);
  assert.deepEqual(plain(value), {
    map: [
      ['schema', '1'], ['id', '01J9Z4V0N2XK7Q3M8T5R6Y1ABC'], ['name', 'List pets'], ['method', 'GET'], ['url', '{{baseUrl}}/pets'],
      ['query', [{ map: [['name', 'limit'], ['value', '10']] }, { map: [['name', 'sort'], ['value', 'name'], ['enabled', 'false']] }]],
      ['headers', []], ['auth', { map: [['kind', 'bearer'], ['token', '{{token}}']] }],
      ['body', { map: [['kind', 'json'], ['text', '{\n  "name": "Rex"\n}']] }], ['tests', ['status == 200']]
    ]
  });
  assert.equal(emitYaml(value), text);
});

test('Scalars: plain, single quoted, double quoted with escapes, empty, and every value is a string', () => {
  const value = parse([
    'a: plain text',
    "b: 'it''s quoted'",
    'c: "tab\\there \\u00e9 \\x41 \\U0001F600 \\"q\\" \\\\"',
    "d: ''",
    'e:',
    'f: true',
    'g: 007',
    'h: null',
    'i: a#b',
    'j: plain # a comment',
    'k: "quoted" # a comment',
    "'quoted key': v",
    ''
  ].join('\n'));
  assert.deepEqual(plain(value), {
    map: [['a', 'plain text'], ['b', "it's quoted"], ['c', 'tab\there \u00e9 A \u{1F600} "q" \\'], ['d', ''], ['e', ''], ['f', 'true'], ['g', '007'], ['h', 'null'], ['i', 'a#b'], ['j', 'plain'], ['k', 'quoted'], ['quoted key', 'v']]
  });
});

test('Block scalars keep their line breaks as the header says: | clips, |- strips, |+ keeps', () => {
  const value = parse(['clip: |', '  one', '', '  two', 'strip: |-', '  one', 'keep: |+', '  one', '', 'after: x', ''].join('\n'));
  assert.deepEqual(plain(value), { map: [['clip', 'one\n\ntwo\n'], ['strip', 'one'], ['keep', 'one\n\n'], ['after', 'x']] });
  // Indentation beyond the block's own indentation is content, and so are lines that look like comments or keys.
  assert.deepEqual(plain(parse('a: |-\n  x\n    y\n  # not a comment\n  k: v\n')), { map: [['a', 'x\n  y\n# not a comment\nk: v']] });
});

test('Empty collections, a list under its key at the same indentation, comments and a Windows file with a byte order mark', () => {
  assert.deepEqual(plain(parse('a: []\nb: {}\n')), { map: [['a', []], ['b', { map: [] }]] });
  assert.deepEqual(plain(parse('list:\n- one\n- two\nnext: x\n')), { map: [['list', ['one', 'two']], ['next', 'x']] });
  assert.deepEqual(plain(parse('# top\na: 1 # trailing\n\n  # indented comment\nb: 2\n')), { map: [['a', '1'], ['b', '2']] });
  assert.deepEqual(plain(parse('\ufeffa: 1\r\nb:\r\n  - x\r\n')), { map: [['a', '1'], ['b', ['x']]] });
  assert.deepEqual(plain(parse('')), { map: [] });
  assert.deepEqual(plain(parse('# only a comment\n')), { map: [] });
  assert.deepEqual(plain(parse('{}\n')), { map: [] });
  assert.deepEqual(plain(parse('- a\n- b\n')), ['a', 'b']);
});

test('A list item can be a mapping that starts on the dash line, or a nested block under a bare dash', () => {
  assert.deepEqual(plain(parse('- a: 1\n  b: 2\n-\n  c: 3\n- plain\n- k: v\n')), [{ map: [['a', '1'], ['b', '2']] }, { map: [['c', '3']] }, 'plain', { map: [['k', 'v']] }]);
  assert.deepEqual(plain(parse('items:\n  -   a: 1\n      b: 2\n')), { map: [['items', [{ map: [['a', '1'], ['b', '2']] }]]] });
});

test('Everything the subset leaves out is refused with the line and the column', () => {
  fails('a: &anchor x\n', /anchors/, { line: 1, column: 4 });
  fails('a: *alias\n', /aliases/, { line: 1, column: 4 });
  fails('a: !!str x\n', /tags/, { line: 1, column: 4 });
  fails('a: [1, 2]\n', /flow collections/, { line: 1, column: 4 });
  fails('a: {b: 1}\n', /flow collections/, { line: 1, column: 4 });
  fails('a: >\n  folded\n', /folded/, { line: 1, column: 4 });
  fails('a: |2\n  x\n', /block scalars/);
  fails('---\na: 1\n', /document markers/, { line: 1, column: 1 });
  fails('a: 1\n...\n', /document markers/, { line: 2, column: 1 });
  fails('%YAML 1.2\na: 1\n', /expected "key: value"|cannot start/);
  fails('a: 1\na: 2\n', /appears twice/, { line: 2, column: 1 });
  fails('a:\n\tb: 1\n', /tab cannot indent/, { line: 2, column: 1 });
  fails('a: one: two\n', /": "/);
  fails('a: "unterminated\n', /same line/);
  fails("a: 'unterminated\n", /same line/);
  fails('a: "x" y\n', /unexpected text after the closing quote/);
  fails('a: "\\q"\n', /unsupported escape/);
  fails('a: "\\u12"\n', /unsupported escape/);
  fails('a: "\\U00110000"\n', /above U\+10FFFF/);
  fails('a: x\u0001y\n', /control character/, { line: 1, column: 5 });
  fails('a: x\u2028y\n', /control character/);
  fails('a: x\ry\n', /carriage return/);
  fails('a: - b\n', /same line/);
  fails('- - a\n', /list inside a list/);
  fails('a: 1\n  b: 2\n', /indented more/, { line: 2, column: 3 });
  fails('a: 1\n- b\n', /list item where a key was expected/);
  fails('  a: 1\n', /left margin/);
  fails('just text\n', /expected "key: value"/);
  fails('a: 1\n b\n', /indented more than the key|expected/);
});

test('The limits on size, nesting and number of nodes are enforced', () => {
  const small = { maxBytes: 20, maxDepth: 3, maxNodes: 4 };
  assert.equal(parseYaml('a: 1\n', small).ok, true);
  assert.equal(parseYaml('a: 1234567890123456789012345\n', small).ok, false);
  assert.match((parseYaml('a: 1234567890123456789012345\n', small) as { error: { message: string } }).error.message, /larger than 20 bytes/);
  assert.equal(parseYaml('a:\n  b:\n    c: 1\n', { ...small, maxBytes: 100 }).ok, true);
  assert.match((parseYaml('a:\n  b:\n    c:\n      d: 1\n', { ...small, maxBytes: 100 }) as { error: { message: string } }).error.message, /nested more than 3 levels/);
  assert.match((parseYaml('a: 1\nb: 2\nc: 3\nd: 4\ne: 5\n', { ...small, maxBytes: 100 }) as { error: { message: string } }).error.message, /more than 4 entries/);
  // Multi-byte text counts in bytes: 4 + 3 * 3 bytes is over a limit of 12.
  assert.equal(parseYaml('a: \u20ac\u20ac\u20ac\n', { ...small, maxBytes: 12 }).ok, false);
});

test('Hostile input takes time proportional to its size and never overflows the stack (1 MiB cases)', () => {
  const time = (text: string) => {
    const started = performance.now();
    const result = parseYaml(text);
    return { ok: result.ok, ms: performance.now() - started };
  };
  const cases: Record<string, string> = {
    'a very deep list of keys': Array.from({ length: 20_000 }, (_, level) => `${' '.repeat(level % 1000)}k:`).join('\n'),
    'deep indentation': `${'a:\n'}${' '.repeat(500)}b: 1\n`.repeat(300),
    'one huge plain line': `a: ${'x'.repeat(1 << 20)}\n`,
    'one huge double quoted line with escapes': `a: "${'\\n'.repeat(1 << 19)}"\n`,
    'many short entries': Array.from({ length: 60_000 }, (_, index) => `k${index}: v`).join('\n'),
    'many list items': Array.from({ length: 100_000 }, () => '- x').join('\n'),
    'a huge block scalar': `a: |-\n${'  line of text\n'.repeat(70_000)}`,
    'colons and hashes': `a: ${': # '.repeat(300_000)}\n`,
    'spaces only': ' '.repeat(1 << 20),
    'dashes': '- '.repeat(500_000)
  };
  for (const [name, text] of Object.entries(cases)) {
    const outcome = time(text);
    assert.ok(outcome.ms < 2000, `${name}: ${outcome.ms.toFixed(0)} ms`);
  }
  // 100,000 plain entries are inside the default limits and read in full.
  assert.equal(parseYaml(Array.from({ length: 40_000 }, (_, index) => `k${index}: v`).join('\n')).ok, true);
  assert.equal(DEFAULT_YAML_LIMITS.maxNodes, 100_000);
});

test('Text is written so that every string comes back: quoting, escapes, blocks and the strings that look like other things', () => {
  const strings = [
    '', ' ', 'plain', 'with space', 'trailing ', ' leading', 'a: b', 'a #b', 'a#b', '#start', '- dash', '-', '?', '{{var}}', '{{a}}/{{b}}', '[x]', '*star', '&amp', '!tag', '|pipe', '>gt', '%pc', '@at', '`tick',
    "it's", 'say "hi"', 'back\\slash', 'true', 'False', 'null', '~', 'yes', 'no', '10', '1e3', '0x1F', '.5', '+1', '-1', '2024-01-01', 'a\tb', 'a\nb', 'a\nb\n', 'a\nb\n\n\n', '\nfirst empty', ' first space\nb', 'a \nb', 'a\n \nb', 'a\r\nb',
    '\u00e9\u00e8 d\u1ea5u ti\u1ebfng Vi\u1ec7t', '\u{1F600}', 'a\u200bb', 'a\u202eb', 'a\u2028b', 'a\ufeffb', 'a\u0000b', 'a\u007fb', 'lone \ud800 surrogate', 'pair \ud83d\ude00 ok', 'x:', 'x: ', ': y', 'https://example.com/a?b=c#d', '127.0.0.1:8080', 'multi\nline: with colon\n  and indent\n\ttab'
  ];
  for (const text of strings) {
    const document = new Map<string, YValue>([['k', text], ['list', [text, new Map([['v', text]])]], ['nested', new Map([['v', text]])]]);
    const written = emitYaml(document);
    const back = parseYaml(written);
    assert.ok(back.ok, `${JSON.stringify(text)}: ${back.ok ? '' : back.error.message}\n${written}`);
    if (back.ok) {
      assert.deepEqual(plain(back.value), plain(document), JSON.stringify(text));
      assert.equal(emitYaml(back.value), written, `writing again changed ${JSON.stringify(text)}`);
    }
  }
});

test('Written text holds no hidden or direction-changing character: they are escaped so that a reader sees them', () => {
  const written = emitYaml(new Map<string, YValue>([['a', 'x\u202ey'], ['b', 'x\u200by'], ['c', 'x\u2028y'], ['d', 'x\u0000y'], ['e', 'x\ufeffy'], ['f', 'x\ud800y']]));
  assert.ok(/^[\x20-\x7e\n]*$/.test(written), JSON.stringify(written));
  assert.match(written, /a: "x\\u202ey"/);
  assert.match(written, /d: "x\\0y"/);
  assert.match(written, /f: "x\\ud800y"/);
});

test('The shape of the written text: indentation, empty collections, keys that need quotes, block headers', () => {
  const document = new Map<string, YValue>([
    ['empty', ''], ['list', []], ['map', new Map()], ['Content-Type', 'application/json'], ['two words', 'x'], ['true', 'x'], ['1', 'x'],
    ['strip', 'a\nb'], ['clip', 'a\nb\n'], ['keep', 'a\nb\n\n'], ['single', 'one line'], ['nested', new Map<string, YValue>([['inner', new Map([['deep', ['a', 'b']]])]])]
  ]);
  assert.equal(emitYaml(document), [
    "empty: ''", 'list: []', 'map: {}', 'Content-Type: application/json', 'two words: x', 'true: x', '1: x',
    'strip: |-', '  a', '  b', 'clip: |', '  a', '  b', 'keep: |+', '  a', '  b', '', 'single: one line',
    'nested:', '  inner:', '    deep:', '      - a', '      - b', ''
  ].join('\n'));
  assert.equal(emitYaml(new Map()), '{}\n');
  assert.equal(emitYaml([]), '[]\n');
  assert.throws(() => emitYaml('text'), /root/);
  assert.throws(() => emitYaml([['a']] as unknown as YValue), /list inside a list/);
});

test('A key called __proto__ is a key like any other and changes nothing', () => {
  const value = parse('__proto__: x\nconstructor: y\n');
  assert.deepEqual(plain(value), { map: [['__proto__', 'x'], ['constructor', 'y']] });
  assert.equal(({} as Record<string, unknown>)['x'], undefined);
  assert.equal(emitYaml(value), "__proto__: x\nconstructor: 'y'\n");
});

test('The map keeps its keys in file order, including keys that look like numbers', () => {
  const value = parse("'10': a\n'2': b\nz: c\n'1': d\n");
  assert.deepEqual([...(value as Map<string, YValue>).keys()], ['10', '2', 'z', '1']);
  assert.equal(emitYaml(value), '10: a\n2: b\nz: c\n1: d\n');
});

test('A block scalar header with nothing indented under it is an empty string, and the next key is not swallowed', () => {
  assert.deepEqual(plain(parse('a: |-\nb: 1\n')), { map: [['a', ''], ['b', '1']] });
  assert.deepEqual(plain(parse('a: |\n\n\nb: 1\n')), { map: [['a', ''], ['b', '1']] });
});

test('Strings another YAML reader would take for another type are quoted; true, false and whole numbers stay plain', () => {
  const written = emitYaml(new Map<string, YValue>([
    ['null', 'null'], ['date', '2024-01-01'], ['float', '1.5'], ['hex', '0x1F'], ['clock', '12:30'], ['yes', 'Yes'],
    ['bool', 'true'], ['int', '42'], ['cap', 'True'], ['big', '12345678901234567890'], ['word', 'null value'], ['url', 'https://example.com/a?b=c']
  ]));
  assert.equal(written, [
    "'null': 'null'", "date: '2024-01-01'", "float: '1.5'", "hex: '0x1F'", "clock: '12:30'", "'yes': 'Yes'",
    'bool: true', 'int: 42', "cap: 'True'", "big: '12345678901234567890'", 'word: null value', 'url: https://example.com/a?b=c', ''
  ].join('\n'));
});
