import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { OUTPUT_LIMITS, parseOutput, type ScriptInput, type ScriptOutput } from '../../src/script/outcome';
import { PRELUDE_SOURCE } from '../../src/script/prelude';
import type { HostOps, Limits } from '../../src/script/protocol';
import { ScriptSandbox } from '../../src/script/sandbox';

/**
 * The API the scripts see (`pm`, `postman`, `console`, `require`, `setTimeout`, `btoa`, `atob`), run in the real engine through the real sandbox, the way
 * a script of a collection runs. What each call gives back, what a script changes, and what the extension is told.
 */
const repository = join(__dirname, '..', '..', '..');
const sandbox = new ScriptSandbox({
  workerPath: join(__dirname, '..', '..', 'src', 'script', 'worker.js'),
  wasmPath: join(repository, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'),
  limits: { cpuMs: 1500, wallMs: 8000 }
});
after(async () => { await sandbox.dispose(); });

const BASE: ScriptInput = {
  phase: 'test',
  info: { requestName: 'List', requestId: 'R1', iteration: 0, iterationCount: 1 },
  environmentName: 'Dev',
  variables: { environment: { host: 'h', token: 'tt' }, collection: { c1: 'x' }, globals: { g1: 'y' }, merged: { host: 'h', token: 'tt', c1: 'x', g1: 'y' } },
  request: { method: 'GET', url: 'https://api.test/pets?limit=10#top', headers: [['Accept', 'application/json']], body: { mode: 'raw', raw: '{"a":1}' } },
  response: { code: 200, status: 'OK', headers: [['Content-Type', 'application/json'], ['X-Id', '42'], ['X-Dup', 'a'], ['X-Dup', 'b']], body: '{"id":7,"name":"Rex","tags":["a","b"],"n":null}', responseTime: 120, size: 48, cookies: [{ name: 'sid', value: 'abc' }] },
  cookies: [{ name: 'sid', value: 'abc' }, { name: 'theme', value: 'dark' }],
  iterationData: { row: '1' },
  scripts: []
};
const PRE: Partial<ScriptInput> = { phase: 'prerequest', response: null };

async function runScripts(scripts: string[], patch: Partial<ScriptInput> = {}, ops: HostOps = {}, limits: Partial<Limits> = {}): Promise<ScriptOutput> {
  const input: ScriptInput = { ...BASE, ...patch, scripts: scripts.map((code, index) => ({ code, from: `script ${index + 1}` })) };
  const outcome = await sandbox.run({ source: PRELUDE_SOURCE, input: JSON.stringify(input) }, ops, { limits });
  assert.ok(outcome.ok, outcome.ok ? '' : `${outcome.kind}: ${outcome.message}`);
  const parsed = parseOutput(outcome.ok ? outcome.result : '');
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.deepEqual(parsed.ok ? parsed.value.error : null, null, parsed.ok ? JSON.stringify(parsed.value.error) : '');
  return parsed.ok ? parsed.value : (undefined as never);
}
const logged = async (script: string, patch: Partial<ScriptInput> = {}, ops: HostOps = {}): Promise<string[]> => (await runScripts([script], patch, ops)).logs.map(entry => entry.text);
/** Runs `body` as a test and says whether it passed, and the message when it did not. */
const check = async (body: string, patch: Partial<ScriptInput> = {}): Promise<{ passed: boolean; message: string }> => {
  const output = await runScripts([`pm.test('t', () => { ${body} });`], patch);
  const [entry] = output.tests;
  return { passed: entry?.passed === true, message: entry?.message ?? 'no test ran' };
};
const passes = async (body: string): Promise<void> => { const result = await check(body); assert.equal(result.passed, true, `${body}: ${result.message}`); };
const fails = async (body: string, message: RegExp): Promise<void> => { const result = await check(body); assert.equal(result.passed, false, `${body} passed`); assert.match(result.message, message, body); };

test('The globals of the engine with the API loaded are the ones of the language and the API, and what the API hides is gone', async () => {
  const names = (await logged("console.log(Object.getOwnPropertyNames(globalThis).sort().join(' '));"))[0]?.split(' ') ?? [];
  const language = ['AggregateError', 'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'Float16Array', 'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'InternalError', 'Iterator', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'eval', 'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined'];
  const api = ['__result', 'atob', 'btoa', 'clearTimeout', 'console', 'pm', 'postman', 'require', 'setTimeout'];
  assert.deepEqual(names.filter(name => !language.includes(name) && !api.includes(name)), [], 'a global that is not on the list: decide whether the scripts may have it');
  assert.ok(['__host', '__input', '__hash', '__hmac', '__random', 'process', 'fetch', 'SharedArrayBuffer', 'Atomics'].every(name => !names.includes(name)), 'the raw functions of the extension are not within reach of a script');
});

test('A script cannot get to the raw operations the API is built on', async () => {
  assert.deepEqual(await logged("console.log(typeof __host, typeof __hash, typeof __hmac, typeof __random, typeof __input);"), ['undefined undefined undefined undefined undefined']);
});

test('Chai: what passes and what fails, with the sentence that says why', async () => {
  for (const body of [
    'pm.expect(1).to.equal(1)', "pm.expect('a').to.eql('a')", 'pm.expect({a: [1, {b: 2}]}).to.eql({a: [1, {b: 2}]})', 'pm.expect({a: 1}).to.deep.equal({a: 1})', 'pm.expect(5).to.be.above(4)', 'pm.expect(5).to.be.at.least(5)',
    'pm.expect(5).to.be.below(6)', 'pm.expect(5).to.be.at.most(5)', 'pm.expect(5).to.be.within(1, 10)', 'pm.expect(1.05).to.be.closeTo(1, 0.1)', "pm.expect('s').to.be.a('string')", 'pm.expect([]).to.be.an("array")',
    'pm.expect(null).to.be.a("null")', 'pm.expect({}).to.be.an("object")', 'pm.expect(1).to.be.ok', 'pm.expect(true).to.be.true', 'pm.expect(false).to.be.false', 'pm.expect(null).to.be.null', 'pm.expect(undefined).to.be.undefined',
    'pm.expect(NaN).to.be.NaN', 'pm.expect(0).to.exist', 'pm.expect([]).to.be.empty', "pm.expect('').to.be.empty", 'pm.expect({}).to.be.empty', "pm.expect({a: 1}).to.have.property('a')", "pm.expect({a: 1}).to.have.property('a', 1)",
    "pm.expect({a: 1}).to.have.own.property('a')", "pm.expect({a: {b: 2}}).to.have.property('a').that.eql({b: 2})", "pm.expect({a: 1, b: 2}).to.have.keys('a', 'b')", "pm.expect({a: 1, b: 2}).to.have.any.keys('a', 'z')",
    "pm.expect({a: 1, b: 2}).to.contain.keys('a')", "pm.expect('hello').to.include('ell')", 'pm.expect([1, 2, 3]).to.include(2)', 'pm.expect({a: 1, b: 2}).to.include({a: 1})', 'pm.expect([1, 2, 3]).to.have.lengthOf(3)',
    "pm.expect('abc').to.have.length(3)", 'pm.expect("abc").to.match(/b/)', "pm.expect('abc').to.have.string('bc')", 'pm.expect(2).to.be.oneOf([1, 2])', 'pm.expect([1, 2]).to.have.members([2, 1])', 'pm.expect(4).to.satisfy(n => n % 2 === 0)',
    "pm.expect(() => { throw new TypeError('bad'); }).to.throw()", "pm.expect(() => { throw new TypeError('bad'); }).to.throw('bad')", 'pm.expect(() => { throw new TypeError("bad"); }).to.throw(TypeError)', 'pm.expect(new Date()).to.be.instanceof(Date)',
    'pm.expect(1).to.not.equal(2)', 'pm.expect(5).to.not.be.above(10)', "pm.expect('abc').to.not.include('z')", 'pm.expect(null).to.not.exist', "pm.expect({}).to.not.have.property('a')", 'pm.expect(1).to.be.ok.and.to.equal(1)',
    'pm.expect(5).to.be.above(1).and.below(9)', "pm.expect('{\"a\":1}').to.be.json"
  ]) await passes(body);
  await fails('pm.expect(1).to.equal(2)', /^AssertionError: expected 1 to equal 2$/);
  await fails("pm.expect('1').to.equal(1)", /expected "1" to equal 1/);
  await fails('pm.expect(0).to.equal(false)', /expected 0 to equal false/);
  await fails('pm.expect([1]).to.eql([1, 2])', /deeply equal/);
  await fails('pm.expect({ a: 1 }).to.eql({ a: 1, b: 2 })', /deeply equal/);
  await fails('pm.expect({ a: 1, b: 2 }).to.eql({ a: 1 })', /deeply equal/);
  await fails('pm.expect({ a: 1 }).to.eql({ a: 2 })', /deeply equal/);
  await fails('pm.expect([1, 2]).to.eql({ 0: 1, 1: 2 })', /deeply equal/);
  await passes('pm.expect(NaN).to.equal(NaN); pm.expect(null).to.eql(null)');
  await fails("pm.expect('a').to.equal('b')", /expected "a" to equal "b"/);
  await fails('pm.expect({a: 1}).to.equal({a: 1})', /expected \{ a: 1 \} to equal \{ a: 1 \}/);
  await fails('pm.expect([1]).to.eql([2])', /expected \[ 1 \] to deeply equal \[ 2 \]/);
  await fails('pm.expect(1).to.be.above(5)', /expected 1 to be above 5/);
  await fails('pm.expect("x").to.be.above(5)', /expected "x" to be above 5/);
  await fails('pm.expect(1).to.be.within(2, 3)', /to be within 2..3/);
  await fails("pm.expect(1).to.be.a('string')", /expected 1 to be string/);
  await fails('pm.expect(0).to.be.ok', /expected 0 to be truthy/);
  await fails('pm.expect(true).to.be.false', /expected true to be false/);
  await fails('pm.expect(null).to.exist', /expected null to exist/);
  await fails('pm.expect([1]).to.be.empty', /expected \[ 1 \] to be empty/);
  await fails("pm.expect({a: 1}).to.have.property('b')", /expected \{ a: 1 \} to have property "b"/);
  await fails("pm.expect({a: 1}).to.have.property('a', 2)", /to have property "a" of 2, but got 1/);
  await fails("pm.expect('abc').to.include('z')", /expected "abc" to include "z"/);
  await fails('pm.expect([1, 2]).to.have.lengthOf(3)', /to have length 3 but got 2/);
  await fails('pm.expect(2).to.not.equal(2)', /expected 2 not to equal 2/);
  await fails('pm.expect(5).to.not.be.above(1)', /not to be above 1/);
  await fails("pm.expect(() => {}).to.throw()", /expected the function to throw/);
  await fails("pm.expect(() => { throw new Error('a'); }).to.throw('b')", /expected the function to throw "b"/);
  await fails("pm.expect('x', 'the thing').to.equal('y')", /^AssertionError: the thing: expected "x" to equal "y"$/);
  await fails("pm.expect('not json').to.be.json", /be JSON/);
});

test('A long value in a message is cut, an object is shown short, and a cycle does not hang the script', async () => {
  const result = await check("pm.expect('x'.repeat(500)).to.equal('y');");
  assert.ok(result.message.length < 400 && result.message.includes('...'), result.message);
  const cyclic = await check('const a = {}; a.self = a; pm.expect(a).to.equal(1);');
  assert.equal(cyclic.passed, false);
  assert.ok(cyclic.message.length < 300, cyclic.message);
  const many = await check('pm.expect(Array.from({length: 50}, (_, i) => i)).to.equal(1);');
  assert.match(many.message, /\.\.\. 40 more/);
});

test('pm.test records a pass, a failure with its message, a skip, a test that returns a promise, and one that never finishes', async () => {
  const output = await runScripts([`
    pm.test('passes', () => {});
    pm.test('fails', () => { pm.expect(1).to.equal(2); });
    pm.test('throws', () => { throw new TypeError('x'); });
    pm.test.skip('skipped');
    pm.test('async passes', async () => { await __wait(); pm.expect(1).to.equal(1); });
    pm.test('async fails', () => Promise.reject(new Error('later')));
    pm.test('never', () => new Promise(() => {}));
    pm.test('a name that is long ' + 'x'.repeat(500), () => {});
    function __wait() { return new Promise(resolve => setTimeout(resolve, 1)); }
  `], {}, { sleep: async () => '' });
  assert.deepEqual(output.tests.map(item => [item.name.slice(0, 20), item.passed, item.message, item.skipped]), [
    ['passes', true, '', false], ['fails', false, 'AssertionError: expected 1 to equal 2', false], ['throws', false, 'TypeError: x', false], ['skipped', false, 'skipped', true], ['async passes', true, '', false],
    ['async fails', false, 'Error: later', false], ['never', false, 'did not finish', false], ['a name that is long ', true, '', false]
  ]);
  assert.ok(output.tests[7]?.name.length === OUTPUT_LIMITS.testNameChars);
});

test('pm.response: the status, the headers in any case, the body as text or JSON, the cookies, and the shorthands of Postman', async () => {
  for (const body of [
    'pm.expect(pm.response.code).to.equal(200)', "pm.expect(pm.response.status).to.equal('OK')", 'pm.expect(pm.response.responseTime).to.equal(120)', "pm.expect(pm.response.headers.get('content-type')).to.equal('application/json')",
    "pm.expect(pm.response.headers.has('X-ID')).to.be.true", "pm.expect(pm.response.headers.get('x-dup')).to.equal('a')", "pm.expect(pm.response.headers.toObject()).to.have.property('X-Id', '42')", "pm.expect(pm.response.json().name).to.equal('Rex')",
    'pm.expect(pm.response.json().n).to.be.null', "pm.expect(pm.response.text()).to.include('Rex')", "pm.expect(pm.response.cookies.get('sid')).to.equal('abc')", "pm.expect(pm.response.cookies.has('nope')).to.be.false",
    'pm.response.to.have.status(200)', "pm.response.to.have.status('OK')", "pm.response.to.have.header('x-id')", "pm.response.to.have.header('x-id', '42')", 'pm.response.to.be.ok', 'pm.response.to.be.success', 'pm.response.to.be.json',
    "pm.response.to.have.body(/Rex/)", "pm.response.to.have.jsonBody('name', 'Rex')", "pm.response.to.have.jsonBody('tags')", 'pm.expect(pm.response.size().total).to.equal(48)'
  ]) await passes(body);
  await fails('pm.response.to.have.status(404)', /expected response to have status code 404 but got 200 OK/);
  await fails("pm.response.to.have.status('Not Found')", /status reason "Not Found" but got 200 OK/);
  await fails("pm.response.to.have.header('x-nope')", /have header "x-nope"/);
  await fails("pm.response.to.have.header('x-id', '1')", /header "x-id" to be "1" but got "42"/);
  await fails('pm.response.to.be.error', /expected response to be an error \(4xx or 5xx\) but got 200 OK/);
  await fails('pm.response.to.be.notFound', /not found \(404\)/);
  await fails("pm.response.to.have.jsonBody('nothing')", /have "nothing"|have\s+"nothing"/);
  await fails("pm.response.to.have.jsonBody('name', 'Felix')", /"name" to be "Felix" but got "Rex"/);
  const missing = await runScripts(["pm.test('t', () => { pm.response.json(); });"], { response: { ...BASE.response!, body: null, bodyNote: 'The body is not text.' } });
  assert.equal(missing.tests[0]?.message, 'Error: The body is not text.');
  const notJson = await runScripts(["pm.test('t', () => { pm.response.json(); });"], { response: { ...BASE.response!, body: 'plain' } });
  assert.match(notJson.tests[0]?.message ?? '', /SyntaxError/);
  const before = await runScripts(["console.log(typeof pm.response);"], PRE);
  assert.deepEqual(before.logs.map(item => item.text), ['undefined']);
  const redirected = await check('pm.response.to.be.error', { response: { ...BASE.response!, code: 302, status: 'Found' } });
  assert.equal(redirected.passed, false, 'a redirection is not an error');
  const missingPage = await check('pm.response.to.be.clientError', { response: { ...BASE.response!, code: 404, status: 'Not Found' } });
  assert.equal(missingPage.passed, true);
  const error = await check('pm.response.to.be.error', { response: { ...BASE.response!, code: 503, status: 'Service Unavailable' } });
  assert.equal(error.passed, true);
  const serverError = await check('pm.response.to.be.serverError', { response: { ...BASE.response!, code: 503, status: 'Service Unavailable' } });
  assert.equal(serverError.passed, true);
});

test('Variables: reads see the starting values, writes are noted by scope, and a name has to be a name', async () => {
  const output = await runScripts([`
    console.log(pm.environment.get('token'), pm.variables.get('host'), pm.globals.get('g1'), pm.collectionVariables.get('c1'), pm.variables.has('nope'), pm.environment.has('host'));
    pm.environment.set('token', 'new'); pm.environment.set('count', 5); pm.globals.set('g2', true); pm.collectionVariables.set('c2', { a: 1 }); pm.variables.set('v', 'local');
    pm.environment.unset('host'); pm.globals.unset('g1');
    console.log(pm.environment.get('token'), pm.environment.get('count'), pm.environment.has('host'), pm.variables.get('v'), pm.collectionVariables.get('c2'));
    console.log(pm.variables.replaceIn('{{token}}/{{host}}/{{nope}}/{{ v }}'));
    console.log(JSON.stringify(pm.environment.toObject()), pm.environment.name, pm.info.eventName, pm.info.requestName, pm.iterationData.get('row'), pm.iterationData.has('x'));
    try { pm.environment.set('bad name', 1); } catch (e) { console.log('refused:', e.message); }
    try { pm.environment.set('1x', 1); } catch (e) { console.log('refused:', e.message.slice(0, 20)); }
  `]);
  assert.deepEqual(output.logs.map(entry => entry.text), [
    'tt h y x false true', 'new 5 false local {"a":1}', 'new/{{host}}/{{nope}}/local', '{"token":"new","count":"5"} Dev test List 1 false',
    'refused: "bad name" is not a name a variable can have (letters, digits, _ . -, not starting with a digit)', 'refused: "1x" is not a name a'
  ]);
  assert.deepEqual(output.variables.active, { set: [['token', 'new'], ['count', '5']], unset: ['host'] });
  assert.deepEqual(output.variables.local, { set: [['c2', '{"a":1}'], ['v', 'local']], unset: [] });
  assert.deepEqual(output.variables.global, { set: [['g2', 'true']], unset: ['g1'] });
});

test('Variables: clear, unset after set, set after unset, and the names that could be trouble are names', async () => {
  const output = await runScripts([`
    pm.environment.set('a', '1'); pm.environment.unset('a'); pm.environment.set('b', '1'); pm.environment.unset('b'); pm.environment.set('b', '2');
    pm.globals.clear();
    pm.collectionVariables.set('__proto__', 'x'); pm.collectionVariables.set('constructor', 'y'); pm.collectionVariables.set('toString', 'z');
    console.log(pm.collectionVariables.get('__proto__'), pm.collectionVariables.get('constructor'), pm.collectionVariables.get('toString'), Object.keys(pm.collectionVariables.toObject()).join());
    console.log(({}).polluted, typeof ({}).x);
  `]);
  assert.deepEqual(output.variables.active, { set: [['b', '2']], unset: ['a'] });
  assert.deepEqual(output.variables.global, { set: [], unset: ['g1'] });
  assert.deepEqual(output.variables.local?.set, [['__proto__', 'x'], ['constructor', 'y'], ['toString', 'z']]);
  assert.deepEqual(output.logs.map(entry => entry.text), ['x y z c1,__proto__,constructor,toString', 'undefined undefined']);
});

test('pm.request before the request is sent: headers, address, method and body can be changed, and the changes are listed', async () => {
  const output = await runScripts([`
    pm.request.headers.add({ key: 'X-New', value: '1' });
    pm.request.headers.upsert({ key: 'accept', value: 'text/plain' });
    pm.request.headers.upsert({ key: 'X-Other', value: '2' });
    pm.request.headers.remove('nothing');
    console.log(pm.request.headers.get('ACCEPT'), pm.request.headers.has('x-new'), JSON.stringify(pm.request.headers.toObject()), pm.request.headers.count());
    pm.request.url.addQueryParams('a=1&b=2');
    pm.request.url.query.add({ key: 'c', value: '3' });
    pm.request.url.query.remove('limit');
    pm.request.url.query.upsert({ key: 'a', value: '9' });
    console.log(pm.request.url.toString(), pm.request.url.getHost(), pm.request.url.getPath(), pm.request.url.getProtocol(), pm.request.url.query.get('b'), pm.request.url.query.has('zzz'), JSON.stringify(pm.request.url.query.toObject()));
    pm.request.method = 'post';
    pm.request.body.raw = '{"changed":true}';
    console.log(pm.request.method, pm.request.body.mode, pm.request.body.toString());
  `], PRE);
  assert.deepEqual(output.logs.map(entry => entry.text), [
    'text/plain true {"Accept":"text/plain","X-New":"1","X-Other":"2"} 3', 'https://api.test/pets?b=2&c=3&a=9#top api.test /pets https 2 false {"b":"2","c":"3","a":"9"}', 'POST raw {"changed":true}'
  ]);
  assert.deepEqual(output.request, { method: 'POST', url: 'https://api.test/pets?b=2&c=3&a=9#top', headers: [['Accept', 'text/plain'], ['X-New', '1'], ['X-Other', '2']], bodyRaw: '{"changed":true}' });
  const unchanged = await runScripts(["console.log(pm.request.url.toString(), pm.request.method);"], PRE);
  assert.equal(unchanged.request, undefined, 'nothing changed, nothing to apply');
  const assigned = await runScripts(["pm.request.url = 'https://other.test/x';"], PRE);
  assert.equal(assigned.request?.url, 'https://other.test/x');
  const aString = await runScripts(["pm.request.body.update('raw text');"], PRE);
  assert.equal(aString.request?.bodyRaw, 'raw text');
  const noBody = await runScripts(["console.log(typeof pm.request.body);"], { ...PRE, request: { ...BASE.request, body: null } });
  assert.deepEqual(noBody.logs.map(entry => entry.text), ['undefined']);
});

test('pm.request after the answer is the request that was sent, and cannot be changed', async () => {
  const output = await runScripts([`
    console.log(pm.request.method, pm.request.url.toString(), pm.request.headers.get('accept'));
    for (const change of [() => { pm.request.url = 'x'; }, () => { pm.request.method = 'POST'; }, () => { pm.request.headers.add({ key: 'a', value: 'b' }); }, () => { pm.request.body.raw = 'x'; }, () => pm.request.url.addQueryParams('a=1'), () => pm.execution.skipRequest()]) {
      try { change(); console.log('allowed'); } catch (e) { console.log(e.message); }
    }
  `]);
  assert.deepEqual(output.logs.map(entry => entry.text), [
    'GET https://api.test/pets?limit=10#top application/json', 'The address cannot be changed after the request was sent.', 'The method cannot be changed after the request was sent.', 'The headers cannot be changed after the request was sent.',
    'The body cannot be changed after the request was sent.', 'The address cannot be changed after the request was sent.', 'skipRequest can only be called before the request is sent.'
  ]);
  assert.equal(output.request, undefined);
});

test('Skipping a request and choosing the next one are noted', async () => {
  const skipped = await runScripts(["pm.execution.skipRequest(); pm.setNextRequest('Next one');"], PRE);
  assert.deepEqual([skipped.skip, skipped.nextRequest], [true, 'Next one']);
  const stop = await runScripts(['postman.setNextRequest(null);']);
  assert.deepEqual([stop.skip, stop.nextRequest], [false, null]);
  const alias = await runScripts(["pm.execution.setNextRequest('B');"]);
  assert.equal(alias.nextRequest, 'B');
  const none = await runScripts(['console.log(1);']);
  assert.deepEqual([none.skip, 'nextRequest' in none], [false, false]);
});

test('pm.sendRequest asks the extension, gives the answer as a response, and tells a failure to the callback; a timer is a wait the extension counts', async () => {
  const seen: unknown[] = [];
  const ops: HostOps = {
    http: async text => { const request = JSON.parse(text) as { url: string; method: string; headers: [string, string][]; body?: string }; seen.push(request); if (request.url.endsWith('/fail')) throw new Error('connection refused'); return JSON.stringify({ code: 201, status: 'Created', headers: [['X-A', 'b']], body: '{"ok":true}', responseTime: 7, size: 11, cookies: [] }); },
    sleep: async text => { seen.push(`sleep ${text}`); return ''; }
  };
  const output = await runScripts([`
    pm.sendRequest('https://x.test/a', (err, res) => { console.log('cb', err, res.code, res.json().ok, res.headers.get('x-a')); });
    pm.sendRequest({ url: 'https://x.test/b', method: 'post', header: { A: 'b' }, body: { mode: 'raw', raw: 'payload' } }).then(res => console.log('promise', res.status));
    pm.sendRequest({ url: 'https://x.test/c', header: [{ key: 'K', value: 'v' }], body: { mode: 'urlencoded', urlencoded: [{ key: 'a b', value: 'c&d' }] } }, () => {});
    pm.sendRequest('https://x.test/fail', (err, res) => { console.log('error:', err.message, res); });
    setTimeout(() => console.log('timer', 1), 10);
    setTimeout(() => console.log('cleared'), 10);
    const id = setTimeout(() => console.log('never'), 10); clearTimeout(id);
    setTimeout(() => console.log('long'), 999999);
  `], {}, ops);
  assert.deepEqual(output.logs.map(entry => entry.text).sort(), ['cb null 201 true b', 'cleared', 'error: connection refused null', 'long', 'promise Created', 'timer 1']);
  assert.deepEqual(seen.filter(item => typeof item === 'object'), [
    { url: 'https://x.test/a', method: 'GET', headers: [] }, { url: 'https://x.test/b', method: 'POST', headers: [['A', 'b']], body: 'payload' },
    { url: 'https://x.test/c', method: 'GET', headers: [['K', 'v']], body: 'a%20b=c%26d' }, { url: 'https://x.test/fail', method: 'GET', headers: [] }
  ]);
  assert.ok(seen.includes('sleep 5000'), 'a wait is cut to five seconds');
  assert.ok(seen.includes('sleep 10'));
});

test('An error in a callback is noted and does not stop the others, and a script that throws stops the scripts after it', async () => {
  const ops: HostOps = { http: async () => JSON.stringify({ code: 200, status: 'OK', headers: [], body: '', responseTime: 1, size: 0, cookies: [] }), sleep: async () => '' };
  const callback = await runScripts(["pm.sendRequest('https://x.test', () => { throw new Error('in callback'); }); setTimeout(() => { throw new Error('in timer'); }, 1); setTimeout(() => console.log('still runs'), 2);"], {}, ops);
  assert.deepEqual(callback.asyncErrors.sort(), ['in callback', 'in timer']);
  assert.deepEqual(callback.logs.map(entry => entry.text), ['still runs']);
  const input: ScriptInput = { ...BASE, scripts: [{ code: "console.log('first'); null.x;", from: 'collection Shop' }, { code: "console.log('never');", from: 'request' }] };
  const outcome = await sandbox.run({ source: PRELUDE_SOURCE, input: JSON.stringify(input) }, {});
  const parsed = parseOutput(outcome.ok ? outcome.result : '');
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.logs.map(entry => entry.text), ['first']);
    assert.deepEqual([parsed.value.error?.from, parsed.value.error?.name, parsed.value.error?.message], ['collection Shop', 'TypeError', "cannot read property 'x' of null"]);
  }
  const syntax = await sandbox.run({ source: PRELUDE_SOURCE, input: JSON.stringify({ ...BASE, scripts: [{ code: 'nope(', from: 'request' }] }) }, {});
  const parsedSyntax = parseOutput(syntax.ok ? syntax.result : '');
  assert.ok(parsedSyntax.ok && parsedSyntax.value.error?.name === 'SyntaxError');
});

test('Scripts run in order in the same global scope, so a function of the collection is there for the request', async () => {
  const output = await runScripts(['var shared = 41; function twice(n) { return n * 2; }', "console.log(twice(shared) + 0, typeof shared); pm.test('uses it', () => { pm.expect(twice(2)).to.equal(4); });"]);
  assert.deepEqual(output.logs.map(entry => entry.text), ['82 number']);
  assert.equal(output.tests[0]?.passed, true);
});

test('require gives crypto-js, uuid and chai, and says what is there when asked for something else', async () => {
  const sha = (algorithm: string, text: string): string => createHash(algorithm).update(text).digest('hex');
  const hmac = (algorithm: string, key: string, text: string): string => createHmac(algorithm, key).update(text).digest('hex');
  const output = await runScripts([`
    const CryptoJS = require('crypto-js');
    console.log(CryptoJS.SHA256('abc').toString());
    console.log(CryptoJS.MD5('abc').toString(), CryptoJS.SHA1('abc').toString(), CryptoJS.SHA512('').toString());
    console.log(CryptoJS.MD5('abc').toString(CryptoJS.enc.Base64));
    console.log(CryptoJS.HmacSHA256('The quick brown fox jumps over the lazy dog', 'key').toString());
    console.log(CryptoJS.HmacMD5('msg', 'k').toString(), CryptoJS.HmacSHA1('msg', 'k').toString(), CryptoJS.HmacSHA512('msg', 'k').toString());
    console.log(CryptoJS.SHA256('h\\u00e9llo \\ud83d\\ude00').toString());
    console.log(CryptoJS.enc.Hex.stringify(CryptoJS.enc.Utf8.parse('h\\u00e9llo')), CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Hex.parse('68c3a96c6c6f')), CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('hi')), CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse('aGk=')));
    console.log(CryptoJS.SHA256(CryptoJS.enc.Hex.parse('616263')).toString() === CryptoJS.SHA256('abc').toString(), CryptoJS.HmacSHA256('m', CryptoJS.enc.Hex.parse('6b6579')).toString() === CryptoJS.HmacSHA256('m', 'key').toString());
    const id = require('uuid').v4();
    console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), id !== require('uuid').v4());
    console.log(require('chai').expect(1).to.equal(1) !== undefined);
    console.log(btoa('hello'), atob('aGVsbG8='), btoa('').length, atob('').length, btoa('\\u00ff\\u00fe'), atob('//4=').charCodeAt(0), atob('//4=').charCodeAt(1));
    try { btoa('\\u0100'); } catch (e) { console.log('latin1:', e.message.slice(0, 30)); }
    try { require('lodash'); } catch (e) { console.log(e.message); }
    try { require('fs'); } catch (e) { console.log(e.message.slice(0, 30)); }
  `]);
  const lines = output.logs.map(entry => entry.text);
  assert.deepEqual(lines, [
    sha('sha256', 'abc'),
    `${sha('md5', 'abc')} ${sha('sha1', 'abc')} ${sha('sha512', '')}`,
    createHash('md5').update('abc').digest('base64'),
    hmac('sha256', 'key', 'The quick brown fox jumps over the lazy dog'),
    `${hmac('md5', 'k', 'msg')} ${hmac('sha1', 'k', 'msg')} ${hmac('sha512', 'k', 'msg')}`,
    sha('sha256', `h${String.fromCodePoint(0xe9)}llo ${String.fromCodePoint(0x1f600)}`),
    `68c3a96c6c6f h${String.fromCodePoint(0xe9)}llo aGk= hi`,
    'true true',
    'true true',
    'true',
    `aGVsbG8= hello 0 0 ${Buffer.from([0xff, 0xfe]).toString('base64')} 255 254`,
    'latin1: The string to be encoded conta',
    'Cannot find module "lodash". This client provides: crypto-js, uuid, chai.',
    'Cannot find module "fs". This '
  ]);
});

test('console keeps the lines in order with their level, shows objects short, and stops keeping lines at a limit', async () => {
  const output = await runScripts([`
    console.log('a', 1, true, null, undefined, { x: 1, y: [1, 2] }); console.info('b'); console.warn('c'); console.error('d'); console.debug('e');
    console.log([1, 'two', { three: 3 }], function f() {}, 5n, Symbol.iterator === undefined);
    console.log('x'.repeat(5000));
    for (let i = 0; i < 1000; i++) console.log('line ' + i);
  `]);
  assert.deepEqual(output.logs.slice(0, 5).map(entry => [entry.level, entry.text]), [['log', 'a 1 true null undefined { x: 1, y: [ 1, 2 ] }'], ['info', 'b'], ['warn', 'c'], ['error', 'd'], ['debug', 'e']]);
  assert.equal(output.logs[5]?.text, '[ 1, "two", { three: 3 } ] [Function: f] 5n false');
  assert.equal(output.logs[6]?.text.length, OUTPUT_LIMITS.logChars, 'a long line is cut');
  assert.equal(output.logs.length, OUTPUT_LIMITS.logs);
  assert.equal(output.logsCut, true, 'and it is said that lines were left out');
});

test('The output is read as untrusted data: a text that is not JSON or not an object is refused, and what is wrong inside is dropped or cut', () => {
  assert.equal(parseOutput('').ok, true, 'a script that gives nothing back gives nothing');
  for (const bad of ['not json', '[]', '"text"', 'null', '5']) assert.equal(parseOutput(bad).ok, false, bad);
  const hostile = JSON.stringify({
    logs: [{ level: 'weird', text: 'x'.repeat(10_000) }, 'not an object', { text: 5 }, ...Array.from({ length: 600 }, () => ({ level: 'log', text: 'l' }))],
    tests: [{ name: 'n'.repeat(1000), passed: 'yes', message: 'm'.repeat(5000) }, null, { name: 'ok', passed: true }, ...Array.from({ length: 600 }, () => ({ name: 't', passed: true }))],
    variables: {
      active: { set: [['good', 'v'], ['bad name', 'x'], ['1x', 'x'], ['n'.repeat(300), 'x'], ['num', 5], 'nope', ['big', 'z'.repeat(300_000)], ['__proto__', 'p']], unset: ['u', 5, 'bad name', '__proto__'] },
      local: { set: [], unset: [] }, global: 'nothing', other: { set: [['x', 'y']], unset: [] }
    },
    skip: 'true', nextRequest: 'n'.repeat(1000), error: { from: 'f'.repeat(500), name: 'N'.repeat(500), message: 'm'.repeat(5000) }, asyncErrors: Array.from({ length: 20 }, () => 'e'.repeat(5000)),
    request: { method: 'get', url: 'https://x.test/\r\nHost: evil', headers: [['Good', 'v'], ['Bad Name', 'v'], ['X', 'a\r\nInjected: 1'], ['Y', 'v\u0000'], ['Z', 5], 'no'], bodyRaw: 5 }, extra: { anything: 1 }
  });
  const parsed = parseOutput(hostile);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const value = parsed.value;
  assert.equal(value.logs.length, OUTPUT_LIMITS.logs);
  assert.deepEqual([value.logs[0]?.level, value.logs[0]?.text.length, value.logs[1]?.level, value.logs[1]?.text], ['log', OUTPUT_LIMITS.logChars, 'log', '']);
  assert.equal(value.tests.length, OUTPUT_LIMITS.tests);
  assert.deepEqual([value.tests[0]?.name.length, value.tests[0]?.passed, value.tests[0]?.message.length, value.tests[1]?.name, value.tests[1]?.passed], [OUTPUT_LIMITS.testNameChars, false, OUTPUT_LIMITS.testMessageChars, 'ok', true]);
  assert.deepEqual(value.variables.active?.set.map(pair => pair[0]), ['good', 'big', '__proto__'], 'bad names and values that are not text are dropped');
  assert.equal(value.variables.active?.set[1]?.[1].length, OUTPUT_LIMITS.variableValueChars);
  assert.deepEqual(value.variables.active?.unset, ['u', '__proto__']);
  assert.deepEqual([value.variables.local, value.variables.global, 'other' in value.variables, Object.hasOwn(value, 'extra')], [undefined, undefined, false, false]);
  assert.deepEqual([value.skip, value.nextRequest?.length], [false, OUTPUT_LIMITS.nextRequestChars], 'only true is true');
  assert.deepEqual([value.error?.from.length, value.error?.name.length, value.error?.message.length], [200, 100, OUTPUT_LIMITS.errorChars]);
  assert.equal(value.asyncErrors.length, OUTPUT_LIMITS.asyncErrors);
  assert.deepEqual(value.request, { headers: [['Good', 'v']] }, 'a method that is not upper case, an address with a line break, a header that could inject another and a body that is not text are dropped');
  const stopped = parseOutput(JSON.stringify({ nextRequest: null }));
  assert.ok(stopped.ok && stopped.value.nextRequest === null, 'null means stop');
});
