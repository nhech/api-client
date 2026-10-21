/**
 * What the scripts of a request run in: QuickJS compiled to WebAssembly, in a worker thread, with limits on time, memory and output. The
 * thread is not a security boundary by itself; what keeps a script in is that the engine has no access to the machine (no process, no
 * files, no network, no `require`), that everything it can ask of the extension is a short list of operations that the extension
 * checks, and that what comes back is read as untrusted data. These are the messages between the two sides.
 */
export const MIB = 1024 * 1024;

export interface Limits {
  /** The time scripts may spend computing in one run; waiting for an operation of the extension does not count. */
  cpuMs: number;
  /** The whole run, waiting included. */
  wallMs: number;
  /** The soft limit of the heap of the engine; the memory it can grow into has a hard maximum of its own (HARD_MEMORY_PAGES). */
  memoryBytes: number;
  stackBytes: number;
  /** The most a script may hand back at the end. */
  resultBytes: number;
  /** The most operations of the extension one run may ask for. */
  hostCalls: number;
}

export const DEFAULT_LIMITS: Limits = { cpuMs: 1000, wallMs: 10_000, memoryBytes: 32 * MIB, stackBytes: 512 * 1024, resultBytes: MIB, hostCalls: 1000 };

/** After the CPU limit a script that does not stop at the next poll of the engine is ended from outside. */
export const CPU_GRACE_MS = 500;

/** The WebAssembly memory of the engine: 16 MB to start, 64 MB at the most (a page is 64 KiB). The soft limit of the engine alone is not a cap. */
export const INITIAL_MEMORY_PAGES = 256;
export const HARD_MEMORY_PAGES = 1024;

/** The longest an argument or an answer of an operation may be. */
export const MAX_OPERATION_CHARS = MIB;

export type ToWorker =
  | { type: 'init'; wasmModule: WebAssembly.Module }
  | { type: 'run'; id: number; source: string; input: string; limits: Limits }
  | { type: 'opResult'; opId: number; ok: boolean; value: string };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'op'; id: number; opId: number; op: string; arg: string }
  /** `recycle`: something went wrong on the side of the engine that is not the fault of the script, so this worker is not used again. */
  | { type: 'done'; id: number; ok: true; result: string }
  | { type: 'done'; id: number; ok: false; error: { name: string; message: string }; recycle: boolean }
  | { type: 'fatal'; message: string };

/** The operations the extension offers a script; the name is looked up among the keys it gave, never anywhere else. */
export type HostOps = Readonly<Record<string, (argument: string) => Promise<string>>>;

export type FailureKind = 'error' | 'cpu' | 'wall' | 'cancelled' | 'crashed' | 'limits';

export type RunOutcome =
  | { ok: true; result: string; cpuMs: number }
  | { ok: false; kind: FailureKind; message: string };
