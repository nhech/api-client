import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clock } from '../../src/core/clock';
import type { Level } from '../../src/core/inherit';
import { newContainer, newEnvironment, newWorkspaceFile, type Var } from '../../src/core/model';
import { describeVariables, dynamicValue, isKnownDynamic, isoTime, resolveText, scopeOf, tokenize, variableScopes, type Scope } from '../../src/core/vars';

const fixed = (now = 1_700_000_000_000, random = 0.5): Clock => ({ now: () => now, random: () => random });
/** A clock whose randomness is a repeatable sequence. */
function sequence(seed: number, now = 1_700_000_000_000): Clock {
  let state = seed >>> 0;
  return { now: () => now, random: () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state >>> 8) / 16777216; } };
}
const scope = (entries: Record<string, string>, secret = false): Scope => new Map(Object.entries(entries).map(([name, value]) => [name, { value, secret }]));
const resolve = (text: string, scopes: Scope[], clock: Clock = fixed()) => resolveText(text, scopes, { clock });
const variable = (name: string, value: string, change: Partial<Var> = {}): Var => ({ name, value, secret: false, enabled: true, ...change });

test('A variable is replaced by the value of the nearest scope that has it; the rest of the text is untouched', () => {
  const result = resolve('{{host}}/a/{{id}}?q={{ q }}&x={{host}}', [scope({ id: '7' }), scope({ host: 'https://h.test', id: '1', q: 'term' })]);
  assert.equal(result.text, 'https://h.test/a/7?q=term&x=https://h.test');
  assert.deepEqual([result.unresolved, result.cycles, result.secrets, result.truncated], [[], [], [], false]);
  assert.equal(resolve('no variables here', []).text, 'no variables here');
  assert.equal(resolve('', []).text, '');
});

test('Names with dots and dashes are names; anything else between braces is left as it is and reported once', () => {
  const result = resolve('{{a.b}} {{c-d}} {{missing}} {{missing}} {{a b}} {{}} {{1x}} {{ $nope }} {{$processEnv HOME}} {{#guid}}', [scope({ 'a.b': '1', 'c-d': '2' })]);
  assert.equal(result.text, '1 2 {{missing}} {{missing}} {{a b}} {{}} {{1x}} {{ $nope }} {{$processEnv HOME}} {{#guid}}');
  assert.deepEqual(result.unresolved, ['missing', '{{a b}}', '{{}}', '{{1x}}', '{{ $nope }}', '{{$processEnv HOME}}', '{{#guid}}']);
});

test('Nothing is evaluated: names that look like code or like the machine are looked up in the scopes like any other', () => {
  const nasty = '{{constructor}} {{__proto__}} {{toString}} {{process.env.HOME}} {{this.constructor}} {{require}}';
  const result = resolve(nasty, [scope({})]);
  assert.equal(result.text, nasty);
  assert.deepEqual(result.unresolved, ['constructor', '__proto__', 'toString', 'process.env.HOME', 'this.constructor', 'require']);
  assert.equal(resolve('{{constructor}}', [scope({ constructor: 'ok' })]).text, 'ok');
  assert.equal(resolve('{{$processEnv HOME}} {{$dotenv X}}', []).text, '{{$processEnv HOME}} {{$dotenv X}}');
});

test('A variable may hold variables; a name that leads back to itself is a cycle and stays in the text', () => {
  const nested = resolve('{{url}}', [scope({ url: '{{scheme}}://{{host}}', scheme: 'https', host: '{{name}}.test', name: 'api' })]);
  assert.equal(nested.text, 'https://api.test');
  const cycle = resolve('{{a}} | {{self}}', [scope({ a: 'x{{b}}', b: 'y{{a}}', self: '{{self}}' })]);
  assert.equal(cycle.text, 'xy{{a}} | {{self}}');
  assert.deepEqual(cycle.cycles, ['a', 'self']);
  assert.equal(resolve('{{a}} {{a}}', [scope({ a: 'v' })]).text, 'v v', 'the same name twice side by side is not a cycle');
});

test('Variables nested more deeply than the limit are left alone and the result says it was cut', () => {
  const chain: Record<string, string> = {};
  for (let index = 0; index < 15; index++) chain[`v${index}`] = index === 14 ? 'end' : `{{v${index + 1}}}`;
  const cut = resolveText('{{v0}}', [scope(chain)], { clock: fixed(), maxDepth: 10 });
  assert.equal(cut.truncated, true);
  assert.match(cut.text, /^\{\{v\d+\}\}$/);
  const whole = resolveText('{{v0}}', [scope(chain)], { clock: fixed(), maxDepth: 20 });
  assert.deepEqual([whole.text, whole.truncated], ['end', false]);
});

test('A value that grows without end is stopped by the size and the replacement limits', () => {
  const doubling: Record<string, string> = {};
  for (let index = 0; index < 25; index++) doubling[`d${index}`] = `{{d${index + 1}}}{{d${index + 1}}}`;
  doubling['d25'] = 'x'.repeat(1000);
  const started = performance.now();
  const capped = resolveText('{{d0}}', [scope(doubling)], { clock: fixed(), maxDepth: 30, maxBytes: 100_000 });
  assert.ok(performance.now() - started < 1000);
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length < 200_000);
  const limited = resolveText('{{d0}}', [scope(doubling)], { clock: fixed(), maxDepth: 30, maxBytes: 1 << 30, maxReplacements: 500 });
  assert.equal(limited.truncated, true);
});

test('The names of the secret variables that went into the text are reported, so that a log can hide their values', () => {
  const result = resolve('{{token}} and {{plain}} and {{token}}', [scope({ token: 'abc123' }, true), scope({ plain: 'p' })]);
  assert.equal(result.text, 'abc123 and p and abc123');
  assert.deepEqual(result.secrets, ['token']);
  const indirect = resolve('{{url}}', [scope({ url: 'https://h/?k={{key}}' }), scope({ key: 's3' }, true)]);
  assert.deepEqual(indirect.secrets, ['key']);
});

test('Dynamic words make values from the fixed table, and the same clock makes the same value', () => {
  const clock = sequence(7);
  const guid = dynamicValue('$guid', clock) ?? '';
  assert.match(guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(dynamicValue('$guid', sequence(7)), guid);
  assert.notEqual(dynamicValue('$guid', sequence(8)), guid);
  assert.equal(dynamicValue('$uuid', sequence(7)), guid);
  assert.equal(dynamicValue('$timestamp', fixed(1_700_000_000_999)), '1700000000');
  assert.equal(dynamicValue('$timestamp -1 d', fixed(1_700_000_000_000)), String(1_700_000_000 - 86_400));
  assert.equal(dynamicValue('$timestamp +30 m', fixed(1_700_000_000_000)), String(1_700_000_000 + 1800));
  assert.equal(dynamicValue('$isoTimestamp', fixed(1_700_000_000_123)), '2023-11-14T22:13:20.123Z');
  assert.equal(dynamicValue('$isoTimestamp 2 h', fixed(1_700_000_000_000)), '2023-11-15T00:13:20.000Z');
  assert.equal(dynamicValue('$randomBoolean', fixed(0, 0.1)), 'false');
  assert.equal(dynamicValue('$randomBoolean', fixed(0, 0.9)), 'true');
  assert.match(dynamicValue('$randomEmail', clock) ?? '', /^[a-z]{10}@example\.com$/);
  assert.match(dynamicValue('$randomString', clock) ?? '', /^[A-Za-z0-9]{12}$/);
  assert.match(dynamicValue('$randomString 5', clock) ?? '', /^[A-Za-z0-9]{5}$/);
});

test('Random integers stay inside their bounds, the default is 0 to 1000, and wrong arguments make no value', () => {
  const clock = sequence(99);
  for (let run = 0; run < 2000; run++) {
    const value = Number(dynamicValue('$randomInt 5 8', clock));
    assert.ok(Number.isInteger(value) && value >= 5 && value <= 8, String(value));
    const wide = Number(dynamicValue('$randomInt', clock));
    assert.ok(wide >= 0 && wide <= 1000);
  }
  assert.equal(dynamicValue('$randomInt 3 3', fixed(0, 0.999999)), '3');
  assert.equal(dynamicValue('$randomInt 1 2', fixed(0, 0.999999)), '2', 'the upper bound can be drawn');
  assert.equal(dynamicValue('$randomInt 1 2', fixed(0, 0)), '1', 'and the lower');
  assert.deepEqual([...new Set(Array.from({ length: 2000 }, () => dynamicValue('$randomInt 5 8', clock)))].sort(), ['5', '6', '7', '8']);
  assert.equal(dynamicValue('$randomInt -2 -1', fixed(0, 0)), '-2');
  assert.equal(dynamicValue('$randomInt 0 4294967296', fixed()), undefined, 'too wide');
  for (const bad of ['$randomInt 9 1', '$randomInt 1', '$randomInt a b', '$timestamp x y', '$timestamp 1', '$timestamp 1 parsec', '$guid extra', '$randomString 2000', '$randomString x', '$random', '$', '', 'guid']) {
    assert.equal(dynamicValue(bad, fixed()), undefined, bad);
  }
});

test('The time word writes the same civil date as the platform for dates before and after the epoch (property, 3000 times)', () => {
  const clock = sequence(1);
  for (const edge of [0, -1, 86_399_999, 951_782_400_000, 951_868_799_999, 4_107_542_400_000, -62_135_596_800_000, 253_402_300_799_999]) assert.equal(isoTime(edge), new Date(edge).toISOString(), String(edge));
  for (let run = 0; run < 3000; run++) {
    const ms = Math.floor((clock.random() - 0.3) * 8_000_000_000_000);
    assert.equal(isoTime(ms), new Date(ms).toISOString(), String(ms));
  }
});

test('A dynamic word inside a variable value is made when the value is used', () => {
  const result = resolveText('{{id}}', [scope({ id: 'req-{{$randomInt 100 100}}' })], { clock: fixed() });
  assert.equal(result.text, 'req-100');
});

test('tokenize tells variables, dynamic words and other braces apart and gives their spans', () => {
  const text = 'a {{x}} b {{ $guid }} c {{what is this}} d {{unclosed';
  assert.deepEqual(tokenize(text).map(t => [t.kind, t.name, text.slice(t.start, t.end)]), [['variable', 'x', '{{x}}'], ['dynamic', '$guid', '{{ $guid }}'], ['invalid', 'what is this', '{{what is this}}']]);
  assert.deepEqual(tokenize('{{{a}}}').map(t => [t.kind, t.start, t.end]), [['invalid', 0, 6]]);
  assert.deepEqual(tokenize('no braces'), []);
});

test('Hostile text is read in time proportional to its size', () => {
  const time = (text: string) => { const started = performance.now(); const result = resolve(text, [scope({ a: 'v' })]); return { ms: performance.now() - started, length: result.text.length }; };
  assert.ok(time('{{'.repeat(500_000)).ms < 500);
  assert.ok(time('{{ '.repeat(300_000) + '}}').ms < 500);
  assert.ok(time('}}{{'.repeat(250_000)).ms < 500);
  assert.ok(time('{{a}}'.repeat(100_000)).ms < 1500);
  assert.ok(time(`{{${'x'.repeat(1 << 20)}}}`).ms < 500);
  assert.equal(time('{{a}}'.repeat(5)).length, 5);
});

test('The scopes of a request run from what it set while running, through the folders nearest first and the environment, to the workspace', () => {
  const level = (name: string, vars: Var[], kind: 'collection' | 'folder' = 'folder'): Level => ({ kind, name, container: { ...newContainer(`id-${name}`, name), vars } });
  const environment = { ...newEnvironment('e1', 'dev'), vars: [variable('v', 'environment'), variable('onlyEnv', 'e')] };
  const workspace = { ...newWorkspaceFile(), vars: [variable('v', 'workspace'), variable('onlyWorkspace', 'w')] };
  const levels = [level('Shop', [variable('v', 'collection'), variable('c', 'c')], 'collection'), level('Orders', [variable('v', 'folder'), variable('off', 'x', { enabled: false })])];
  const scopes = variableScopes({ runtime: scope({ v: 'runtime' }), levels, environment, workspace });
  assert.equal(resolve('{{v}}', scopes).text, 'runtime');
  assert.equal(resolve('{{v}}', variableScopes({ levels, environment, workspace })).text, 'folder');
  assert.equal(resolve('{{v}}', variableScopes({ levels: [levels[0] as Level], environment, workspace })).text, 'collection');
  assert.equal(resolve('{{v}}', variableScopes({ levels: [], environment, workspace })).text, 'environment');
  assert.equal(resolve('{{v}}', variableScopes({ levels: [], workspace })).text, 'workspace');
  assert.equal(resolve('{{v}}', variableScopes({ levels: [], dotenv: scope({ v: 'dotenv' }), workspace })).text, 'dotenv');
  assert.equal(resolve('{{off}} {{onlyEnv}} {{onlyWorkspace}} {{c}}', scopes).text, '{{off}} e w c');
  assert.equal(scopeOf([variable('a', '1'), variable('a', '2'), variable('', 'nameless')]).get('a')?.value, '2', 'the last of a repeated name wins');
  assert.equal(scopeOf([variable('', 'nameless')]).size, 0);
});

test('The variables a request can use are listed once each, the strongest definition winning, with where each comes from and no value for a secret', () => {
  const collection: Level = { kind: 'collection', name: 'Shop', container: { ...newContainer('c', 'Shop'), vars: [variable('host', 'collection-host'), variable('only-collection', 'c'), variable('off', 'x', { enabled: false })] } };
  const folder: Level = { kind: 'folder', name: 'Orders', container: { ...newContainer('f', 'Orders'), vars: [variable('host', 'folder-host'), variable('token', 'folder-secret', { secret: true })] } };
  const environment = { ...newEnvironment('e', 'Dev'), vars: [variable('host', 'env-host'), variable('only-env', 'e'), variable('token', 'env-secret', { secret: true }), variable('', 'nameless')] };
  const workspace = { ...newWorkspaceFile(), vars: [variable('only-workspace', 'w'), variable('host', 'workspace-host'), variable('only-env', 'shadowed')] };
  const listed = describeVariables({ levels: [collection, folder], environment, workspace, runtime: new Map([['run', { value: 'r', secret: false }], ['hidden', { value: 'shh', secret: true }]]) });
  assert.deepEqual(listed.map(item => [item.name, item.value, item.secret, item.source]), [
    ['hidden', '', true, 'this run'], ['host', 'folder-host', false, 'folder Orders'], ['only-collection', 'c', false, 'collection Shop'], ['only-env', 'e', false, 'environment Dev'],
    ['only-workspace', 'w', false, 'workspace'], ['run', 'r', false, 'this run'], ['token', '', true, 'folder Orders']
  ]);
  assert.ok(!JSON.stringify(listed).includes('secret') || !JSON.stringify(listed).includes('folder-secret'), 'the value of a secret is nowhere');
  assert.ok(!JSON.stringify(listed).includes('shh') && !JSON.stringify(listed).includes('env-secret'));
  assert.deepEqual(describeVariables({ levels: [], workspace: newWorkspaceFile() }), []);
  assert.equal(describeVariables({ levels: [], workspace, runtime: new Map([['host', { value: 'run-host', secret: false }]]) }).find(item => item.name === 'host')?.value, 'run-host', 'what a run has set beats the files');
});

test('A dynamic word is known when it makes a value', () => {
  for (const word of ['$guid', '$uuid', '$timestamp', '$isoTimestamp', '$randomInt', '$randomInt 1 6', '$randomBoolean', '$randomString 8', '$randomEmail', '$timestamp 1 h', '$timestamp -2 d']) assert.equal(isKnownDynamic(word), true, word);
  for (const word of ['$nothing', '$randomInt x', '$guid extra', '$', 'guid', '']) assert.equal(isKnownDynamic(word), false, word);
});
