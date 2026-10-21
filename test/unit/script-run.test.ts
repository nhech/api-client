import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { newRequest, type KV, type Request } from '../../src/core/model';
import { RuntimeVariables } from '../../src/core/runtime';
import { HTTP_PER_RUN, OUTPUT_LIMITS, parseHttpArgument, type HttpArgument } from '../../src/script/outcome';
import { DEFAULT_LIMITS, type HostOps } from '../../src/script/protocol';
import { describeFailure, runScripts, type ScriptRunner } from '../../src/script/run';
import { ScriptSandbox } from '../../src/script/sandbox';
import { addOutput, emptyReport, requestForScripts, scriptInput, withRequestChanges } from '../../src/view/scripts';

/** The way the extension runs the scripts of a send: what they are given, what they ask for, and what is done with what they answer. */

const repository = join(__dirname, '..', '..', '..');
const sandbox = new ScriptSandbox({
  workerPath: join(__dirname, '..', '..', 'src', 'script', 'worker.js'),
  wasmPath: join(repository, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'),
  limits: { cpuMs: 400, wallMs: 5000 }
});
after(async () => { await sandbox.dispose(); });

const kv = (name: string, value: string): KV => ({ name, value, enabled: true, description: '' });
const request = (change: Partial<Request> = {}): Request => ({ ...newRequest('R1', 'Create order'), method: 'POST', url: '{{host}}/orders', ...change });

const argument = (over: Record<string, unknown> = {}): string => JSON.stringify({ url: 'https://api.test/x', method: 'POST', headers: [['Content-Type', 'application/json']], body: '{"a":1}', ...over });
const refused = (text: string, pattern: RegExp): void => {
  const result = parseHttpArgument(text);
  assert.equal(result.ok, false, text);
  if (!result.ok) assert.match(result.error, pattern, text);
};

test('The request a script wants sent is read whole or refused whole, so the script is told instead of getting a different request', () => {
  const ok = parseHttpArgument(argument());
  assert.deepEqual(ok.ok ? ok.value : undefined, { method: 'POST', url: 'https://api.test/x', headers: [['Content-Type', 'application/json']], body: '{"a":1}' } satisfies HttpArgument);
  const bare = parseHttpArgument(JSON.stringify({ url: 'http://localhost:8080/a?b=c#d', method: 'GET' }));
  assert.deepEqual(bare.ok ? bare.value : undefined, { method: 'GET', url: 'http://localhost:8080/a?b=c#d', headers: [] }, 'no headers and no body are fine');
  const nullBody = parseHttpArgument(argument({ body: null }));
  assert.equal(nullBody.ok && 'body' in nullBody.value, false);
  assert.equal(parseHttpArgument(argument({ url: 'HTTPS://api.test/x' })).ok, true);

  refused('not json', /not JSON/);
  refused('[]', /not an object/);
  refused('null', /not an object/);
  for (const url of [undefined, 5, '', 'api.test/x', 'ftp://api.test/x', 'file:///etc/passwd', 'javascript:alert(1)', 'https://', 'https://api.test/a b', 'https://api.test/a\nb', `https://api.test/${'a'.repeat(OUTPUT_LIMITS.urlChars)}`]) {
    refused(argument({ url }), /whole http/);
  }
  for (const method of [undefined, 5, '', 'get', 'GeT', 'CONNECT', 'A'.repeat(21), 'GET POST', 'GET\nX']) refused(argument({ method }), /method/);
  assert.equal(parseHttpArgument(argument({ method: 'A'.repeat(20) })).ok, true);
  refused(argument({ headers: 'x' }), /headers/);
  refused(argument({ headers: Array.from({ length: OUTPUT_LIMITS.headers + 1 }, () => ['A', 'b']) }), /headers/);
  for (const bad of [['A'], [1, 'b'], ['A', 2], 'x', null]) refused(argument({ headers: [bad] }), /not a name and a value/);
  for (const bad of [['bad name', 'v'], ['', 'v'], ['A:B', 'v'], ['A', 'x\r\nInjected: 1'], ['A', 'x\ny'], ['A', `a${String.fromCharCode(0)}b`], ['A'.repeat(OUTPUT_LIMITS.headerNameChars + 1), 'v'], ['A', 'v'.repeat(OUTPUT_LIMITS.headerValueChars + 1)]]) {
    refused(argument({ headers: [bad] }), /cannot be sent/);
  }
  assert.equal(parseHttpArgument(argument({ headers: [['A'.repeat(OUTPUT_LIMITS.headerNameChars), 'v'.repeat(OUTPUT_LIMITS.headerValueChars)]] })).ok, true);
  refused(argument({ body: 5 }), /body/);
  refused(argument({ body: {} }), /body/);
  refused(argument({ body: 'x'.repeat(OUTPUT_LIMITS.bodyChars + 1) }), /body/);
  assert.equal(parseHttpArgument(argument({ body: 'x'.repeat(OUTPUT_LIMITS.bodyChars) })).ok, true);
  const inherited = parseHttpArgument(JSON.stringify(Object.create({ url: 'https://a.test/', method: 'GET' })));
  assert.equal(inherited.ok, false, 'JSON has no inherited keys, and a key called __proto__ is only a key');
  refused('{"__proto__":{"url":"https://a.test/"},"method":"GET"}', /whole http/);
  assert.equal(HTTP_PER_RUN, 10);
});

test('Failures are described in words for the person, with the limits that were in force', () => {
  assert.equal(describeFailure('cpu', ''), 'A script computed for more than 1 s and was stopped.');
  assert.equal(describeFailure('wall', ''), 'The scripts took more than 10 s and were stopped.');
  assert.equal(describeFailure('cpu', '', { ...DEFAULT_LIMITS, cpuMs: 2500 }), 'A script computed for more than 2.5 s and was stopped.');
  assert.equal(describeFailure('cancelled', ''), 'The scripts were cancelled.');
  assert.equal(describeFailure('limits', 'too large'), 'The scripts could not run: too large.');
  assert.equal(describeFailure('crashed', 'gone'), 'The script engine stopped working: gone.');
  assert.equal(describeFailure('output', 'not JSON'), 'The answer of the scripts could not be read: not JSON.');
  assert.equal(describeFailure('error', 'TypeError: x'), 'A script failed: TypeError: x');
});

const fakeRunner = (result: Awaited<ReturnType<ScriptRunner['run']>>): ScriptRunner => ({ run: () => Promise.resolve(result) });
const anInput = (scripts: { code: string; from: string }[], over: Partial<Parameters<typeof scriptInput>[0]> = {}) => scriptInput({
  phase: 'prerequest', requestId: 'R1', requestName: 'Create order', environmentName: 'dev', variables: { environment: { host: 'https://api.test' }, collection: {}, globals: {}, merged: { host: 'https://api.test' } },
  request: requestForScripts(request({ headers: [kv('Accept', 'application/json')] })), response: null, cookies: [], scripts, ...over
});

test('A run that was stopped or that broke is a result with the reason, and what the scripts answer is read as data', async () => {
  const stopped = await runScripts(fakeRunner({ ok: false, kind: 'cpu', message: 'interrupted' }), anInput([]), {});
  assert.deepEqual(stopped, { ok: false, kind: 'cpu', message: 'A script computed for more than 1 s and was stopped.' });
  const garbage = await runScripts(fakeRunner({ ok: true, result: 'not json', cpuMs: 1 }), anInput([]), {});
  assert.deepEqual(garbage, { ok: false, kind: 'output', message: 'The answer of the scripts could not be read: the scripts gave back something that is not JSON.' });
  const fine = await runScripts(fakeRunner({ ok: true, result: JSON.stringify({ skip: true, evil: { x: 1 } }), cpuMs: 3 }), anInput([]), {});
  assert.ok(fine.ok);
  assert.deepEqual(fine.ok ? [fine.output.skip, fine.cpuMs, 'evil' in fine.output] : [], [true, 3, false]);
  const empty = await runScripts(fakeRunner({ ok: true, result: '', cpuMs: 0 }), anInput([]), {});
  assert.ok(empty.ok && empty.output.logs.length === 0);
  const limits = await runScripts(fakeRunner({ ok: false, kind: 'wall', message: 'x' }), anInput([]), {}, { limits: { wallMs: 3000 } });
  assert.equal(limits.ok ? '' : limits.message, 'The scripts took more than 3 s and were stopped.');
});

test('Scripts before a request set variables, change the request and the console reports it: the whole way through the real engine', async () => {
  const runtime = new RuntimeVariables();
  const context = { environmentId: 'E1', collection: 'api-client/collections/shop' };
  const original = request({ headers: [kv('Accept', 'application/json')], body: { kind: 'json', text: '{"a":1}' } });
  const code = [
    "pm.environment.set('stamp', 'fixed');",
    "pm.collectionVariables.set('page', '2');",
    "pm.globals.set('who', pm.variables.get('host'));",
    "pm.request.headers.add({ key: 'X-Stamp', value: pm.environment.get('stamp') });",
    "pm.request.method = 'put';",
    "pm.request.url = pm.request.url.toString() + '?page=' + pm.collectionVariables.get('page');",
    "pm.request.body.raw = JSON.stringify({ a: 2 });",
    "console.log('ready for', pm.info.requestName);"
  ].join('\n');
  const run = await runScripts(sandbox, anInput([{ code, from: 'request' }], { request: requestForScripts(original) }), {});
  assert.ok(run.ok, run.ok ? '' : run.message);
  if (!run.ok) return;
  assert.equal(run.output.error, null);
  runtime.change('active', run.output.variables.active ?? { set: [], unset: [] }, context);
  runtime.change('local', run.output.variables.local ?? { set: [], unset: [] }, context);
  runtime.change('global', run.output.variables.global ?? { set: [], unset: [] }, context);
  const seen = runtime.snapshot(context);
  assert.deepEqual([[...seen.active], [...seen.local], [...seen.global]], [[['stamp', 'fixed']], [['page', '2']], [['who', 'https://api.test']]]);
  const changed = withRequestChanges(original, run.output.request ?? {});
  assert.deepEqual([changed.method, changed.url], ['PUT', '{{host}}/orders?page=2']);
  assert.deepEqual(changed.headers.map(row => [row.name, row.value]), [['Accept', 'application/json'], ['X-Stamp', 'fixed']]);
  assert.deepEqual(changed.body, { kind: 'json', text: '{"a":2}' });
  const report = emptyReport();
  addOutput(report, 'pre', run.output, []);
  assert.deepEqual(report.logs, [{ phase: 'pre', level: 'log', text: 'ready for Create order' }]);
  assert.deepEqual(report.saved.map(item => `${item.scope}:${item.variable}`), ['active:stamp', 'local:page', 'global:who']);
});

test('A script that asks for a request is answered by the operation the extension gives it, and a script that throws is reported with the stage it was in', async () => {
  const asked: string[] = [];
  const ops: HostOps = {
    http: async text => { asked.push(text); return JSON.stringify({ code: 200, status: 'OK', headers: [['Content-Type', 'application/json']], body: '{"token":"t-1"}', responseTime: 5, size: 15, cookies: [] }); },
    sleep: async () => ''
  };
  const code = "pm.sendRequest({ url: 'https://auth.test/token', method: 'post', header: { 'X-A': '1' }, body: { mode: 'raw', raw: 'grant=1' } }, (err, res) => { pm.environment.set('fetched', res.json().token); });";
  const run = await runScripts(sandbox, anInput([{ code, from: 'collection Shop' }]), ops);
  assert.ok(run.ok && run.output.error === null);
  assert.deepEqual(asked.map(text => JSON.parse(text)), [{ url: 'https://auth.test/token', method: 'POST', headers: [['X-A', '1']], body: 'grant=1' }]);
  assert.deepEqual(parseHttpArgument(asked[0] ?? '').ok, true, 'what the script asks for passes the check of the extension');
  assert.deepEqual(run.ok ? run.output.variables.active?.set : undefined, [['fetched', 't-1']]);

  const failing = await runScripts(sandbox, anInput([{ code: 'null.x;', from: 'folder Orders' }, { code: "console.log('never');", from: 'request' }]), {});
  assert.ok(failing.ok);
  const report = emptyReport();
  if (failing.ok) addOutput(report, 'post', failing.output, []);
  assert.deepEqual(report.errors.map(item => [item.phase, item.from, item.name]), [['post', 'folder Orders', 'TypeError']]);
  assert.deepEqual(report.logs, [], 'the scripts after the one that failed did not run');
});
