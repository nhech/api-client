import type { Clock } from '../core/clock';
import { effectiveRequest, type EffectiveRequest, type Level } from '../core/inherit';
import type { Request } from '../core/model';
import { describeVariables, variableScopes, type VarValue, type VariableInfo } from '../core/vars';
import type { ContainerNode, EnvironmentNode, Loaded, RequestNode } from '../storage/store';
import { buildWire, type Built } from './build';
import { sendOptionsFrom, type SendOptions } from './send';

/** Where a request is in the tree that was loaded: the collection and the folders above it, outermost first. */
export interface Located {
  node: RequestNode;
  collection: ContainerNode;
  chain: ContainerNode[];
}

export function locate(loaded: Loaded, path: string): Located | undefined {
  const search = (container: ContainerNode, chain: ContainerNode[]): Located | undefined => {
    const here = [...chain, container];
    for (const child of container.children) {
      if (child.kind === 'request') {
        if (child.path === path) return { node: child, collection: here[0] as ContainerNode, chain: here };
      } else {
        const found = search(child, here);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  for (const collection of loaded.collections) {
    const found = search(collection, []);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface PrepareInput {
  loaded: Loaded;
  /** The file of the request, relative to the workspace folder. */
  path: string;
  /** The request as the person has it now, which may not be saved yet. */
  request: Request;
  environmentId: string | undefined;
  /** Values set while the requests run (captures, scripts): the strongest. */
  runtime?: ReadonlyMap<string, VarValue>;
  clock: Clock;
  /** An absolute path for a file named in the request, or undefined when it is not allowed; `collectionPath` is the folder of the collection. */
  resolveFile: (collectionPath: string, relative: string) => string | undefined;
  oauthToken?: { accessToken: string; tokenType: string };
}

export interface Prepared {
  built: Built;
  effective: EffectiveRequest;
  collection: ContainerNode;
  environment: EnvironmentNode | undefined;
  options: Pick<SendOptions, 'timeoutMs' | 'followRedirects' | 'maxRedirects' | 'responseLimitBytes' | 'tls'>;
  /** Why it cannot be sent, in the words for the person; empty when it can. */
  problems: string[];
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Everything that has to be known before a request is sent: the folders and the collection above it, the variables of the active
 * environment, the settings that apply, and the request as it will go over the wire. Nothing is sent and nothing is read from the
 * disk except through `resolveFile`.
 */
export function prepareSend(input: PrepareInput): Prepared | undefined {
  const located = locate(input.loaded, input.path);
  if (located === undefined) return undefined;
  const levels: Level[] = located.chain.map(container => ({ kind: container === located.collection ? 'collection' : 'folder', name: container.container.name, container: container.container }));
  const environment = input.environmentId === undefined ? undefined : input.loaded.environments.find(item => item.environment.id === input.environmentId);
  const effective = effectiveRequest(input.request, levels, input.loaded.workspace.file.settings);
  const scopes = variableScopes({
    levels, workspace: input.loaded.workspace.file,
    ...(environment === undefined ? {} : { environment: environment.environment }), ...(input.runtime === undefined ? {} : { runtime: input.runtime })
  });
  const built = buildWire({
    request: input.request, effective, scopes, clock: input.clock, resolveFile: relative => input.resolveFile(located.collection.path, relative),
    ...(input.oauthToken === undefined ? {} : { oauthToken: input.oauthToken })
  });
  const problems = [...built.problems];
  if (built.cycles.length > 0) problems.push(`These variables refer to themselves: ${built.cycles.join(', ')}.`);
  const url = built.wire.url.trim();
  if (url === '') problems.push('The request has no address.');
  else if (HAS_SCHEME.test(url)) built.wire.url = url;
  else if (url.includes('{{')) problems.push(built.unresolved.length > 0 ? `The address uses variables that have no value: ${built.unresolved.join(', ')}.` : 'The address is not complete.');
  else if (url.startsWith('/') || url.startsWith('?')) problems.push('The address has no host. Write the whole address, or give the collection a base URL.');
  else {
    built.wire.url = `http://${url}`;
    built.warnings.push('The address had no scheme, so http:// was used.');
  }
  return { built, effective, collection: located.collection, environment, options: sendOptionsFrom(effective.settings), problems };
}

/** The variables a request can use, for the editor to mark `{{names}}` as known or not; `complete` is false when the request is not in a loaded collection, so that nothing is marked unknown. */
export function variablesOf(loaded: Loaded, path: string, environmentId: string | undefined): { vars: VariableInfo[]; complete: boolean } {
  const located = locate(loaded, path);
  if (located === undefined) return { vars: [], complete: false };
  const levels: Level[] = located.chain.map(container => ({ kind: container === located.collection ? 'collection' : 'folder', name: container.container.name, container: container.container }));
  const environment = environmentId === undefined ? undefined : loaded.environments.find(item => item.environment.id === environmentId);
  return { vars: describeVariables({ levels, workspace: loaded.workspace.file, ...(environment === undefined ? {} : { environment: environment.environment }) }), complete: true };
}
