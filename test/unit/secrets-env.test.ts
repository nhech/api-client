import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertEnvironments } from '../../src/convert/environments';
import { SECRET_HEADER, SECRET_VARIABLE, SecretStore, splitCredential, variablePart } from '../../src/convert/secrets';
import { FindingSink } from '../../src/normalize/sink';
import type { TreeEnvironment } from '../../src';

const CANARY = 'CANARY-literal-credential-123';

test('A literal credential is replaced by a variable and its value is kept for the private file', () => {
  const store = new SecretStore(true);
  const result = store.protect('Shop API', 'bearer_token', CANARY);
  assert.deepEqual(result, { text: '{{secret_shop_api_bearer_token}}', moved: true, literal: false });
  assert.deepEqual([...store.variables], [['secret_shop_api_bearer_token', CANARY]]);
  assert.equal(store.moved, 1);
});

test('The same value is one variable however many times it is met, and another value gets the next number', () => {
  const store = new SecretStore(true);
  const names = [CANARY, CANARY, 'other-value', 'third', CANARY].map(value => store.protect('Shop', 'bearer_token', value).text);
  assert.deepEqual(names, ['{{secret_shop_bearer_token}}', '{{secret_shop_bearer_token}}', '{{secret_shop_bearer_token_2}}', '{{secret_shop_bearer_token_3}}', '{{secret_shop_bearer_token}}']);
  assert.equal(store.variables.size, 3);
  assert.equal(store.moved, 5);
  assert.equal(store.protect('Blog', 'bearer_token', CANARY).text, '{{secret_blog_bearer_token}}', 'another collection, another name');
});

test('A value that is only variables is not a secret and is left alone', () => {
  const store = new SecretStore(true);
  for (const value of ['{{token}}', ' {{a}} {{b}} ', '']) assert.deepEqual(store.protect('C', 'bearer_token', value), { text: value, moved: false, literal: false });
  assert.equal(store.variables.size, 0);
});

test('With moving switched off the literal stays and is marked', () => {
  const store = new SecretStore(false);
  assert.deepEqual(store.protect('C', 'bearer_token', CANARY), { text: CANARY, moved: false, literal: true });
  assert.equal(store.variables.size, 0);
  assert.equal(store.protect('C', 'bearer_token', '{{x}}').literal, false);
});

test('A credential header keeps its scheme word and only the credential moves', () => {
  const store = new SecretStore(true);
  assert.equal(store.protectHeader('C', 'Authorization', `Bearer ${CANARY}`).text, 'Bearer {{secret_c_header_authorization}}');
  assert.equal(store.protectHeader('C', 'authorization', `Basic ${CANARY}-another`).text, 'Basic {{secret_c_header_authorization_2}}');
  assert.equal(store.protectHeader('C', 'AUTHORIZATION', `Bearer ${CANARY}`).text, 'Bearer {{secret_c_header_authorization}}', 'the same credential is the same variable, whichever header spelling');
  assert.equal(store.protectHeader('C', 'Authorization', 'Bearer {{token}}').text, 'Bearer {{token}}');
  assert.equal(store.protectHeader('C', 'X-Api-Key', CANARY).text, '{{secret_c_header_x_api_key}}');
  assert.equal(store.protectHeader('C', 'Cookie', 'sid=abc').text, '{{secret_c_header_cookie}}');
  assert.deepEqual(store.protectHeader('C', 'Accept', 'application/json'), { text: 'application/json', moved: false, literal: false });
});

test('Which headers and variable names are secrets', () => {
  for (const name of ['Authorization', 'proxy-authorization', 'X-API-Key', 'api-key', 'x-auth-token', 'Cookie', 'X-Old-Key', 'Ocp-Apim-Subscription-Key', 'X-Amz-Security-Token', 'X-ApiKey', 'X_Session', 'X-CSRF-Token', 'Set-Cookie', 'X-Signature']) assert.equal(SECRET_HEADER.test(name), true, name);
  for (const name of ['Accept', 'X-Request-Id', 'Content-Type', 'User-Agent', 'X-Trace', 'Keep-Alive', 'Monkey', 'X-Turkey-Id', 'Cache-Control']) assert.equal(SECRET_HEADER.test(name), false, name);
  for (const name of ['api_token', 'DB_PASSWORD', 'clientSecret', 'apiKey', 'passwd', 'PWD', 'credentials', 'oauthCode']) assert.equal(SECRET_VARIABLE.test(name), true, name);
  for (const name of ['baseUrl', 'host', 'port', 'user', 'timeout']) assert.equal(SECRET_VARIABLE.test(name), false, name);
  assert.deepEqual([splitCredential('Bearer abc def'), splitCredential('basic  xyz'), splitCredential('raw-token')], [{ prefix: 'Bearer ', credential: 'abc def' }, { prefix: 'basic  ', credential: 'xyz' }, { prefix: '', credential: 'raw-token' }]);
  assert.deepEqual([variablePart('Shop API!'), variablePart('  --  '), variablePart('x'.repeat(100)).length, variablePart('', 'v')], ['shop_api', 'api', 40, 'v']);
});

const env = (kind: TreeEnvironment['kind'], name: string, source: object): TreeEnvironment => ({ origin: `${name}.json`, kind, name, source: source as TreeEnvironment['source'] });
const convert = (sources: TreeEnvironment[], moveSecrets = true) => { const sink = new FindingSink(); const result = convertEnvironments(sources, moveSecrets, sink); return { ...result, findings: sink.flush().map(f => `${f.code}@${f.where}: ${f.message}`) }; };

test('N14: the flags make an environment shared, private or named; an export is named', () => {
  const result = convert([
    env('v4', 'dev', { default: true, data: [{ name: 'a', value: '1' }] }),
    env('v4', 'Global', { global: true, data: [{ name: 'user', value: 'u' }] }),
    env('v4', 'Local', { global: true, local: true, data: [{ name: 'pass', value: CANARY }] }),
    env('v3', 'odd', { local: true, data: [] }),
    env('export', 'Exported', { variables: [{ name: 'x', value: 'y' }] })
  ]);
  assert.deepEqual(result.environments.map(e => `${e.name}:${e.kind}:${e.isDefault}`), ['dev:named:true', 'Global:shared:false', 'Local:private:false', 'odd:named:false', 'Exported:named:false']);
  assert.deepEqual(result.environments[4]?.variables.map(v => v.name), ['x']);
  assert.equal(result.environments[2]?.variables[0]?.secret, true, 'everything of a private environment is private');
});

test('N13: a repeated name keeps the last value, a disabled variable and a nameless one are dropped', () => {
  const result = convert([env('v4', 'dev', { data: [{ name: 'a', value: '1' }, { name: 'a', value: '2' }, { name: 'b', value: 'x', isDisabled: true }, { value: 'no name' }, { name: '' }, { name: 'c', value: 5 }, 'text'] })]);
  assert.deepEqual(result.environments[0]?.variables.map(v => `${v.name}=${v.value}`), ['a=2', 'c=5']);
  assert.deepEqual(result.findings, ['TC-ENV-DUP@Environment dev: 1 variable name was repeated; the last value of each was kept.', 'TC-VALUE-COERCED@Environment dev: 1 values of the wrong type were converted.']);
});

test('An encrypted value is never read: the variable stays, empty, and is reported for the person to type in again', () => {
  const result = convert([env('v4', 'dev', { data: [{ name: 'api_token', value: 'ENCRYPTED-BYTES-CANARY', encrypted: true }, { name: 'plain', value: 'p' }] })]);
  assert.deepEqual(result.environments[0]?.variables.map(v => ({ ...v })), [{ name: 'api_token', value: '', secret: true, needsReentry: true }, { name: 'plain', value: 'p', secret: false, needsReentry: false }]);
  assert.equal(result.variablesToReenter, 1);
  assert.ok(!JSON.stringify(result).includes('ENCRYPTED-BYTES-CANARY'));
  assert.deepEqual(result.findings, ['TC-ENV-ENCRYPTED@Environment dev: 1 encrypted variable was not decrypted; type its value in again in the private file.']);
});

test('A variable whose name says secret and whose value is a literal is marked, and counted as moved', () => {
  const result = convert([env('v4', 'dev', { data: [{ name: 'api_token', value: CANARY }, { name: 'api_key', value: '{{from_elsewhere}}' }, { name: 'host', value: 'h' }, { name: 'password', value: '' }] })]);
  assert.deepEqual(result.environments[0]?.variables.map(v => `${v.name}:${v.secret}`), ['api_token:true', 'api_key:false', 'host:false', 'password:false']);
  assert.equal(result.secretsMoved, 1);
  assert.deepEqual(result.findings, ['TC-SECRET-MOVED@Environment dev: 1 secret-looking variable was moved to the private environment file.']);
});

test('With moving switched off the secret-looking variable stays public and is reported', () => {
  const result = convert([env('v4', 'dev', { data: [{ name: 'api_token', value: CANARY }] })], false);
  assert.equal(result.environments[0]?.variables[0]?.secret, false);
  assert.equal(result.secretsMoved, 0);
  assert.deepEqual(result.findings, ['TC-SECRET-LITERAL@Environment dev: 1 secret-looking variable stays in the shared environment file.']);
});

test('A dotenv file is only mentioned, and the report holds names but no values', () => {
  const result = convert([env('v4', 'dev', { envFile: '/home/someone/.env', data: [{ name: 'x', value: CANARY }] })]);
  assert.deepEqual(result.findings, ['TC-ENV-FILE@Environment dev: The environment refers to a dotenv file, which is not read.']);
  assert.equal(result.environments[0]?.envFile, '/home/someone/.env', 'kept for the model; the emitter shows only that there was one');
  assert.ok(!result.findings.join('').includes(CANARY));
});

test('A nameless environment gets a name', () => {
  assert.equal(convert([env('v4', '', { data: [] })]).environments[0]?.name, 'Environment');
});
