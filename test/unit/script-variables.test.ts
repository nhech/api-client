import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Level } from '../../src/core/inherit';
import { newContainer, newEnvironment, newWorkspaceFile, type Var } from '../../src/core/model';
import { MAX_RUNTIME_VALUE_CHARS, MAX_RUNTIME_VARIABLES, RuntimeVariables, type RuntimeContext } from '../../src/core/runtime';
import { resolveText, snapshotVariables, variableScopes, type Scope } from '../../src/core/vars';

/** What the scripts read and write of the variables: the changes they ask for, a snapshot by scope to give them, and how both follow the rules of the captures. */

const dev: RuntimeContext = { environmentId: 'E-dev', collection: 'api-client/collections/shop' };
const names = (variables: RuntimeVariables, context: RuntimeContext): [string, string, boolean][] =>
  [...variables.scope(context)].map(([name, value]): [string, string, boolean] => [name, value.value, value.secret]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const variable = (name: string, value: string, change: Partial<Var> = {}): Var => ({ name, value, secret: false, enabled: true, ...change });
const scope = (entries: Record<string, string>): Scope => new Map(Object.entries(entries).map(([name, value]) => [name, { value, secret: false }]));
const clock = { now: () => 0, random: () => 0 };

test('What a script sets is kept by scope like what a capture saves; the removals come first, and a name like __proto__ is only a name', () => {
  const variables = new RuntimeVariables();
  variables.change('active', { set: [['a', '1'], ['__proto__', 'p'], ['gone', 'x']], unset: [] }, dev);
  variables.change('active', { set: [['again', '2']], unset: ['gone', 'never-there'] }, dev);
  variables.change('local', { set: [['c', 'collection']], unset: [] }, dev);
  variables.change('global', { set: [['g', 'everywhere']], unset: [] }, dev);
  assert.deepEqual(names(variables, dev), [['__proto__', 'p', false], ['a', '1', false], ['again', '2', false], ['c', 'collection', false], ['g', 'everywhere', false]]);
  assert.equal(({} as Record<string, unknown>).p, undefined, 'the prototype of objects is not touched');
  variables.change('active', { set: [['x', 'set'], ['y', 'set']], unset: ['x'] }, dev);
  assert.deepEqual([variables.scope(dev).get('x')?.value, variables.scope(dev).get('y')?.value], ['set', 'set'], 'a name that is both removed and set ends up set');
  variables.change('active', { set: [['token', 'abc12345']], unset: [] }, dev);
  assert.equal(variables.scope(dev).get('token')?.secret, true);
});

test('The changes of a script obey the same limits as the captures', () => {
  const variables = new RuntimeVariables();
  variables.change('global', { set: [['big', 'x'.repeat(MAX_RUNTIME_VALUE_CHARS + 9)]], unset: [] }, dev);
  assert.equal(variables.scope(dev).get('big')?.value.length, MAX_RUNTIME_VALUE_CHARS);
  const many: [string, string][] = [];
  for (let index = 0; index < MAX_RUNTIME_VARIABLES + 10; index++) many.push([`n${index}`, '1']);
  variables.change('local', { set: many, unset: [] }, dev);
  assert.equal(variables.size, MAX_RUNTIME_VARIABLES);
});

test('A snapshot is a copy by scope for one context: changing it does not change the variables', () => {
  const variables = new RuntimeVariables();
  variables.change('active', { set: [['e', '1']], unset: [] }, dev);
  variables.change('local', { set: [['c', '2']], unset: [] }, dev);
  variables.change('global', { set: [['g', '3']], unset: [] }, dev);
  const snapshot = variables.snapshot(dev);
  assert.deepEqual([[...snapshot.active], [...snapshot.local], [...snapshot.global]], [[['e', '1']], [['c', '2']], [['g', '3']]]);
  snapshot.active.set('e', 'changed');
  snapshot.local.set('c', 'changed');
  snapshot.global.delete('g');
  assert.deepEqual([variables.scope(dev).get('e')?.value, variables.scope(dev).get('c')?.value, variables.scope(dev).get('g')?.value], ['1', '2', '3']);
  const other = variables.snapshot({ environmentId: 'E-prod', collection: 'api-client/collections/blog' });
  assert.deepEqual([other.active.size, other.local.size, other.global.size], [0, 0, 0], 'another collection sees none of them, in any scope');
  assert.equal(variables.snapshot({ environmentId: undefined, collection: dev.collection }).active.size, 0);
});

test('A script is given the variables by the scopes it can write to, and all of them as a request would resolve them', () => {
  const level = (name: string, vars: Var[], kind: 'collection' | 'folder' = 'folder'): Level => ({ kind, name, container: { ...newContainer(`id-${name}`, name), vars } });
  const environment = { ...newEnvironment('e1', 'dev'), vars: [variable('v', 'environment'), variable('onlyEnv', 'e'), variable('off', 'x', { enabled: false })] };
  const workspace = { ...newWorkspaceFile(), vars: [variable('v', 'workspace'), variable('onlyWorkspace', 'w')] };
  const levels = [level('Shop', [variable('v', 'collection'), variable('c', 'c')], 'collection'), level('Orders', [variable('v', 'folder'), variable('f', 'f')])];
  const none = { active: new Map<string, string>(), local: new Map<string, string>(), global: new Map<string, string>() };
  const plain = snapshotVariables({ levels, environment, workspace }, none);
  assert.deepEqual({ ...plain.environment }, { v: 'environment', onlyEnv: 'e' });
  assert.deepEqual({ ...plain.collection }, { v: 'folder', c: 'c', f: 'f' }, 'the nearest folder wins over the collection');
  assert.deepEqual({ ...plain.globals }, { v: 'workspace', onlyWorkspace: 'w' });
  assert.equal(plain.merged.v, 'folder', 'a request resolves a name like variableScopes does');
  assert.deepEqual(Object.keys(plain.merged).sort(), ['c', 'f', 'onlyEnv', 'onlyWorkspace', 'v']);
  assert.equal(resolveText('{{v}} {{onlyEnv}} {{onlyWorkspace}} {{c}} {{f}}', variableScopes({ levels, environment, workspace }), { clock }).text, `${plain.merged.v} e w c f`);
  assert.equal(Object.getPrototypeOf(plain.merged), null, 'no prototype: a name is only a name');

  const set = { active: new Map([['v', 'set-in-environment'], ['a', 'a']]), local: new Map([['l', 'l']]), global: new Map([['onlyWorkspace', 'set-everywhere'], ['g', 'g']]) };
  const changed = snapshotVariables({ levels, environment, workspace }, set);
  assert.deepEqual({ ...changed.environment }, { v: 'set-in-environment', onlyEnv: 'e', a: 'a' });
  assert.deepEqual({ ...changed.collection }, { v: 'folder', c: 'c', f: 'f', l: 'l' });
  assert.deepEqual({ ...changed.globals }, { v: 'workspace', onlyWorkspace: 'set-everywhere', g: 'g' });
  assert.equal(changed.merged.v, 'set-in-environment', 'what a script set beats the folders');
  assert.equal(changed.merged.onlyWorkspace, 'set-everywhere');
  const nearest = snapshotVariables({ levels, environment, workspace }, { active: new Map([['x', 'environment']]), local: new Map([['x', 'collection']]), global: new Map([['x', 'everywhere']]) });
  assert.equal(nearest.merged.x, 'collection', 'among what was set, the nearest scope wins: the collection, then the environment, then everywhere');
  const farther = snapshotVariables({ levels, environment, workspace }, { active: new Map([['x', 'environment']]), local: new Map(), global: new Map([['x', 'everywhere']]) });
  assert.equal(farther.merged.x, 'environment', 'what was set in the environment beats what was set everywhere');
  assert.equal(snapshotVariables({ levels: [], dotenv: scope({ v: 'dotenv', d: 'd' }), environment, workspace }, none).merged.v, 'environment', 'the environment beats a .env file');
  assert.equal(snapshotVariables({ levels: [], dotenv: scope({ d: 'd' }), workspace }, none).merged.d, 'd');
  assert.deepEqual({ ...snapshotVariables({ levels: [], workspace: newWorkspaceFile() }, none).merged }, {});
});
