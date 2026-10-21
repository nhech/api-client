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
 * `local` for every environment, `global` for the whole session. When the same name is set in several, the nearest wins: the collection,
 * then the environment, then the session.
 *
 * EVERY scope belongs to the collection of the request that set it. A capture is text in a request file, and a request file can come with a
 * cloned repository: if `global: host = value evil.example` in one collection were seen by the requests of another, sending a request of the
 * first would turn every `{{host}}` of the second into the address of an attacker, with the credentials of the second still attached. So a
 * collection never sees what another set, whatever the scope says.
 */
export interface RuntimeContext {
  /** The active environment, or undefined when there is none. */
  environmentId: string | undefined;
  /** The folder of the collection of the request. */
  collection: string;
}

export type RuntimeScope = 'active' | 'local' | 'global';

/** What a script set and removed in one scope. Pairs, not an object: a name such as `__proto__` is a name like any other. */
export interface VariableChanges {
  set: readonly (readonly [string, string])[];
  unset: readonly string[];
}

export interface RuntimeScopes {
  active: Map<string, string>;
  local: Map<string, string>;
  global: Map<string, string>;
}

export const MAX_RUNTIME_VARIABLES = 1000;
export const MAX_RUNTIME_VALUE_CHARS = 256 * 1024;

export class RuntimeVariables {
  private readonly active = new Map<string, Map<string, string>>();
  private readonly local = new Map<string, Map<string, string>>();
  private readonly global = new Map<string, Map<string, string>>();

  /** The environment and the collection together: the same environment in two collections is two places. */
  private activeKey(context: RuntimeContext): string {
    return JSON.stringify([context.environmentId ?? '', context.collection]);
  }

  private bucket(store: Map<string, Map<string, string>>, key: string): Map<string, string> {
    let bucket = store.get(key);
    if (bucket === undefined) { bucket = new Map(); store.set(key, bucket); }
    return bucket;
  }

  get size(): number {
    let count = 0;
    for (const store of [this.active, this.local, this.global]) for (const bucket of store.values()) count += bucket.size;
    return count;
  }

  /** How many variables the collection of a context holds, in every scope: the limit is for a collection, so that one cannot use up the room of another. */
  private sizeOf(context: RuntimeContext): number {
    let count = (this.global.get(context.collection)?.size ?? 0) + (this.local.get(context.collection)?.size ?? 0);
    for (const [key, bucket] of this.active) if ((JSON.parse(key) as [string, string])[1] === context.collection) count += bucket.size;
    return count;
  }

  private target(scope: RuntimeScope, context: RuntimeContext): Map<string, string> {
    return scope === 'global' ? this.bucket(this.global, context.collection) : scope === 'local' ? this.bucket(this.local, context.collection) : this.bucket(this.active, this.activeKey(context));
  }

  private put(scope: RuntimeScope, name: string, value: string | undefined, context: RuntimeContext): void {
    const target = this.target(scope, context);
    if (value === undefined) { target.delete(name); return; }
    if (!target.has(name) && this.sizeOf(context) >= MAX_RUNTIME_VARIABLES) return;
    target.set(name, value.length > MAX_RUNTIME_VALUE_CHARS ? value.slice(0, MAX_RUNTIME_VALUE_CHARS) : value);
  }

  /** Sets or removes the variable a capture says; a result that failed changes nothing. */
  apply(result: CaptureResult, context: RuntimeContext): void {
    if (!result.ok || result.variable === '') return;
    this.put(result.scope, result.variable, result.action === 'delete' ? undefined : result.value, context);
  }

  /** Sets and removes what a script asked for in one scope; the removals come first, so a name that is in both ends up set. */
  change(scope: RuntimeScope, changes: VariableChanges, context: RuntimeContext): void {
    for (const name of changes.unset) this.put(scope, name, undefined, context);
    for (const [name, value] of changes.set) this.put(scope, name, value, context);
  }

  /** The values of a context, by scope, as plain maps that can be changed without touching these. */
  snapshot(context: RuntimeContext): RuntimeScopes {
    return {
      active: new Map(this.active.get(this.activeKey(context))),
      local: new Map(this.local.get(context.collection)),
      global: new Map(this.global.get(context.collection))
    };
  }

  /** What a request in this context sees: the strongest scope of the resolver. */
  scope(context: RuntimeContext): Map<string, VarValue> {
    const merged = new Map<string, VarValue>();
    const put = (values: Iterable<[string, string]> | undefined): void => {
      if (values === undefined) return;
      for (const [name, value] of values) merged.set(name, { value, secret: isSecretName(name) });
    };
    put(this.global.get(context.collection));
    put(this.active.get(this.activeKey(context)));
    put(this.local.get(context.collection));
    return merged;
  }

  clear(): void {
    this.active.clear();
    this.local.clear();
    this.global.clear();
  }
}
