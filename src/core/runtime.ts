import type { CaptureResult } from './assert';
import { isSecretName } from './redact';
import type { VarValue } from './vars';

/**
 * The variables that requests set while they run (the captures of a response). They are the strongest scope, so a captured token beats
 * the one in an environment, and they live only as long as the session: nothing here is written to a file of the collection, so a
 * token that was captured is not committed with the requests. A name that looks like a secret (token, password, key...) is marked as
 * one, so it is hidden wherever values are shown or written down.
 *
 * Where a value is visible follows its scope: `active` for the active environment (switching the environment switches the values),
 * `local` for the collection of the request that set it, `global` everywhere. When the same name is set in several, the nearest wins:
 * the collection, then the environment, then everywhere.
 */
export interface RuntimeContext {
  /** The active environment, or undefined when there is none. */
  environmentId: string | undefined;
  /** The folder of the collection of the request. */
  collection: string;
}

export const MAX_RUNTIME_VARIABLES = 1000;
export const MAX_RUNTIME_VALUE_CHARS = 256 * 1024;

export class RuntimeVariables {
  private readonly active = new Map<string, Map<string, string>>();
  private readonly local = new Map<string, Map<string, string>>();
  private readonly global = new Map<string, string>();

  private bucket(store: Map<string, Map<string, string>>, key: string): Map<string, string> {
    let bucket = store.get(key);
    if (bucket === undefined) { bucket = new Map(); store.set(key, bucket); }
    return bucket;
  }

  get size(): number {
    let count = this.global.size;
    for (const bucket of this.active.values()) count += bucket.size;
    for (const bucket of this.local.values()) count += bucket.size;
    return count;
  }

  /** Sets or removes the variable a capture says; a result that failed changes nothing. */
  apply(result: CaptureResult, context: RuntimeContext): void {
    if (!result.ok || result.variable === '') return;
    const target = result.scope === 'global' ? this.global : result.scope === 'local' ? this.bucket(this.local, context.collection) : this.bucket(this.active, context.environmentId ?? '');
    if (result.action === 'delete') { target.delete(result.variable); return; }
    if (!target.has(result.variable) && this.size >= MAX_RUNTIME_VARIABLES) return;
    target.set(result.variable, result.value.length > MAX_RUNTIME_VALUE_CHARS ? result.value.slice(0, MAX_RUNTIME_VALUE_CHARS) : result.value);
  }

  /** What a request in this context sees: the strongest scope of the resolver. */
  scope(context: RuntimeContext): Map<string, VarValue> {
    const merged = new Map<string, VarValue>();
    const put = (values: Iterable<[string, string]> | undefined): void => {
      if (values === undefined) return;
      for (const [name, value] of values) merged.set(name, { value, secret: isSecretName(name) });
    };
    put(this.global);
    put(this.active.get(context.environmentId ?? ''));
    put(this.local.get(context.collection));
    return merged;
  }

  clear(): void {
    this.active.clear();
    this.local.clear();
    this.global.clear();
  }
}
