import { parentPort } from 'node:worker_threads';
import { isFail, newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule, type VmCallResult } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { HARD_MEMORY_PAGES, INITIAL_MEMORY_PAGES, MAX_OPERATION_CHARS, type FromWorker, type Limits, type ToWorker } from './protocol';

/**
 * The inside of the worker: it creates the engine once from the module the extension compiled, and for every run a new runtime and a new
 * context, so that nothing a script did is there for the next one. A script can ask the extension for the operations it offers through one
 * function, `__host(name, text)`, which gives back a promise of a text. Nothing else of the machine is reachable from the engine.
 */
const port = parentPort;
if (port === null) throw new Error('This file is a worker.');

let engine: QuickJSWASMModule | undefined;
let nextOperation = 1;
const waiting = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();

const send = (message: FromWorker): void => port.postMessage(message);

/** What is taken away from the engine before any script runs: what the API has no use for and could be turned against the extension. */
const LOCKDOWN = `
for (const name of ['SharedArrayBuffer', 'Atomics', 'WeakRef', 'FinalizationRegistry', 'escape', 'unescape']) { try { delete globalThis[name]; } catch (e) { /* not there */ } }
`;

/** An error that the script itself raised (or the engine raised for it: a limit, a syntax error); the worker is fine. */
class GuestError extends Error {
  constructor(readonly guestName: string, message: string) {
    super(message);
  }
}

function describeError(context: QuickJSContext, handle: QuickJSHandle): { name: string; message: string } {
  try {
    const dumped = context.dump(handle) as unknown;
    if (typeof dumped === 'object' && dumped !== null) {
      const record = dumped as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'] : 'Error';
      const message = typeof record['message'] === 'string' ? record['message'] : '';
      return { name: name.slice(0, 100), message: message.slice(0, 2000) };
    }
    return { name: 'Error', message: String(dumped).slice(0, 2000) };
  } catch {
    return { name: 'Error', message: 'the error could not be read' };
  }
}

/** The value of a result of the engine, or the error it holds, thrown as a GuestError. */
function unwrap(context: QuickJSContext, result: VmCallResult<QuickJSHandle>): QuickJSHandle {
  if (isFail(result)) {
    const error = describeError(context, result.error);
    result.error.dispose();
    throw new GuestError(error.name, error.message);
  }
  return result.value;
}

function callHost(runId: number, op: string, arg: string): Promise<string> {
  const opId = nextOperation++;
  return new Promise<string>((resolve, reject) => {
    waiting.set(opId, { resolve, reject });
    send({ type: 'op', id: runId, opId, op, arg });
  });
}

async function run(id: number, source: string, input: string, limits: Limits): Promise<void> {
  if (engine === undefined) { send({ type: 'done', id, ok: false, error: { name: 'Error', message: 'the engine is not ready' }, recycle: true }); return; }
  const started = Date.now();
  let waited = 0;
  let calls = 0;
  /** The engine was stopped for using too much time at least once (what an async function does with that is to end quietly, so it is noted here). */
  let interrupted = false;
  /** After this the engine is gone and nothing of it may be touched: operations that finish late find nobody waiting. */
  let closed = false;
  const runtime = engine.newRuntime();
  let context: QuickJSContext | undefined;
  const pending = new Set<Promise<void>>();
  try {
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    // The CPU budget is spent only while the engine computes: the time spent waiting for the extension is given back.
    runtime.setInterruptHandler(() => { if (Date.now() - started - waited > limits.cpuMs) { interrupted = true; return true; } return false; });
    const vm = runtime.newContext();
    context = vm;
    const host = vm.newFunction('__host', (opHandle, argHandle) => {
      const op = vm.getString(opHandle);
      const arg = vm.getString(argHandle);
      if (++calls > limits.hostCalls) throw new Error(`a script may ask for at most ${limits.hostCalls} operations`);
      if (arg.length > MAX_OPERATION_CHARS) throw new Error('the argument of an operation is too large');
      const deferred = vm.newPromise();
      const began = Date.now();
      const settled: Promise<void> = callHost(id, op, arg).then(
        value => { waited += Date.now() - began; if (!closed && deferred.alive) deferred.resolve(vm.newString(value)); },
        (error: unknown) => { waited += Date.now() - began; if (!closed && deferred.alive) deferred.reject(vm.newString(error instanceof Error ? error.message : 'the operation failed')); }
      ).finally(() => { pending.delete(settled); });
      pending.add(settled);
      return deferred.handle;
    });
    vm.setProp(vm.global, '__host', host);
    host.dispose();
    const inputHandle = vm.newString(input);
    vm.setProp(vm.global, '__input', inputHandle);
    inputHandle.dispose();
    unwrap(vm, vm.evalCode(LOCKDOWN, 'lockdown.js')).dispose();
    unwrap(vm, vm.evalCode(source, 'script.js')).dispose();
    // Jobs (the continuations of promises) run in the engine; when none is ready, wait for an operation of the extension to finish.
    for (;;) {
      const jobs = runtime.executePendingJobs();
      if (isFail(jobs)) {
        const error = describeError(vm, jobs.error);
        jobs.error.dispose();
        throw new GuestError(error.name, error.message);
      }
      if (!runtime.hasPendingJob() && pending.size === 0) break;
      if (!runtime.hasPendingJob()) await Promise.race(pending);
    }
    if (interrupted) throw new GuestError('InternalError', 'interrupted');
    const resultHandle = unwrap(vm, vm.evalCode('typeof __result === "function" ? String(__result()) : ""', 'result.js'));
    const result = vm.getString(resultHandle);
    resultHandle.dispose();
    if (result.length > limits.resultBytes) throw new GuestError('Error', `the result of the scripts is larger than ${limits.resultBytes} characters`);
    send({ type: 'done', id, ok: true, result });
  } catch (error) {
    // A guest error carries its own name and message; a failure on this side is not the script's, and the worker is not used again.
    const guest = error instanceof GuestError;
    const message = error instanceof Error ? error.message.slice(0, 2000) : 'the script failed';
    const name = error instanceof GuestError ? error.guestName : error instanceof Error ? error.name.slice(0, 100) : 'Error';
    send({ type: 'done', id, ok: false, error: { name, message }, recycle: !guest || /out of memory/i.test(message) });
  } finally {
    closed = true;
    for (const [, operation] of waiting) operation.reject(new Error('the run ended'));
    waiting.clear();
    try { context?.dispose(); } catch { /* the runtime is disposed next */ }
    try { runtime.dispose(); } catch { /* the worker is recycled by the extension when this happens */ }
  }
}

port.on('message', (message: ToWorker) => {
  if (message.type === 'init') {
    const wasmMemory = new WebAssembly.Memory({ initial: INITIAL_MEMORY_PAGES, maximum: HARD_MEMORY_PAGES });
    newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule: message.wasmModule, wasmMemory })).then(
      created => { engine = created; send({ type: 'ready' }); },
      (error: unknown) => { send({ type: 'fatal', message: error instanceof Error ? error.message : 'the engine could not start' }); }
    );
  } else if (message.type === 'run') {
    run(message.id, message.source, message.input, message.limits).catch((error: unknown) => {
      send({ type: 'done', id: message.id, ok: false, error: { name: 'Error', message: error instanceof Error ? error.message.slice(0, 500) : 'the run failed' }, recycle: true });
    });
  } else {
    const operation = waiting.get(message.opId);
    if (operation === undefined) return;
    waiting.delete(message.opId);
    if (message.ok) operation.resolve(message.value);
    else operation.reject(new Error(message.value));
  }
});
