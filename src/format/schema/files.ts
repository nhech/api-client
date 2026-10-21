import type { Container, Environment, Request, WorkspaceFile } from '../../core/model';
import { ID_PATTERN } from '../../core/clock';
import type { YMap, YValue } from '../yaml';
import {
  decodeAssertion, decodeAuth, decodeBody, decodeKV, decodeScripts, decodeSettings, decodeVar, encodeAssertion, encodeAuth, encodeBody, encodeKV, encodeScripts, encodeSettings, encodeVar
} from './common';
import { decodeDocument, SCHEMA_VERSION, type Decoded, type DecodeOptions } from './document';
import { Out, type Fields } from './read';

/** A request file (`<name>.req.yml`), a folder or collection file (`folder.yml`, `collection.yml`), an environment file and `workspace.yml`. */

const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;

function readId(fields: Fields): string {
  const id = fields.str('id');
  if (id === '') fields.reader.warn('id', 'no id: one is assigned when the file is saved');
  else if (!ID_PATTERN.test(id)) fields.reader.warn('id', 'not a 26-character id; kept as it is');
  return id;
}

function readName(fields: Fields, what: string): string {
  const name = fields.str('name');
  if (name.trim() === '') fields.reader.error('name', `${what} needs a name`);
  return name;
}

// ---- request ----

export function decodeRequest(root: YValue, options?: DecodeOptions): Decoded<Request> {
  return decodeDocument(root, fields => {
    const id = readId(fields);
    const name = readName(fields, 'a request');
    const method = fields.str('method', 'GET');
    if (!METHOD.test(method)) fields.reader.error('method', 'not a valid HTTP method');
    return {
      id, name, docs: fields.str('docs'), method, url: fields.str('url'), query: fields.list('query', decodeKV), pathParams: fields.list('pathParams', decodeKV),
      headers: fields.list('headers', decodeKV), auth: decodeAuth(fields, 'auth'), body: decodeBody(fields, 'body'), scripts: decodeScripts(fields, 'scripts'),
      tests: fields.list('tests', decodeAssertion), captures: fields.list('captures', decodeAssertion), settings: decodeSettings(fields, 'settings'), mirror: fields.bool('mirror', true)
    };
  }, options);
}

export function encodeRequest(request: Request, extra?: YMap): YMap {
  return new Out()
    .put('schema', String(SCHEMA_VERSION)).put('id', request.id).put('name', request.name).put('method', request.method).put('url', request.url).text('docs', request.docs)
    .list('query', request.query.map(encodeKV)).list('pathParams', request.pathParams.map(encodeKV)).list('headers', request.headers.map(encodeKV))
    .nested('auth', encodeAuth(request.auth)).nested('body', encodeBody(request.body)).nested('scripts', encodeScripts(request.scripts))
    .list('tests', request.tests.map(encodeAssertion)).list('captures', request.captures.map(encodeAssertion)).nested('settings', encodeSettings(request.settings))
    .bool('mirror', request.mirror, true).extras(extra).map;
}

// ---- folder and collection ----

export function decodeContainer(root: YValue, what: 'collection' | 'folder', options?: DecodeOptions): Decoded<Container> {
  return decodeDocument(root, fields => ({
    id: readId(fields), name: readName(fields, `a ${what}`), docs: fields.str('docs'), baseUrl: fields.str('baseUrl'), headers: fields.list('headers', decodeKV),
    auth: decodeAuth(fields, 'auth'), vars: fields.list('vars', decodeVar), scripts: decodeScripts(fields, 'scripts'), tests: fields.list('tests', decodeAssertion),
    settings: decodeSettings(fields, 'settings'), order: fields.strings('order')
  }), options);
}

export function encodeContainer(container: Container, extra?: YMap): YMap {
  return new Out()
    .put('schema', String(SCHEMA_VERSION)).put('id', container.id).put('name', container.name).text('docs', container.docs).text('baseUrl', container.baseUrl)
    .list('order', container.order).list('headers', container.headers.map(encodeKV)).nested('auth', encodeAuth(container.auth)).list('vars', container.vars.map(encodeVar))
    .nested('scripts', encodeScripts(container.scripts)).list('tests', container.tests.map(encodeAssertion)).nested('settings', encodeSettings(container.settings))
    .extras(extra).map;
}

// ---- environment ----

export function decodeEnvironment(root: YValue, options?: DecodeOptions): Decoded<Environment> {
  return decodeDocument(root, fields => ({ id: readId(fields), name: readName(fields, 'an environment'), vars: fields.list('vars', decodeVar) }), options);
}

export function encodeEnvironment(environment: Environment, extra?: YMap): YMap {
  return new Out().put('schema', String(SCHEMA_VERSION)).put('id', environment.id).put('name', environment.name).list('vars', environment.vars.map(encodeVar)).extras(extra).map;
}

// ---- workspace ----

export function decodeWorkspace(root: YValue, options?: DecodeOptions): Decoded<WorkspaceFile> {
  return decodeDocument(root, fields => ({ settings: decodeSettings(fields, 'settings'), vars: fields.list('vars', decodeVar), collections: fields.strings('collections') }), options);
}

export function encodeWorkspace(workspace: WorkspaceFile, extra?: YMap): YMap {
  return new Out().put('schema', String(SCHEMA_VERSION)).nested('settings', encodeSettings(workspace.settings)).list('vars', workspace.vars.map(encodeVar)).list('collections', workspace.collections).extras(extra).map;
}
