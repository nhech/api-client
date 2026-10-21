import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ScriptSandbox } from '../../src/script/sandbox';
import { MIB, type HostOps, type Limits } from '../../src/script/protocol';

/**
 * The sandbox of the scripts, tried with the scripts a hostile collection could hold. The worker is the compiled one of this build and the
 * module of the engine is the one in node_modules; the limits are short so that the whole suite runs in a few seconds.
 */
const repository = join(__dirname, '..', '..', '..');
const sandbox = new ScriptSandbox({
  workerPath: join(__dirname, '..', '..', 'src', 'script', 'worker.js'),
  wasmPath: join(repository, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'),
  limits: { cpuMs: 300, wallMs: 4000 }
});
after(async () => { await sandbox.dispose(); });

const NO_OPS: HostOps = {};
const run = (source: string, ops: HostOps = NO_OPS, limits: Partial<Limits> = {}, input = '') => sandbox.run({ source, input }, ops, { limits });
const result = (expression: string): string => `globalThis.__result = () => String(${expression});`;
const okResult = async (source: string, ops: HostOps = NO_OPS, limits: Partial<Limits> = {}): Promise<string> => {
  const outcome = await run(source, ops, limits);
  assert.ok(outcome.ok, outcome.ok ? '' : `${outcome.kind}: ${outcome.message}`);
  return outcome.ok ? outcome.result : '';
};
const failure = async (source: string, kind: string, pattern: RegExp, ops: HostOps = NO_OPS, limits: Partial<Limits> = {}): Promise<void> => {
  const outcome = await run(source, ops, limits);
  assert.equal(outcome.ok, false, 'the script was allowed to finish');
  if (!outcome.ok) { assert.equal(outcome.kind, kind, outcome.message); assert.match(outcome.message, pattern); }
};

test('A script runs, reads its input, and hands back a result', async () => {
  assert.equal(await okResult(result('1 + 2')), '3');
  const outcome = await sandbox.run({ source: 'globalThis.__result = () => __input.toUpperCase();', input: 'hello' }, NO_OPS);
  assert.deepEqual(outcome.ok ? outcome.result : undefined, 'HELLO');
  assert.equal(await okResult('const x = 1;'), '', 'a script that hands back nothing gives an empty text');
  assert.equal(await okResult(result('typeof Date.now() + typeof Math.random()')), 'numbernumber');
});

test('An error of the script is its own outcome, with its name and message, and the engine goes on', async () => {
  await failure("throw new TypeError('boom');", 'error', /^TypeError: boom$/);
  await failure('nope(', 'error', /^SyntaxError/);
  await failure('null.x', 'error', /^TypeError/);
  await failure("Promise.reject(new Error('later'));", 'error', /./).catch(() => undefined);
  assert.equal(await okResult(result('"still works"')), 'still works');
});

test('A script asks the extension for what it offers and gets a promise; two at once work; a name that is not offered is refused', async () => {
  const ops: HostOps = { echo: async text => `${text}!`, fail: async () => { throw new Error('refused by the extension'); }, slow: async () => { await new Promise(resolve => setTimeout(resolve, 50)); return 'slow'; } };
  assert.equal(await okResult(`let out = ''; __host('echo', 'hi').then(v => { out = v; }); globalThis.__result = () => out;`, ops), 'hi!');
  assert.equal(await okResult(`let out = []; Promise.all([__host('slow', ''), __host('echo', 'b')]).then(v => { out = v; }); globalThis.__result = () => out.join(',');`, ops), 'slow,b!');
  assert.equal(await okResult(`let out = ''; __host('fail', '').catch(e => { out = String(e); }); globalThis.__result = () => out;`, ops), 'refused by the extension');
  assert.equal(await okResult(`let out = ''; __host('nope', '').catch(e => { out = String(e); }); globalThis.__result = () => out;`, ops), 'there is no operation called nope');
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.match(await okResult(`let out = ''; __host(${JSON.stringify(name)}, '').catch(e => { out = String(e); }); globalThis.__result = () => out;`, ops), /there is no operation called/, name);
  }
  assert.equal(await okResult(`let out = ''; (async () => { out = await __host('echo', 'a') + await __host('echo', 'b'); })(); globalThis.__result = () => out;`, ops), 'a!b!', 'an async function can wait for them in turn');
});

test('The time spent waiting for the extension is not computing time, and a wait that never ends is stopped by the wall limit', async () => {
  const ops: HostOps = { wait: async () => { await new Promise(resolve => setTimeout(resolve, 1300)); return 'done'; }, hang: () => new Promise<string>(() => undefined) };
  assert.equal(await okResult(`let out = ''; __host('wait', '').then(v => { const began = Date.now(); while (Date.now() - began < 120) { /* computing for a moment after the wait */ } out = v; }); globalThis.__result = () => out;`, ops), 'done', 'waited 1300 ms with 300 ms of computing allowed (and 500 ms of grace)');
  await failure(`__host('hang', '');`, 'wall', /longer than 1 s/, ops, { wallMs: 1000 });
  assert.equal(await okResult(result('"alive"')), 'alive', 'a new engine takes over after a worker was ended');
});

test('A loop that never ends is stopped, whatever it is wrapped in, and the next script is not affected', async () => {
  const started = Date.now();
  await failure('while (true) {}', 'cpu', /used more than 300 ms/);
  await failure('try { while (true) {} } catch (e) {} finally { }', 'cpu', /used more than 300 ms/);
  await failure('for (;;) { try { for (;;) {} } catch (e) { continue; } }', 'cpu', /used more than 300 ms/);
  await failure('const f = () => f(); (async () => { for (;;) { await 0; } })();', 'cpu', /used more than 300 ms/);
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
  assert.equal(await okResult(result('"fresh"')), 'fresh');
});

test('A pattern that takes exponential time in the engine is stopped like any other computation', async () => {
  await failure("/(a+)+$/.test('a'.repeat(60) + 'b');", 'cpu', /used more than 300 ms/);
  await failure("'a'.repeat(100000).replace(/(a*)*b/, 'x');", 'cpu', /used more than 300 ms/);
});

test('Memory bombs end quickly with an error and leave the engine usable', async () => {
  await failure('globalThis.keep = new Uint8Array(40 * 1024 * 1024);', 'error', /out of memory|memory/, NO_OPS, { memoryBytes: 32 * MIB });
  assert.equal(await okResult('globalThis.keep = new Uint8Array(8 * 1024 * 1024); globalThis.__result = () => "small enough";'), 'small enough');
  const started = Date.now();
  const arrays = await run('const keep = []; for (;;) keep.push(new Uint8Array(1e6));');
  assert.equal(arrays.ok, false);
  const text = await run("let s = 'x'; for (;;) s += s;");
  assert.equal(text.ok, false);
  const beforeHuge = Date.now();
  const memoryBefore = process.memoryUsage().rss;
  const huge = await run("'x'.repeat(2 ** 30);");
  assert.equal(huge.ok, false);
  assert.ok(Date.now() - beforeHuge < 2500, `a gigabyte string took ${Date.now() - beforeHuge} ms to refuse`);
  const objects = await run('const keep = []; for (;;) keep.push({ a: [1, 2, 3], b: { c: keep.length } });');
  assert.equal(objects.ok, false);
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
  assert.ok(process.memoryUsage().rss - memoryBefore < 400 * MIB, `the process grew by ${Math.round((process.memoryUsage().rss - memoryBefore) / MIB)} MB: the memory of the engine has a hard maximum`);
  assert.equal(await okResult(result('"after the bombs"')), 'after the bombs');
});

test('Deep recursion is an error of the script, not a crash', async () => {
  await failure('const f = n => f(n + 1) + 1; f(0);', 'error', /stack overflow|too much recursion/);
  const down = 'const f = n => (n === 0 ? 0 : 1 + f(n - 1)); globalThis.__result = () => String(f(2000));';
  assert.equal(await okResult(down), '2000', 'a recursion of a normal depth is fine');
  await failure(down, 'error', /stack overflow|too much recursion/, NO_OPS, { stackBytes: 8 * 1024 });
  assert.equal(await okResult(result('1')), '1');
});

test('A result larger than the limit, and too many operations, are refused', async () => {
  await failure("globalThis.__result = () => 'x'.repeat(2e6);", 'error', /larger than 1048576 characters/);
  const ops: HostOps = { echo: async text => text };
  await failure("for (let i = 0; i < 1005; i++) __host('echo', 'x');", 'error', /at most 1000 operations/, ops);
  await failure("__host('echo', 'x'.repeat(1.1 * 1024 * 1024));", 'error', /argument of an operation is too large/, ops);
  assert.equal(await okResult("let n = 0; for (let i = 0; i < 20; i++) __host('echo', 'x').then(() => { n++; }); globalThis.__result = () => n;", ops, { hostCalls: 20 }), '20');
  await failure("for (let i = 0; i < 21; i++) __host('echo', 'x');", 'error', /at most 20 operations/, ops, { hostCalls: 20 });
});

test('The script cannot reach the machine: no process, no require, no network, no way back to the host', async () => {
  const reach = "typeof process + typeof require + typeof fetch + typeof Buffer + typeof WebAssembly + typeof XMLHttpRequest + typeof setTimeout + typeof module + typeof __filename";
  assert.equal(await okResult(result(reach)), 'undefined'.repeat(9));
  assert.equal(await okResult(result(`this.constructor.constructor("return ${reach}")()`)), 'undefined'.repeat(9), 'through the constructor of the constructor');
  assert.equal(await okResult(result(`Function("return ${reach}")()`)), 'undefined'.repeat(9));
  assert.equal(await okResult(result(`(function () { return this; })().constructor.constructor("return typeof process")()`)), 'undefined');
  assert.equal(await okResult(result(`[].constructor.constructor("return typeof require")()`)), 'undefined');
  const imported = await run("let out = ''; import('node:fs').then(() => { out = 'loaded'; }, e => { out = 'refused'; }); globalThis.__result = () => out;");
  assert.equal(imported.ok ? imported.result : imported.message, 'refused', 'a dynamic import finds nothing to load');
  assert.equal(await okResult(result('typeof SharedArrayBuffer + typeof Atomics + typeof WeakRef + typeof FinalizationRegistry + typeof escape + typeof unescape')), 'undefined'.repeat(6), 'what the API has no use for is taken away');
});

test('The names of the global object are the ones of the language and ours, and no others', async () => {
  const names = (await okResult(result('Object.getOwnPropertyNames(globalThis).sort().join(" ")'))).split(' ');
  const allowed = new Set([
    'Object', 'Function', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'InternalError', 'AggregateError', 'Array', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'Infinity', 'NaN', 'undefined', 'eval', 'Symbol', 'Number', 'Boolean', 'String', 'Math', 'Reflect', 'Date', 'RegExp', 'JSON', 'Proxy',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt', 'BigInt64Array', 'BigUint64Array', 'Float16Array', 'Promise', 'globalThis', 'Iterator', '__host', '__input', '__result'
  ]);
  assert.ok(['console', 'print', 'scriptArgs', 'setTimeout', 'std', 'os'].every(name => !names.includes(name)), 'the host functions the standalone interpreter has are not there');
  const strangers = names.filter(name => !allowed.has(name));
  assert.deepEqual(strangers, [], 'a global that is not on the list: decide whether the scripts may have it');
});

test('What a script changes stays in its engine: the next run starts from nothing', async () => {
  await okResult("Object.prototype.polluted = 'yes'; Array.prototype.polluted = 'yes'; globalThis.leftover = 1; String.prototype.trim = () => 'broken';");
  assert.equal(await okResult(result('typeof ({}).polluted + typeof [].polluted + typeof leftover + " x ".trim()')), 'undefinedundefinedundefinedx');
});

test('An error does not tell where the extension keeps its files', async () => {
  const outcome = await run("try { null.x } catch (e) { globalThis.__result = () => e.stack; }");
  const text = outcome.ok ? outcome.result : outcome.message;
  assert.ok(!/[A-Za-z]:\\|\/home\/|\/Users\/|node_modules|\.test-build/.test(text), text);
  assert.match(text, /script\.js/);
});

test('A run can be cancelled, the engine is replaced, and runs queue up one after the other', async () => {
  const controller = new AbortController();
  const slow = sandbox.run({ source: 'while (true) {}', input: '' }, NO_OPS, { signal: controller.signal, limits: { cpuMs: 10_000, wallMs: 20_000 } });
  setTimeout(() => controller.abort(), 150);
  const outcome = await slow;
  assert.deepEqual([outcome.ok, outcome.ok ? '' : outcome.kind], [false, 'cancelled']);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await sandbox.run({ source: '1', input: '' }, NO_OPS, { signal: aborted.signal })).ok, false, 'a run that is cancelled before it starts does not start');
  const results = await Promise.all([run(result('"a"')), run(result('"b"')), run(result('"c"'))]);
  assert.deepEqual(results.map(item => (item.ok ? item.result : item.message)), ['a', 'b', 'c']);
});

test('Scripts and data that are far too large are refused before anything runs, and a sandbox that is shut down says so', async () => {
  const outcome = await sandbox.run({ source: 'x'.repeat(8 * MIB + 1), input: '' }, NO_OPS);
  assert.deepEqual([outcome.ok, outcome.ok ? '' : outcome.kind], [false, 'limits']);
  const other = new ScriptSandbox({ workerPath: join(__dirname, '..', '..', 'src', 'script', 'worker.js'), wasmPath: join(repository, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm') });
  await other.dispose();
  const shut = await other.run({ source: '1', input: '' }, NO_OPS);
  assert.deepEqual([shut.ok, shut.ok ? '' : shut.kind], [false, 'crashed']);
  const missing = new ScriptSandbox({ workerPath: join(repository, 'no-such-worker.js'), wasmPath: join(repository, 'no-such.wasm') });
  const broken = await missing.run({ source: '1', input: '' }, NO_OPS);
  assert.deepEqual([broken.ok, broken.ok ? '' : broken.kind], [false, 'crashed']);
  await missing.dispose();
});

test('The bundle that ships (when it has been built) runs scripts and holds its limits like the worker of this build', async () => {
  const worker = join(repository, 'extension', 'dist', 'script-worker.js');
  const wasm = join(repository, 'extension', 'dist', 'quickjs.wasm');
  if (!existsSync(worker) || !existsSync(wasm)) return;
  const shipped = new ScriptSandbox({ workerPath: worker, wasmPath: wasm, limits: { cpuMs: 300, wallMs: 4000 } });
  try {
    const ok = await shipped.run({ source: 'globalThis.__result = () => String(6 * 7);', input: '' }, NO_OPS);
    assert.deepEqual(ok.ok ? ok.result : ok.message, '42');
    const loop = await shipped.run({ source: 'while (true) {}', input: '' }, NO_OPS);
    assert.deepEqual([loop.ok, loop.ok ? '' : loop.kind], [false, 'cpu']);
    const bomb = await shipped.run({ source: 'const keep = []; for (;;) keep.push(new Uint8Array(1e6));', input: '' }, NO_OPS);
    assert.equal(bomb.ok, false);
    const reach = await shipped.run({ source: 'globalThis.__result = () => typeof process + typeof require + typeof fetch + typeof XMLHttpRequest + typeof WebAssembly;', input: '' }, NO_OPS);
    assert.deepEqual(reach.ok ? reach.result : reach.message, 'undefined'.repeat(5));
    const again = await shipped.run({ source: 'globalThis.__result = () => "alive";', input: '' }, NO_OPS);
    assert.deepEqual(again.ok ? again.result : again.message, 'alive');
  } finally {
    await shipped.dispose();
  }
});
