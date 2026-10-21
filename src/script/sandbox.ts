import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { CPU_GRACE_MS, DEFAULT_LIMITS, MAX_OPERATION_CHARS, MIB, type FailureKind, type FromWorker, type HostOps, type Limits, type RunOutcome, type ToWorker } from './protocol';

/**
 * Runs the scripts of a request in a worker, one run at a time. Between runs the worker is kept (starting one takes about 50 ms); it is
 * ended and a new one started when a run ended badly: over a limit, cancelled, or after anything on the side of the engine that was
 * not the script's own doing. A run that goes over its CPU limit is first stopped by the engine itself; one that does not stop (the
 * engine polls only every few thousand instructions, so a call that takes long inside it overshoots) is ended from here.
 */
export interface SandboxOptions {
  /** The bundled worker (dist/script-worker.js). */
  workerPath: string;
  /** The module of the engine (dist/quickjs.wasm). */
  wasmPath: string;
  limits?: Partial<Limits>;
}

export interface Job {
  /** The program: the code of the API and the scripts. */
  source: string;
  /** Data for the program, as text; it is read as `__input`. */
  input: string;
}

const START_TIMEOUT_MS = 10_000;
const WATCH_INTERVAL_MS = 20;

export class ScriptSandbox {
  private worker: Worker | undefined;
  private ready: Promise<Worker> | undefined;
  private compiled: Promise<WebAssembly.Module> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: SandboxOptions) {}

  private module(): Promise<WebAssembly.Module> {
    this.compiled ??= WebAssembly.compile(readFileSync(this.options.wasmPath));
    return this.compiled;
  }

  /** A worker with the engine started, or why there is none. */
  private start(): Promise<Worker> {
    this.ready ??= (async () => {
      const module = await this.module();
      // Nothing of the environment goes to the worker, and it gets a heap of its own that it cannot grow past.
      const worker = new Worker(this.options.workerPath, { env: {}, execArgv: [], stdout: false, stderr: false, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16, stackSizeMb: 4 } });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('the script engine did not start')); }, START_TIMEOUT_MS);
        const done = (action: () => void): void => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); action(); };
        const onMessage = (message: FromWorker): void => { if (message.type === 'ready') done(resolve); else if (message.type === 'fatal') done(() => { reject(new Error(message.message)); }); };
        const onError = (error: Error): void => { done(() => { reject(error); }); };
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.postMessage({ type: 'init', wasmModule: module } satisfies ToWorker);
      }).catch(async error => { await worker.terminate(); throw error; });
      this.worker = worker;
      return worker;
    })().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }

  private async discard(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    if (worker !== undefined) await worker.terminate();
  }

  /** Runs a job. A failure is a result, not an exception: the outcome says what went wrong. */
  run(job: Job, ops: HostOps, options: { signal?: AbortSignal; limits?: Partial<Limits> } = {}): Promise<RunOutcome> {
    const next = this.queue.then(() => this.runNow(job, ops, options));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runNow(job: Job, ops: HostOps, options: { signal?: AbortSignal; limits?: Partial<Limits> }): Promise<RunOutcome> {
    const limits: Limits = { ...DEFAULT_LIMITS, ...this.options.limits, ...options.limits };
    if (this.disposed) return { ok: false, kind: 'crashed', message: 'the script engine is shut down' };
    if (job.source.length > 8 * MIB || job.input.length > 8 * MIB) return { ok: false, kind: 'limits', message: 'the scripts or their data are too large' };
    if (options.signal?.aborted === true) return { ok: false, kind: 'cancelled', message: 'cancelled' };
    let worker: Worker;
    try { worker = await this.start(); } catch (error) { return { ok: false, kind: 'crashed', message: error instanceof Error ? error.message : 'the script engine could not start' }; }
    const id = this.nextId++;
    const began = Date.now();
    let waitedTotal = 0;
    let waitingSince: number | undefined;

    return new Promise<RunOutcome>(resolve => {
      let finished = false;
      const finish = (outcome: RunOutcome, recycle: boolean): void => {
        if (finished) return;
        finished = true;
        clearInterval(watch);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        options.signal?.removeEventListener('abort', onAbort);
        if (recycle) void this.discard();
        resolve(outcome);
      };
      const fail = (kind: FailureKind, message: string): void => finish({ ok: false, kind, message }, true);
      const busy = (): number => Date.now() - began - waitedTotal - (waitingSince === undefined ? 0 : Date.now() - waitingSince);

      const onMessage = (message: FromWorker): void => {
        if (message.type === 'op') {
          if (message.id !== id) return;
          const operation = Object.hasOwn(ops, message.op) ? ops[message.op] : undefined;
          waitingSince = Date.now();
          const reply = (ok: boolean, value: string): void => {
            if (waitingSince !== undefined) { waitedTotal += Date.now() - waitingSince; waitingSince = undefined; }
            if (!finished) worker.postMessage({ type: 'opResult', opId: message.opId, ok, value: value.length > MAX_OPERATION_CHARS ? value.slice(0, MAX_OPERATION_CHARS) : value } satisfies ToWorker);
          };
          if (operation === undefined) { reply(false, `there is no operation called ${message.op.slice(0, 40)}`); return; }
          // An operation is the extension's own code, run for a script: it is given text and gives back text, and its failure is the script's to see.
          operation(message.arg).then(value => { reply(true, typeof value === 'string' ? value : ''); }, (error: unknown) => { reply(false, error instanceof Error ? error.message.slice(0, 1000) : 'the operation failed'); });
        } else if (message.type === 'done') {
          if (message.id !== id) return;
          if (message.ok) finish({ ok: true, result: message.result, cpuMs: busy() }, false);
          else if (message.error.message === 'interrupted') finish({ ok: false, kind: 'cpu', message: `the scripts used more than ${Math.round(limits.cpuMs)} ms of computing time` }, message.recycle);
          else finish({ ok: false, kind: 'error', message: `${message.error.name}: ${message.error.message}` }, message.recycle);
        } else if (message.type === 'fatal') fail('crashed', message.message);
      };
      const onError = (error: Error): void => { fail('crashed', `the script engine failed: ${error.message.slice(0, 300)}`); };
      const onExit = (): void => { fail('crashed', 'the script engine stopped'); };
      const onAbort = (): void => { fail('cancelled', 'cancelled'); };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      options.signal?.addEventListener('abort', onAbort);
      const watch = setInterval(() => {
        if (finished) return;
        const total = Date.now() - began;
        if (total > limits.wallMs) fail('wall', `the scripts took longer than ${Math.round(limits.wallMs / 1000)} s`);
        else if (busy() > limits.cpuMs + CPU_GRACE_MS) fail('cpu', `the scripts used more than ${Math.round(limits.cpuMs)} ms of computing time`);
      }, WATCH_INTERVAL_MS);
      worker.postMessage({ type: 'run', id, source: job.source, input: job.input, limits } satisfies ToWorker);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.discard();
  }
}
