import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newContainer, newEnvironment, newRequest, newWorkspaceFile, type Container, type Environment, type Request, type WorkspaceFile } from '../../src/core/model';
import { ID_PATTERN, newId } from '../../src/core/clock';
import { parseYaml, type YMap, type YValue } from '../../src/format/yaml';
import {
  decodeRequest, readContainer, readEnvironment, readRequest, readWorkspace, SCHEMA_VERSION, writeContainer, writeEnvironment, writeRequest, writeWorkspace, type Migrations
} from '../../src/format/schema';

/**
 * The file format. Seven canonical files in test/fixtures/golden/yaml/ are written from models and read back; to rewrite them
 * after a change you mean: UPDATE_GOLDEN=1 npm test, then read the diff (a golden is accepted by a person, not by the tool).
 */
const goldenDir = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'golden', 'yaml');
const update = process.env['UPDATE_GOLDEN'] === '1';
const kv = (name: string, value: string, enabled = true, description = '') => ({ name, value, enabled, description });

const FULL: Request = {
  ...newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABC', 'Create pet'),
  docs: 'Adds a pet to the store.\nSee the docs.\n', method: 'POST', url: '{{baseUrl}}/pets/{petId}',
  query: [kv('dryRun', 'true'), kv('trace', '1', false, 'turn on tracing')], pathParams: [kv('petId', '42')],
  headers: [kv('Content-Type', 'application/json'), kv('X-Debug', 'on', false), kv('Accept', '')],
  auth: { kind: 'bearer', token: '{{token}}', prefix: 'Bearer' },
  body: { kind: 'json', text: '{\n  "name": "Rex",\n  "tags": ["a", "b"]\n}' },
  scripts: { pre: 'pm.variables.set("t", Date.now());\n', post: 'pm.test("created", () => pm.response.to.have.status(201));' },
  tests: [{ expr: 'status == 201', enabled: true }, { expr: 'json $.id exists', enabled: false }], captures: [{ expr: 'petId = json $.id', enabled: true }],
  settings: { timeoutMs: 5000, followRedirects: false, httpVersion: '2' }, mirror: false
};
const OAUTH: Request = {
  ...newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABD', 'Upload photo'), method: 'PUT', url: 'https://api.example.com/pets/1/photo',
  auth: {
    kind: 'oauth2', grant: 'authorization_code', pkce: true, authUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token', clientId: '{{clientId}}',
    clientSecret: '{{clientSecret}}', scope: 'pets.write offline_access', audience: '', username: '', password: '', redirectUrl: '', clientAuth: 'body', extra: [kv('prompt', 'consent')]
  },
  body: { kind: 'multipart', parts: [{ name: 'caption', kind: 'text', value: 'Rex at the beach', file: '', contentType: '', enabled: true }, { name: 'photo', kind: 'file', value: '', file: 'files/rex.png', contentType: 'image/png', enabled: true }] }
};
const MINIMAL: Request = newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABE', 'Ping');
const COLLECTION: Container = {
  ...newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAA', 'Petstore'), docs: 'The pet store API.', baseUrl: '{{baseUrl}}', order: ['pets', 'list-pets', 'create-pet'],
  headers: [kv('Accept', 'application/json')], auth: { kind: 'apikey', name: 'X-Api-Key', value: '{{apiKey}}', in: 'header' },
  vars: [{ name: 'region', value: 'eu', secret: false, enabled: true }, { name: 'apiKey', value: '', secret: true, enabled: true }],
  scripts: { pre: '', post: 'console.log("done");' }, tests: [{ expr: 'duration < 2000', enabled: true }], settings: { timeoutMs: 10000 }
};
const FOLDER: Container = { ...newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAB', 'Pets'), auth: { kind: 'basic', username: 'admin', password: '{{adminPassword}}' }, baseUrl: 'https://pets.example.com' };
const ENVIRONMENT: Environment = {
  ...newEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1AAC', 'Development'),
  vars: [{ name: 'baseUrl', value: 'https://dev.example.com', secret: false, enabled: true }, { name: 'token', value: '', secret: true, enabled: true }, { name: 'debug', value: 'true', secret: false, enabled: false }]
};
const WORKSPACE: WorkspaceFile = { ...newWorkspaceFile(), settings: { rejectUnauthorized: true, responseLimitBytes: 5242880 }, vars: [{ name: 'team', value: 'pets', secret: false, enabled: true }], collections: ['petstore', 'billing'] };

interface Fixture<T> { file: string; model: T; write: (model: T, extra?: YMap) => string; read: (text: string) => ReturnType<typeof readRequest> | ReturnType<typeof readContainer> | ReturnType<typeof readEnvironment> | ReturnType<typeof readWorkspace> }
const FIXTURES: Fixture<Request | Container | Environment | WorkspaceFile>[] = [
  { file: 'request-full.req.yml', model: FULL, write: m => writeRequest(m as Request), read: readRequest },
  { file: 'request-oauth.req.yml', model: OAUTH, write: m => writeRequest(m as Request), read: readRequest },
  { file: 'request-minimal.req.yml', model: MINIMAL, write: m => writeRequest(m as Request), read: readRequest },
  { file: 'collection.yml', model: COLLECTION, write: m => writeContainer(m as Container), read: text => readContainer(text, 'collection') },
  { file: 'folder.yml', model: FOLDER, write: m => writeContainer(m as Container), read: text => readContainer(text, 'folder') },
  { file: 'environment.env.yml', model: ENVIRONMENT, write: m => writeEnvironment(m as Environment), read: readEnvironment },
  { file: 'workspace.yml', model: WORKSPACE, write: m => writeWorkspace(m as WorkspaceFile), read: readWorkspace }
];

for (const fixture of FIXTURES) {
  test(`The file ${fixture.file} is the canonical text of its model, reads back to the model, and is written again unchanged`, () => {
    const written = fixture.write(fixture.model);
    const path = join(goldenDir, fixture.file);
    if (update) { mkdirSync(goldenDir, { recursive: true }); writeFileSync(path, written); }
    const golden = readFileSync(path, 'utf8');
    assert.equal(written, golden, `${fixture.file} differs from what the model writes (UPDATE_GOLDEN=1 npm test, then read the diff)`);
    const back = fixture.read(golden);
    assert.ok(back.ok, back.ok ? '' : JSON.stringify(back.findings));
    if (back.ok) {
      assert.deepEqual(back.value, fixture.model);
      assert.equal(back.extra.size, 0);
      assert.deepEqual(back.findings, []);
      assert.equal(fixture.write(back.value, back.extra), golden);
    }
  });
}

test('A request that was just made is short: only what differs from the defaults is written', () => {
  assert.equal(writeRequest(MINIMAL), ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1ABE', 'name: Ping', 'method: GET', "url: ''", ''].join('\n'));
  assert.equal(writeEnvironment(newEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1AAC', 'Empty')), 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAC\nname: Empty\n');
  assert.equal(writeWorkspace(newWorkspaceFile()), 'schema: 1\n');
});

const asValue = (text: string): YValue => {
  const parsed = parseYaml(text);
  assert.ok(parsed.ok);
  return parsed.ok ? parsed.value : '';
};

test('Keys the schema does not know at the top of a file are kept and written back after the known ones; deeper ones are a warning', () => {
  const text = ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1ABE', 'name: Ping', 'url: http://x', 'futureThing:', '  a: 1', 'headers:', '  - name: A', '    value: b', '    color: red', ''].join('\n');
  const result = readRequest(text);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual([...result.extra.keys()], ['futureThing']);
  assert.deepEqual(result.findings, [{ path: 'headers[0].color', message: 'unknown key; it is ignored and will not be written back', severity: 'warning' }]);
  assert.equal(writeRequest(result.value, result.extra), ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1ABE', 'name: Ping', 'method: GET', 'url: http://x', 'headers:', '  - name: A', '    value: b', 'futureThing:', '  a: 1', ''].join('\n'));
});

test('A file the schema cannot use is refused with the path and the reason, and a file of a newer schema is left alone', () => {
  const bad = (text: string) => { const result = readRequest(text); assert.equal(result.ok, false, text); return result.findings.filter(f => f.severity === 'error').map(f => `${f.path}: ${f.message}`); };
  assert.deepEqual(bad('name: x\n'), ['schema: the file must start with "schema: <version>"']);
  assert.deepEqual(bad('schema: one\nname: x\n'), ['schema: the file must start with "schema: <version>"']);
  assert.deepEqual(bad('schema: 0\nname: x\n'), ['schema: the schema version starts at 1']);
  assert.deepEqual(bad('- a\n'), [': a file holds a mapping of keys to values']);
  assert.deepEqual(bad('schema: 1\n'), ['name: a request needs a name']);
  assert.deepEqual(bad('schema: 1\nname: x\nmethod: "GE T"\n'), ['method: not a valid HTTP method']);
  assert.deepEqual(bad('schema: 1\nname: x\nheaders: nope\n'), ['headers: expected a list']);
  assert.deepEqual(bad('schema: 1\nname: x\nheaders:\n  - plain\n'), ['headers[0]: expected a mapping of keys to values']);
  assert.deepEqual(bad('schema: 1\nname: x\nname2: y\nmirror: maybe\n'), ['mirror: expected true or false']);
  assert.deepEqual(bad('schema: 1\nname: x\nsettings:\n  timeoutMs: 0\n'), ['settings.timeoutMs: expected a number from 1 to 3600000']);
  assert.deepEqual(bad('schema: 1\nname: x\nsettings:\n  timeoutMs: soon\n  httpVersion: "3"\n'), ['settings.timeoutMs: expected a whole number', 'settings.httpVersion: expected one of 1.1, 2, auto']);
  assert.deepEqual(bad('schema: 1\nname: x\nauth:\n  kind: kerberos\n'), ['auth.kind: expected one of inherit, none, bearer, basic, apikey, oauth2']);
  assert.deepEqual(bad('schema: 1\nname: x\nbody:\n  kind: json\n  text:\n    - a\n'), ['body.text: expected text']);
  const newer = readRequest(`schema: ${SCHEMA_VERSION + 1}\nname: x\nsomething: new\n`);
  assert.equal(newer.ok, false);
  assert.equal(!newer.ok && newer.newer, true);
  assert.match(newer.findings[0]?.message ?? '', /newer version/);
  const syntax = readRequest('schema: 1\nname: [x\n');
  assert.equal(syntax.ok, false);
  assert.match(syntax.findings[0]?.message ?? '', /line 2, column 7: flow collections/);
});

test('A request without an id is read with a warning, and an id that is not a ULID is kept with one', () => {
  const missing = readRequest('schema: 1\nname: x\n');
  assert.ok(missing.ok);
  assert.deepEqual(missing.findings.map(f => f.path), ['id']);
  const odd = readRequest('schema: 1\nid: my-own-id\nname: x\n');
  assert.ok(odd.ok && odd.value.id === 'my-own-id' && odd.findings[0]?.severity === 'warning');
});

test('A file of an older schema is migrated step by step before it is read', () => {
  const migrations: Migrations = {
    1: root => { const next: YMap = new Map(root); next.set('name', `${root.get('title') as string}`); next.delete('title'); return next; },
    2: root => { const next: YMap = new Map(root); next.set('method', 'DELETE'); return next; }
  };
  const result = decodeRequest(asValue('schema: 1\ntitle: Old name\n'), { migrations, current: 3 });
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual([result.value.name, result.value.method, result.extra.size], ['Old name', 'DELETE', 0]);
  const missingStep = decodeRequest(asValue('schema: 1\nname: x\n'), { migrations: { 2: root => root }, current: 3 });
  assert.equal(missingStep.ok, false);
  assert.match(missingStep.findings[0]?.message ?? '', /no way to read a schema 1 file/);
});

test('Request methods may be custom tokens; the schema does not change the case of what was written', () => {
  const result = readRequest('schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABE\nname: x\nmethod: PURGE\nurl: ""\n');
  assert.ok(result.ok && result.value.method === 'PURGE');
  const lower = readRequest('schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABE\nname: x\nmethod: get\n');
  assert.ok(lower.ok && lower.value.method === 'get');
});

test('Identifiers are ULIDs: 26 characters, sorted by time, made from the injected clock and nothing else', () => {
  let tick = 1_700_000_000_000;
  const clock = { now: () => tick, random: () => 0.5 };
  const first = newId(clock);
  tick += 1;
  const second = newId(clock);
  assert.match(first, ID_PATTERN);
  assert.ok(first < second, 'later ids sort after earlier ones');
  assert.equal(newId(clock), second, 'the same clock gives the same id');
  assert.equal(newId({ now: () => 0, random: () => 0 }), '0'.repeat(26));
  // The first ten characters are the time in base 32, which an independent decoder reads back; any later time sorts later.
  const decode = (id: string): number => [...id.slice(0, 10)].reduce((total, char) => total * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(char), 0);
  let last = '';
  for (const now of [0, 1, 31, 32, 33, 1023, 1024, 1_700_000_000_000, 1_700_000_000_001, 2 ** 48 - 1]) {
    const id = newId({ now: () => now, random: () => 0 });
    assert.equal(decode(id), now);
    assert.ok(id > last, `${id} sorts after ${last}`);
    last = id;
  }
  assert.equal(newId({ now: () => 0, random: () => 0.999999 }), `${'0'.repeat(10)}${'Z'.repeat(16)}`);
});

test('The setting for a redirect to a private network is read, written back, and refused when it is not true or false', () => {
  const text = 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAA\nname: R\nmethod: GET\nurl: https://x.test\nsettings:\n  allowPrivateRedirects: true\n';
  const read = readRequest(text);
  assert.ok(read.ok);
  assert.equal(read.value.settings.allowPrivateRedirects, true);
  assert.match(writeRequest(read.value, read.extra), /settings:\n {2}allowPrivateRedirects: true\n/);
  const bad = readRequest(text.replace('true', 'sometimes'));
  assert.equal(bad.ok && bad.findings.length === 0, false, 'a word that is not true or false is a finding');
});
