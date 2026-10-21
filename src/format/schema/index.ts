import type { Container, Environment, Request, WorkspaceFile } from '../../core/model';
import { emitYaml, parseYaml, type YamlError, type YMap, type YValue } from '../yaml';
import type { Decoded, DecodeOptions } from './document';
import { decodeContainer, decodeEnvironment, decodeRequest, decodeWorkspace, encodeContainer, encodeEnvironment, encodeRequest, encodeWorkspace } from './files';
import type { Finding } from './read';

export { SCHEMA_VERSION, decodeDocument } from './document';
export type { Decoded, DecodeOptions, Migrations } from './document';
export { decodeContainer, decodeEnvironment, decodeRequest, decodeWorkspace, encodeContainer, encodeEnvironment, encodeRequest, encodeWorkspace } from './files';
export type { Finding } from './read';

/** A file read from its text: the text may not be YAML of the subset at all, which is a failure with the position. */
export type ReadResult<T> = Decoded<T> | { ok: false; newer: false; findings: Finding[]; syntax: YamlError };

function fromText<T>(text: string, decode: (root: YValue) => Decoded<T>): ReadResult<T> {
  const parsed = parseYaml(text);
  if (!parsed.ok) {
    const { line, column, message } = parsed.error;
    return { ok: false, newer: false, findings: [{ path: '', message: `line ${line}, column ${column}: ${message}`, severity: 'error' }], syntax: parsed.error };
  }
  return decode(parsed.value);
}

export const readRequest = (text: string, options?: DecodeOptions): ReadResult<Request> => fromText(text, root => decodeRequest(root, options));
export const readContainer = (text: string, what: 'collection' | 'folder', options?: DecodeOptions): ReadResult<Container> => fromText(text, root => decodeContainer(root, what, options));
export const readEnvironment = (text: string, options?: DecodeOptions): ReadResult<Environment> => fromText(text, root => decodeEnvironment(root, options));
export const readWorkspace = (text: string, options?: DecodeOptions): ReadResult<WorkspaceFile> => fromText(text, root => decodeWorkspace(root, options));

export const writeRequest = (request: Request, extra?: YMap): string => emitYaml(encodeRequest(request, extra));
export const writeContainer = (container: Container, extra?: YMap): string => emitYaml(encodeContainer(container, extra));
export const writeEnvironment = (environment: Environment, extra?: YMap): string => emitYaml(encodeEnvironment(environment, extra));
export const writeWorkspace = (workspace: WorkspaceFile, extra?: YMap): string => emitYaml(encodeWorkspace(workspace, extra));
