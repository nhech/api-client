import { parseOutput, type ScriptInput, type ScriptOutput } from './outcome';
import { PRELUDE_SOURCE } from './prelude';
import { DEFAULT_LIMITS, type FailureKind, type HostOps, type Limits, type RunOutcome } from './protocol';

/**
 * Runs the scripts of one stage of one request: the API and the scripts go into the engine as one program, the data go in as text, and
 * what comes out is read as untrusted data (see outcome.ts). A run that was stopped or that broke is a result with the reason in words
 * for the person, not an exception.
 */
export interface ScriptRunner {
  run(job: { source: string; input: string }, ops: HostOps, options?: { signal?: AbortSignal; limits?: Partial<Limits> }): Promise<RunOutcome>;
}

export type ScriptRun =
  | { ok: true; output: ScriptOutput; cpuMs: number }
  | { ok: false; kind: FailureKind | 'output'; message: string };

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

export function describeFailure(kind: FailureKind | 'output', message: string, limits: Limits = DEFAULT_LIMITS): string {
  switch (kind) {
    case 'cpu': return `A script computed for more than ${seconds(limits.cpuMs)} and was stopped.`;
    case 'wall': return `The scripts took more than ${seconds(limits.wallMs)} and were stopped.`;
    case 'cancelled': return 'The scripts were cancelled.';
    case 'limits': return `The scripts could not run: ${message}.`;
    case 'crashed': return `The script engine stopped working: ${message}.`;
    case 'output': return `The answer of the scripts could not be read: ${message}.`;
    case 'error': return `A script failed: ${message}`;
  }
}

export async function runScripts(runner: ScriptRunner, input: ScriptInput, ops: HostOps, options: { signal?: AbortSignal; limits?: Partial<Limits> } = {}): Promise<ScriptRun> {
  const outcome = await runner.run({ source: PRELUDE_SOURCE, input: JSON.stringify(input) }, ops, options);
  if (!outcome.ok) return { ok: false, kind: outcome.kind, message: describeFailure(outcome.kind, outcome.message, { ...DEFAULT_LIMITS, ...options.limits }) };
  const parsed = parseOutput(outcome.result);
  return parsed.ok ? { ok: true, output: parsed.value, cpuMs: outcome.cpuMs } : { ok: false, kind: 'output', message: describeFailure('output', parsed.error) };
}
