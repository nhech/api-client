import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureResult } from '../../src/core/assert';
import { MAX_RUNTIME_VALUE_CHARS, MAX_RUNTIME_VARIABLES, RuntimeVariables, type RuntimeContext } from '../../src/core/runtime';

const result = (variable: string, value: string, over: Partial<CaptureResult> = {}): CaptureResult => ({ expr: `${variable} = value ${value}`, from: 'request', ok: true, variable, scope: 'active', action: 'set', value, message: '', ...over });
const dev: RuntimeContext = { environmentId: 'E-dev', collection: 'api-client/collections/shop' };
const names = (variables: RuntimeVariables, context: RuntimeContext): [string, string, boolean][] =>
  [...variables.scope(context)].map(([name, value]): [string, string, boolean] => [name, value.value, value.secret]).sort((a, b) => (a[0] < b[0] ? -1 : 1));

test('A captured value is seen where its scope says: the environment, every environment of the collection, or the session of the collection', () => {
  const variables = new RuntimeVariables();
  variables.apply(result('a', 'env-value'), dev);
  variables.apply(result('b', 'collection-value', { scope: 'local' }), dev);
  variables.apply(result('c', 'everywhere', { scope: 'global' }), dev);
  assert.deepEqual(names(variables, dev), [['a', 'env-value', false], ['b', 'collection-value', false], ['c', 'everywhere', false]]);
  assert.deepEqual(names(variables, { ...dev, environmentId: 'E-prod' }), [['b', 'collection-value', false], ['c', 'everywhere', false]], 'another environment does not see the values of the first');
  assert.deepEqual(names(variables, { ...dev, environmentId: undefined }), [['b', 'collection-value', false], ['c', 'everywhere', false]], 'nor does no environment');
  assert.deepEqual(names(variables, { ...dev, collection: 'api-client/collections/blog' }), [], 'another collection sees nothing that this one set, in any scope');
  variables.apply(result('d', 'no-env'), { ...dev, environmentId: undefined });
  assert.deepEqual(names(variables, { ...dev, environmentId: undefined }).map(item => item[0]), ['b', 'c', 'd'], 'with no environment, values have a place of their own');
});

test('The nearest scope wins when a name is set in several, and the newest value wins in one', () => {
  const variables = new RuntimeVariables();
  variables.apply(result('x', 'global', { scope: 'global' }), dev);
  assert.equal(variables.scope(dev).get('x')?.value, 'global');
  variables.apply(result('x', 'environment'), dev);
  assert.equal(variables.scope(dev).get('x')?.value, 'environment');
  variables.apply(result('x', 'collection', { scope: 'local' }), dev);
  assert.equal(variables.scope(dev).get('x')?.value, 'collection');
  variables.apply(result('x', 'newer', { scope: 'local' }), dev);
  assert.equal(variables.scope(dev).get('x')?.value, 'newer');
});

test('A name that looks like a secret is a secret, and a failed or nameless result changes nothing', () => {
  const variables = new RuntimeVariables();
  variables.apply(result('access_token', 'abc12345'), dev);
  variables.apply(result('page', '2'), dev);
  assert.deepEqual(names(variables, dev), [['access_token', 'abc12345', true], ['page', '2', false]]);
  variables.apply(result('page', '3', { ok: false }), dev);
  variables.apply(result('', 'x'), dev);
  assert.equal(variables.scope(dev).get('page')?.value, '2');
  assert.equal(variables.size, 2);
});

test('A variable can be removed, and everything can be cleared', () => {
  const variables = new RuntimeVariables();
  variables.apply(result('a', '1'), dev);
  variables.apply(result('b', '2', { scope: 'global' }), dev);
  variables.apply(result('a', '', { action: 'delete' }), dev);
  assert.deepEqual(names(variables, dev), [['b', '2', false]]);
  variables.apply(result('missing', '', { action: 'delete' }), dev);
  assert.equal(variables.size, 1);
  variables.clear();
  assert.deepEqual(names(variables, dev), []);
  assert.equal(variables.size, 0);
});

test('A value is cut at a size, and no more than a thousand names are kept (a name already there can still be updated)', () => {
  const variables = new RuntimeVariables();
  variables.apply(result('big', 'x'.repeat(MAX_RUNTIME_VALUE_CHARS + 5)), dev);
  assert.equal(variables.scope(dev).get('big')?.value.length, MAX_RUNTIME_VALUE_CHARS);
  for (let index = 0; index < MAX_RUNTIME_VARIABLES + 10; index++) variables.apply(result(`v${index}`, '1', { scope: 'global' }), dev);
  assert.equal(variables.size, MAX_RUNTIME_VARIABLES);
  variables.apply(result('v0', 'updated', { scope: 'global' }), dev);
  assert.equal(variables.scope(dev).get('v0')?.value, 'updated');
  variables.apply(result('v0', '', { action: 'delete', scope: 'global' }), dev);
  variables.apply(result('fresh', '1', { scope: 'global' }), dev);
  assert.equal(variables.scope(dev).get('fresh')?.value, '1', 'room made by a delete is used');
});

test('What one collection sets is never seen by another: a capture in a repository that came from somewhere else cannot change what a request of yours is sent to', () => {
  const variables = new RuntimeVariables();
  const evil: RuntimeContext = { environmentId: 'E-dev', collection: 'api-client/collections/evil' };
  const mine: RuntimeContext = { environmentId: 'E-dev', collection: 'api-client/collections/shop' };
  variables.apply(result('host', 'evil.example', { scope: 'global' }), evil);
  variables.apply(result('base', 'https://evil.example', { scope: 'active' }), evil);
  variables.apply(result('other', 'x', { scope: 'local' }), evil);
  variables.change('global', { set: [['viaScript', 'x']], unset: [] }, evil);
  variables.change('active', { set: [['viaScript2', 'x']], unset: [] }, evil);
  assert.deepEqual(names(variables, mine), [], 'the same environment, another collection');
  assert.deepEqual([...variables.snapshot(mine).global, ...variables.snapshot(mine).active, ...variables.snapshot(mine).local], []);
  assert.equal(names(variables, evil).length, 5, 'the collection that set them sees them');
  variables.apply(result('host', 'api.shop.example', { scope: 'global' }), mine);
  assert.equal(variables.scope(mine).get('host')?.value, 'api.shop.example');
  assert.equal(variables.scope(evil).get('host')?.value, 'evil.example', 'and neither changes the other');
});

test('The limit of a thousand variables is for a collection: one collection cannot use up the room of another', () => {
  const variables = new RuntimeVariables();
  const first: RuntimeContext = { environmentId: 'E-dev', collection: 'api-client/collections/first' };
  const second: RuntimeContext = { environmentId: 'E-dev', collection: 'api-client/collections/second' };
  for (let index = 0; index < MAX_RUNTIME_VARIABLES + 50; index++) variables.apply(result(`v${index}`, '1', { scope: index % 3 === 0 ? 'global' : index % 3 === 1 ? 'local' : 'active' }), first);
  assert.equal(names(variables, first).length, MAX_RUNTIME_VARIABLES, 'the first collection is held to the limit in all its scopes together');
  variables.apply(result('token', 'abc12345'), second);
  assert.equal(variables.scope(second).get('token')?.value, 'abc12345', 'the second collection still has its room');
  assert.equal(variables.size, MAX_RUNTIME_VARIABLES + 1);
});
