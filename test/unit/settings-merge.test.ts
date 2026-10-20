import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REST_CLIENT_PRIVATE_SETTINGS_FILE, REST_CLIENT_SETTINGS_FILE } from '../../src/emit/env';
import { mergeEnvironments, restClientSettingsFrom } from '../../src/settings-merge';

test('Nothing there: everything is added', () => {
  const result = mergeEnvironments(undefined, { dev: { a: '1', b: '2' }, prod: { a: '3' } });
  assert.deepEqual(result.merged, { dev: { a: '1', b: '2' }, prod: { a: '3' } });
  assert.deepEqual([result.addedEnvironments, result.addedVariables, result.kept], [2, 3, []]);
});

test('What the person has stays as it is: other environments, $shared, and values of another type', () => {
  const existing = { $shared: { x: 'shared' }, dev: { a: 'mine', keep: 'me' }, other: { z: '9' }, odd: 5 };
  const before = JSON.stringify(existing);
  const result = mergeEnvironments(existing, { dev: { a: 'theirs', b: '2' }, odd: { q: '1' }, fresh: { n: '1' } });
  assert.equal(JSON.stringify(existing), before, 'the input is not changed');
  assert.deepEqual(result.merged, { $shared: { x: 'shared' }, dev: { a: 'mine', keep: 'me', b: '2' }, other: { z: '9' }, odd: 5, fresh: { n: '1' } });
  assert.deepEqual(result.kept, ['dev.a', 'odd'], 'a different value and an environment that is not an object are kept and named, without their values');
  assert.deepEqual([result.addedEnvironments, result.addedVariables], [1, 2]);
});

test('The same value again is not a conflict and not an addition: importing twice changes nothing', () => {
  const incoming = { dev: { a: '1' } };
  const once = mergeEnvironments(undefined, incoming).merged;
  const twice = mergeEnvironments(once, incoming);
  assert.deepEqual(twice.merged, once);
  assert.deepEqual([twice.addedEnvironments, twice.addedVariables, twice.kept], [0, 0, []]);
});

test('A key such as __proto__ from the data is an ordinary key and pollutes nothing', () => {
  const incoming = JSON.parse('{"__proto__": {"polluted": "yes"}, "dev": {"__proto__": "x", "constructor": "y"}}') as Record<string, Record<string, string>>;
  const result = mergeEnvironments({ dev: { a: '1' } }, incoming);
  assert.equal(({} as { polluted?: string }).polluted, undefined);
  assert.equal(Object.hasOwn(result.merged, '__proto__'), true);
  assert.deepEqual(Object.keys(result.merged['dev'] ?? {}).sort(), ['__proto__', 'a', 'constructor']);
  assert.equal((JSON.parse(JSON.stringify(result.merged)) as Record<string, Record<string, string>>)['dev']?.['constructor'], 'y');
});

test('The files of the import are read back, and a file that is not in the expected form is not used', () => {
  const file = (path: string, value: unknown) => ({ path, content: typeof value === 'string' ? value : JSON.stringify(value) });
  const good = restClientSettingsFrom([
    file(REST_CLIENT_SETTINGS_FILE, { 'rest-client.environmentVariables': { dev: { a: '1' } } }),
    file(REST_CLIENT_PRIVATE_SETTINGS_FILE, { 'rest-client.environmentVariables': { dev: { token: 'T' } } })
  ]);
  assert.deepEqual(good, { shareable: { dev: { a: '1' } }, secrets: { dev: { token: 'T' } } });
  assert.deepEqual(restClientSettingsFrom([file(REST_CLIENT_SETTINGS_FILE, { 'rest-client.environmentVariables': {} })]), { shareable: {}, secrets: undefined });
  assert.equal(restClientSettingsFrom([]), undefined);
  assert.equal(restClientSettingsFrom([file(REST_CLIENT_SETTINGS_FILE, 'not json')]), undefined);
  assert.equal(restClientSettingsFrom([file(REST_CLIENT_SETTINGS_FILE, { other: {} })]), undefined);
  assert.equal(restClientSettingsFrom([file(REST_CLIENT_SETTINGS_FILE, { 'rest-client.environmentVariables': { dev: { a: 1 } } })]), undefined);
  assert.equal(restClientSettingsFrom([file(REST_CLIENT_SETTINGS_FILE, { 'rest-client.environmentVariables': { dev: 'x' } })]), undefined);
});
