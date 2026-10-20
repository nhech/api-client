import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertTests, toJsonPath } from '../../src/convert/tests';
import { Coercions } from '../../src/normalize/coerce';

const convert = (...tests: object[]) => convertTests(tests as never, new Coercions());
const t = (type: string, action: string, value: unknown = '', custom = '') => ({ type, action, value, custom });

test('JSONPath: the json. prefix is replaced by $, keys that are not identifiers go in brackets', () => {
  assert.deepEqual(toJsonPath('json.access_token'), { path: '$.access_token', guessed: false });
  assert.equal(toJsonPath('json.data.items[0].id').path, '$.data.items[0].id');
  assert.equal(toJsonPath('json').path, '$');
  assert.equal(toJsonPath('json[0].id').path, '$[0].id');
  assert.equal(toJsonPath('json.items.0.id').path, '$.items[0].id');
  assert.equal(toJsonPath('json.items.*.id').path, '$.items[*].id');
  assert.equal(toJsonPath('json.my-key.other key').path, "$['my-key']['other key']");
  assert.equal(toJsonPath("json.it's").path, "$['it\\'s']");
  assert.equal(toJsonPath("json.a['b.c'].d").path, "$.a['b.c'].d", 'a bracket group is kept as written, dots inside included');
  assert.equal(toJsonPath('json.a[0][1]').path, '$.a[0][1]');
  assert.equal(toJsonPath('json.').path, '$');
  assert.equal(toJsonPath('  json.x  ').path, '$.x');
});

test('JSONPath: a query that already starts with $ is kept; one with no prefix is read as a path and called a guess', () => {
  assert.deepEqual(toJsonPath('$.a.b'), { path: '$.a.b', guessed: false });
  assert.deepEqual(toJsonPath('data.id'), { path: '$.data.id', guessed: true });
  assert.deepEqual(toJsonPath('jsonish.x'), { path: '$.jsonish.x', guessed: true }, 'only "json" followed by "." or "[" is the prefix');
  assert.equal(toJsonPath('json.a[').path, '$.a[', 'an unclosed bracket does not hang or throw');
});

test('Status, time, body and header tests become assertions with the operators of the grammar', () => {
  const result = convert(
    t('res-code', 'equal', '200'), t('res-code', 'notequal', 404), t('res-code', '>=', '200'), t('res-code', 'contains', '20'),
    t('res-time', '<', '500'), t('res-time', 'contains', 'x'),
    t('res-body', 'contains', 'token'), t('res-body', 'notcontains', 'error'), t('res-body', 'regex', '^ok'), t('res-body', 'equal', 'ok'), t('res-body', 'isjson'), t('res-body', '<', '5'), t('res-body', 'schema', '{}'),
    t('Content-Type', 'equal', 'application/json'), t('Content-Length', '<', '1000'), t('Content-Encoding', 'contains', 'gzip'), t('custom-header', 'equal', 'yes', 'X-Flag'), t('custom-header', 'equal', 'yes', '')
  );
  assert.deepEqual(result.assertions.map(a => `${a.target}${a.name ? ' ' + a.name : ''} ${a.op}${a.expected === '' ? '' : ' ' + a.expected}`), [
    'status == 200', 'status != 404', 'status >= 200', 'status includes 20',
    'time < 500',
    'body includes token', 'body excludes error', 'body matches ^ok', 'body == ok', 'body isJson',
    'header Content-Type == application/json', 'header Content-Length < 1000', 'header Content-Encoding includes gzip', 'header X-Flag == yes'
  ]);
  assert.deepEqual(result.unsupported, ['res-time | contains', 'res-body | <', 'res-body | schema', 'custom-header | equal']);
});

test('JSON query tests: comparisons, text tests, count and type', () => {
  const result = convert(
    t('json-query', 'equal', '1', 'json.id'), t('json-query', 'contains', 'x', 'json.name'), t('json-query', 'count', '3', 'json.items'),
    t('json-query', 'istype', 'String', 'json.name'), t('json-query', 'istype', 'array', 'json.items'), t('json-query', 'istype', 'object', 'json.o'),
    t('json-query', 'schema', '{}', 'json.o'), t('json-query', 'equal', '1', ''), t('json-query', '>', '0', 'total')
  );
  assert.deepEqual(result.assertions.map(a => `${a.name} ${a.op}${a.expected === '' ? '' : ' ' + a.expected}`), ['$.id == 1', '$.name includes x', '$.items count == 3', '$.name isString', '$.items isArray', '$.total > 0']);
  assert.deepEqual(result.unsupported, ['json-query | istype', 'json-query | schema', 'json-query | equal']);
  assert.equal(result.jsonPathGuesses, 1);
});

test('A set-env-var test is a capture: its source and its target variable with an optional scope', () => {
  const result = convert(
    t('set-env-var', 'setto', '{{access_token}}', 'json.access_token'), t('set-env-var', 'setto', '{{tok, local}}', 'header.X-Token'), t('set-env-var', 'setto', '{{c, global}}', 'cookie.session'),
    t('set-env-var', 'setto', '{{whole}}', 'text'), t('set-env-var', 'setto', '{{state}}', 'processing'), t('set-env-var', 'setto', '{{gone}}', 'null'), t('set-env-var', 'setto', '{{gone2}}', 'delete'),
    t('set-env-var', 'setto', '{{ spaced , local }}', 'json.a')
  );
  assert.deepEqual(result.captures.map(c => `${c.scope}:${c.variable} = ${c.source}`), [
    'active:access_token = json $.access_token', 'local:tok = header X-Token', 'global:c = cookie session', 'active:whole = body', 'active:state = value processing', 'active:gone = null', 'active:gone2 = delete', 'local:spaced = json $.a'
  ]);
  assert.deepEqual(result.assertions, []);
});

test('A capture that cannot be said in the grammar is unsupported', () => {
  const result = convert(
    t('set-env-var', 'equal', '{{x}}', 'json.a'), t('set-env-var', 'setto', 'x', 'json.a'), t('set-env-var', 'setto', '{{}}', 'json.a'), t('set-env-var', 'setto', '{{a b}}', 'json.a'),
    t('set-env-var', 'setto', '{{a=b}}', 'json.a'), t('set-env-var', 'setto', '{{x}}', ''), t('set-env-var', 'setto', '{{x}}', 'header.'), t('set-env-var', 'setto', '{{x, other}}', 'json.a')
  );
  assert.equal(result.captures.length, 1, 'only the header. one falls to a literal value');
  assert.equal(result.captures[0]?.source, 'value header.');
  assert.equal(result.unsupported.length, 6 + 0 + 1);
});

test('Unknown types are unsupported and named without showing anything odd; entries that are not objects are skipped', () => {
  const result = convert(t('mystery', 'equal'), t('x'.repeat(50) + '\nboom', 'y y'), null as never, 'text' as never, t('res-code', 'unknown'));
  assert.deepEqual(result.unsupported, ['mystery | equal', '<other> | <other>', 'res-code | unknown']);
});

test('A test with a number as its value is read as text', () => {
  const coerce = new Coercions();
  const result = convertTests([t('res-code', 'equal', 200)] as never, coerce);
  assert.equal(result.assertions[0]?.expected, '200');
  assert.equal(coerce.count, 1);
});
