import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlainVariable, neutralizeExpressions } from '../../src/convert/expressions';
import { importSource } from '../../src/import';
import { TARGETS } from '../../src/model/target';
import { file, random, req, source, v4 } from '../support/source';

const clean = (text: string) => neutralizeExpressions(text).text;

test('Plain variable names are left alone, with spaces, dashes and non-ASCII letters', () => {
  for (const text of ['{{base}}', '{{ base }}', '{{base-url}}', '{{my var}}', '{{token_2}}', '{{Dang nhap}}', 'a {{x}} b {{y}}', '{{}}', 'no variable', '{ {x} }']) {
    assert.deepEqual(neutralizeExpressions(text), { text, count: 0 }, text);
  }
  assert.equal(isPlainVariable(' x '), true);
});

test('Thunder dynamic variables are kept for the mapping of section 5.7', () => {
  for (const text of ['{{#guid}}', '{{#number}}', '{{#number, 1, 9}}', '{{ #date }}', '{{#enum, a, b}}']) assert.equal(neutralizeExpressions(text).count, 0, text);
});

test('Anything that could run, or read the machine, has its braces separated', () => {
  const cases: [string, string][] = [
    ["{{ require('fs').readFileSync('/etc/passwd') }}", "{ { require('fs').readFileSync('/etc/passwd') } }"],
    ['{{ process.env.SECRET }}', '{ { process.env.SECRET } }'],
    ['{{user.name}}', '{ {user.name} }'],
    ['{{$processEnv SECRET}}', '{ {$processEnv SECRET} }'],
    ['{{$dotenv KEY}}', '{ {$dotenv KEY} }'],
    ['{{$env.HOME}}', '{ {$env.HOME} }'],
    ['{{ 1 + 1 }}', '{ { 1 + 1 } }'],
    ['{{ a ? b : c }}', '{ { a ? b : c } }'],
    ['{{ x = 1 }}', '{ { x = 1 } }'],
    ['{{ `${a}` }}', '{ { `${a}` } }'],
    ['{{ a; b }}', '{ { a; b } }'],
    ['{{#number, require(1)}}', '{ {#number, require(1)} }'],
    ['{{ a[0] }}', '{ { a[0] } }'],
    ['a {{ f() }} b {{ok}} c {{ g() }}', 'a { { f() } } b {{ok}} c { { g() } }']
  ];
  for (const [input, expected] of cases) assert.equal(clean(input), expected, input);
  assert.equal(neutralizeExpressions('a {{ f() }} b {{ok}} c {{ g() }}').count, 2);
});

test('A {{ that is never closed is separated too: httpYac would start a script there', () => {
  assert.equal(clean('first {{ run(\nsecond'), 'first { { run(\nsecond');
  assert.equal(clean('{{ok}} then {{'), '{{ok}} then { {');
  assert.equal(neutralizeExpressions('{{ run(').count, 1);
});

test('Nested and stacked braces are handled until nothing is left that a tool would read as an expression', () => {
  assert.equal(clean('{{ a {{ b() }} }}'), '{ { a { { b() } } } }');
  assert.equal(clean('{{{ c() }}}'), '{ { { c() } } }');
  const deep = `${'{{ '.repeat(40)}x()${' }}'.repeat(40)}`;
  const result = clean(deep);
  assert.ok(!result.includes('{{'), 'no pair of braces is left');
});

test('The result is stable: neutralising a neutralised text changes nothing', () => {
  for (const text of ["{{ f() }} {{ok}} {{", '{{ a {{ b() }} }}', '{{$processEnv X}}', 'plain']) {
    const once = clean(text);
    assert.deepEqual(neutralizeExpressions(once), { text: once, count: 0 }, text);
  }
});

test('It is linear: a text of 200,000 braces and a thousand spans are done at once', () => {
  const started = performance.now();
  neutralizeExpressions('{{ f() }}'.repeat(20000));
  neutralizeExpressions('{'.repeat(200000));
  neutralizeExpressions('{{ '.repeat(5000));
  assert.ok(performance.now() - started < 2000);
});

// ---- P9: whatever the data holds, no output line has a {{ }} a tool would run ----

const PIECES = ['a', ' ', '{{', '}}', '{{{', '}}}', '{{x}}', '{{ y }}', "{{ require('fs') }}", '{{ f() }}', '{{$processEnv HOME}}', '{{$dotenv K}}', '{{a.b}}', '{{#guid}}', '{{#number, 1, 9}}', '{{#date, {y: 1}}}',
  '{{ `t` }}', '{{ 1 + 1 }}', '{', '}', '#', '$', '(', ')', ';', "'", '"', '\n', '%', '='];
const text = (rand: () => number): string => Array.from({ length: 1 + Math.floor(rand() * 6) }, () => PIECES[Math.floor(rand() * PIECES.length)] ?? '').join('');

/** Written apart from the code under test. Every `{{` of the output must be closed, and what is inside must be harmless. */
function problems(output: string): string[] {
  const found: string[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('#')) continue; // comments are not run
    let from = 0;
    for (;;) {
      const open = line.indexOf('{{', from);
      if (open === -1) break;
      const close = line.indexOf('}}', open + 2);
      if (close === -1) { found.push(`unclosed: ${line}`); break; }
      const inner = line.slice(open + 2, close);
      const allowed = /^[^.(){}[\];=+*/\\'"`<>!|&^%~?,:$#@]*$/.test(inner) || /^\$guid$/.test(inner) || /^\$randomInt -?\d+ -?\d+$/.test(inner) || /^\$(?:uuid|isoTimestamp|timestamp|datetime iso8601)$/.test(inner) || /^\$random\.integer\(-?\d+, -?\d+\)$/.test(inner) || /^\s*#[A-Za-z]+(?:\s*,\s*[-\w. ]*)*\s*$/.test(inner);
      if (!allowed) found.push(`{{${inner}}}`);
      from = close + 2;
    }
  }
  return found;
}

test('P9: random text with braces in every place a value can come from leaves nothing a tool would run', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rand = random(seed);
    const request = req(text(rand), '', {
      url: text(rand), params: [{ name: text(rand), value: text(rand) }], headers: [{ name: text(rand), value: text(rand) }, { name: 'X-Ok', value: text(rand), isDisabled: true }],
      auth: rand() < 0.5 ? { type: 'bearer', bearer: text(rand) } : { type: 'basic', basic: { username: text(rand), password: text(rand) } },
      body: rand() < 0.3 ? { type: 'text', raw: text(rand) } : rand() < 0.5 ? { type: 'formencoded', form: [{ name: text(rand), value: text(rand) }] } : { type: 'graphql', graphql: { query: text(rand), variables: text(rand) } },
      tests: [{ type: 'json-query', custom: `json.${text(rand)}`, action: 'equal', value: text(rand) }, { type: 'set-env-var', custom: 'json.a', action: 'setto', value: text(rand) }]
    });
    const result = importSource(source(
      file('collections/tc_col_a.json', 'v4-collection', v4('C', [], [request], { settings: { options: { baseUrl: text(rand) }, headers: [{ name: text(rand), value: text(rand) }] } })),
      file('environments/tc_env_a.json', 'v4-environment', { _id: 'e', name: 'dev', data: [{ name: 'v', value: text(rand) }, { name: 'w', value: text(rand) }] })
    ), { target: TARGETS[seed % TARGETS.length] ?? 'rest-client' });
    for (const output of result.files) {
      if (output.path === 'IMPORT_REPORT.md') continue;
      const bad = output.path.endsWith('.json') ? problems(Object.values(JSON.parse(output.content) as Record<string, Record<string, string>>).flatMap(vars => Object.values(vars)).join('\n')) : problems(output.content);
      assert.deepEqual(bad, [], `seed ${seed}: ${output.path}`);
    }
  }
});

// ---- the single-pass variableSpans must find what the plain scan from each `{{` finds ----

function referenceSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x7b && text.charCodeAt(i + 1) === 0x7b) {
      let depth = 2;
      let j = i + 2;
      for (; j < text.length && depth > 0; j++) {
        const code = text.charCodeAt(j);
        if (code === 0x7b) depth++;
        else if (code === 0x7d) depth--;
      }
      if (depth === 0) { spans.push([i, j]); i = j; continue; }
    }
    i++;
  }
  return spans;
}

test('variableSpans: the linear version gives the same spans as the plain scan, on 3,000 random brace strings', async () => {
  const { variableSpans } = await import('../../src/convert/text');
  for (let seed = 1; seed <= 3000; seed++) {
    const rand = random(seed);
    const t = Array.from({ length: Math.floor(rand() * 24) }, () => '{}ab '[Math.floor(rand() * 5)]).join('');
    assert.deepEqual(variableSpans(t), referenceSpans(t), JSON.stringify(t));
  }
});
