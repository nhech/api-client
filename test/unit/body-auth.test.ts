import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertAuth } from '../../src/convert/auth';
import { convertBody, leavesFolder, MULTIPART_BOUNDARY, token } from '../../src/convert/body';
import { classifyVariables, graphqlBodyText } from '../../src/convert/graphql';
import { mapSystemVariables } from '../../src/convert/sysvars';
import { Coercions } from '../../src/normalize/coerce';

const body = (value: unknown) => convertBody(value, new Coercions());

test('A text body is the raw text with the Content-Type Thunder would send; an empty one is no body', () => {
  assert.deepEqual(body({ type: 'json', raw: '{"a":1}' }), { body: { kind: 'text', contentType: 'application/json', text: '{"a":1}' }, contentType: 'application/json', notes: [], issues: [] });
  assert.equal(body({ type: 'json', raw: ['{', '  "a": 1', '}'] }).body?.kind === 'text' && (body({ type: 'json', raw: ['{', '  "a": 1', '}'] }).body as { text: string }).text, '{\n  "a": 1\n}');
  assert.equal(body({ type: 'text', raw: 'x' }).contentType, 'text/plain');
  assert.equal(body({ type: 'xml', raw: '<a/>' }).contentType, 'application/xml');
  for (const empty of [{ type: 'json', raw: '' }, { type: 'json', raw: '  \n' }, { type: 'json' }, { type: 'none', raw: 'x' }, { raw: 'x' }, {}, null, 'x', undefined]) assert.equal(body(empty).body, undefined, JSON.stringify(empty));
});

test('A form-encoded body keeps its fields, enabled or not, and the Content-Type of a form', () => {
  const result = body({ type: 'formencoded', form: [{ name: 'a', value: '1' }, { name: 'b', value: '2', isDisabled: true }, { name: '', value: 'skip' }, { name: 'c' }] });
  assert.deepEqual(result.body, { kind: 'form', fields: [{ name: 'a', value: '1', enabled: true }, { name: 'b', value: '2', enabled: false }, { name: 'c', value: '', enabled: true }] });
  assert.equal(result.contentType, 'application/x-www-form-urlencoded');
  assert.equal(body({ type: 'formencoded', form: [] }).body, undefined);
});

test('A multipart body has text parts and file parts, the boundary is fixed, and a file path that leaves the folder is reported', () => {
  const result = body({ type: 'formdata', form: [{ name: 'note', value: 'hi' }, { name: 'off', value: 'x', isDisabled: true }, { name: 'attached', value: './a.pdf', isFile: true }], files: [{ name: 'doc', value: '/etc/hosts' }, { name: 'rel', value: 'dir/b.bin' }] });
  assert.deepEqual(result.body, { kind: 'multipart', parts: [
    { name: 'note', value: 'hi', enabled: true }, { name: 'off', value: 'x', enabled: false }, { name: 'attached', filePath: './a.pdf', enabled: true },
    { name: 'doc', filePath: '/etc/hosts', enabled: true }, { name: 'rel', filePath: 'dir/b.bin', enabled: true }
  ] });
  assert.equal(result.contentType, `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`);
  assert.deepEqual(result.issues, [{ code: 'TC-FILE-PATH' }]);
});

test('A file path leaves the folder when it is absolute, on a drive, in the home folder, or goes up', () => {
  for (const path of ['/abs', '\\\\server\\share', 'C:\\x', 'c:/x', '~/x', '../x', 'a/../../x', 'a\\..\\x', '..']) assert.equal(leavesFolder(path), true, path);
  for (const path of ['./x', 'x', 'dir/x', 'a..b', 'dir/..x', 'file.name..ext']) assert.equal(leavesFolder(path), false, path);
});

test('A GraphQL body needs a query; variables are sorted into four cases', () => {
  assert.equal(body({ type: 'graphql', graphql: { query: '' } }).body, undefined);
  const plain = body({ type: 'graphql', graphql: { query: '{ me { id } }', variables: '{"id": 1}' } });
  assert.deepEqual(plain.body, { kind: 'graphql', query: '{ me { id } }', variables: '{"id": 1}' });
  assert.equal(plain.contentType, 'application/json');
  assert.deepEqual(plain.issues, []);
  assert.deepEqual(body({ type: 'graphql', graphql: { query: 'q', variables: ['{"id":', '  {{id}}', '}'] } }).issues, [], 'invalid only because of a variable: fine');
  assert.deepEqual(body({ type: 'graphql', graphql: { query: 'q', variables: 'not json' } }).issues, [{ code: 'TC-GRAPHQL-VARS' }]);
  assert.equal((body({ type: 'graphql', graphql: { query: 'q' } }).body as { variables?: string }).variables, undefined);
});

test('GraphQL variables: none, JSON, an object with variables inside, or text', () => {
  assert.deepEqual(['', ' ', '{"a":1}', '[1]', '5', '{"a": {{x}} }', 'plain', '{ broken', '{{x}}'].map(classifyVariables), ['none', 'none', 'json', 'text', 'text', 'raw-object', 'text', 'text', 'raw-object']);
  assert.equal(graphqlBodyText('{ a }', ''), '{\n  "query": "{ a }"\n}');
  assert.equal(graphqlBodyText('{ a }', '{"id":1}'), '{\n  "query": "{ a }",\n  "variables": {\n    "id": 1\n  }\n}');
  assert.equal(graphqlBodyText('{ a }', '{"id": {{x}}}'), '{\n  "query": "{ a }",\n  "variables": {"id": {{x}}}\n}');
  assert.equal(graphqlBodyText('{ a }', 'text'), '{\n  "query": "{ a }",\n  "variables": "text"\n}');
  assert.equal(JSON.parse(graphqlBodyText('line1\nline2 "q"', '{"a":1}') ).query, 'line1\nline2 "q"');
});

test('A body that cannot be converted is left out, with a comment and a finding naming only its type', () => {
  const result = body({ type: 'binary', raw: 'x' });
  assert.deepEqual([result.body, result.notes, result.issues.map(i => i.code)], [undefined, ['[body not imported: binary]'], ['TC-BODY-UNSUPPORTED']]);
  assert.deepEqual(body({ type: 'yaml-or-whatever' }).notes, ['[body not imported: yaml-or-whatever]']);
  assert.deepEqual(body({ type: 'a'.repeat(40) + '\nboom' }).notes, ['[body not imported: <other>]'], 'an odd type is never shown');
  assert.equal(token('x y'), '<other>');
});

test('A body of the wrong type counts the coercions', () => {
  const coerce = new Coercions();
  convertBody({ type: 'formencoded', form: [{ name: 5, value: false }] }, coerce);
  assert.ok(coerce.count >= 2);
});

const auth = (value: unknown) => convertAuth(value as never, new Coercions());

test('Bearer and basic become authentication; nothing, "none" and "inherit" become none', () => {
  assert.deepEqual(auth({ type: 'bearer', bearer: 'tok' }).auth, { kind: 'bearer', token: { value: 'tok', secret: false } });
  assert.equal(auth({ type: 'bearer', bearer: 'Bearer tok' }).auth?.kind === 'bearer' && (auth({ type: 'bearer', bearer: 'Bearer tok' }).auth as { token: { value: string } }).token.value, 'tok');
  assert.deepEqual(auth({ type: 'basic', basic: { username: 'u', password: 'p' } }).auth, { kind: 'basic', username: { value: 'u', secret: false }, password: { value: 'p', secret: false } });
  for (const none of [undefined, null, {}, { type: '' }, { type: 'none' }, { type: 'inherit' }, { type: 'bearer' }, { type: 'bearer', bearer: '  ' }, { type: 'basic' }, { type: 'basic', basic: {} }]) {
    assert.deepEqual(auth(none), { auth: undefined, note: undefined, issue: undefined }, JSON.stringify(none));
  }
});

test('OAuth 2.0 and the other types are not guessed: a comment with the names of the settings, never their values', () => {
  const oauth = auth({ type: 'oauth2', oauth2: { grantType: 'client_credentials', clientSecret: 'SECRET-VALUE', tokenUrl: 'https://x', 'weird key!': 1 } });
  assert.deepEqual(oauth.auth, { kind: 'unsupported', type: 'oauth2' });
  assert.equal(oauth.note, '[auth oauth2 not imported; settings: clientSecret, grantType, tokenUrl]');
  assert.deepEqual(oauth.issue, { code: 'TC-AUTH-OAUTH2' });
  assert.ok(!JSON.stringify(oauth).includes('SECRET-VALUE'));
  assert.equal(auth({ type: 'oauth2' }).note, '[auth oauth2 not imported]');
  for (const type of ['digest', 'awsv4', 'ntlm', 'apikey']) {
    const other = auth({ type });
    assert.deepEqual([other.auth, other.note, other.issue?.code], [{ kind: 'unsupported', type }, `[auth ${type} not imported]`, 'TC-AUTH-UNSUPPORTED']);
  }
  assert.equal(auth({ type: 'x'.repeat(50) }).note, '[auth <other> not imported]');
});

test('Dynamic variables with an equivalent are rewritten, the others stay and are listed by name', () => {
  const unmapped = new Set<string>();
  assert.equal(mapSystemVariables('{{#guid}}', unmapped), '{{$guid}}');
  assert.equal(mapSystemVariables('a {{ #guid }} b', unmapped), 'a {{$guid}} b');
  // Thunder's number runs from a to b INCLUDING b; the tools stop before the upper bound, so it is written as b + 1.
  assert.equal(mapSystemVariables('{{#number}}', unmapped), '{{$randomInt 1 1000001}}');
  assert.equal(mapSystemVariables('{{#number, 100, 999}}', unmapped), '{{$randomInt 100 1000}}');
  assert.equal(mapSystemVariables('{{#number,-5,5}}', unmapped), '{{$randomInt -5 6}}');
  assert.equal(unmapped.size, 0);
  assert.equal(mapSystemVariables('{{#date, \'X\'}} {{#email}} {{#enum, a, b}} {{#number, x}} {{#guid, 1}} {{#secretname}} {{plain}}', unmapped), '{{#date, \'X\'}} {{#email}} {{#enum, a, b}} {{#number, x}} {{#guid, 1}} {{#secretname}} {{plain}}');
  assert.deepEqual([...unmapped].sort(), ['<other>', 'date', 'email', 'enum', 'guid', 'number']);
  assert.equal(mapSystemVariables('no variables', unmapped), 'no variables');
});
