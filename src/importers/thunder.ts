import { convertAuth } from '../convert/auth';
import { convertBody, leavesFolder, token } from '../convert/body';
import { convertEnvironments } from '../convert/environments';
import { readHeaders } from '../convert/headers';
import { SECRET_VARIABLE } from '../convert/secrets';
import { splitVariables, oneLine } from '../convert/text';
import { convertTests, type TestConversion } from '../convert/tests';
import { thunderRange } from '../convert/sysvars';
import type { Finding } from '../model/findings';
import type { ImpAssertion, ImpBody, ImpCapture } from '../model/ir';
import type { TcAuth, TcSettings } from '../model/source';
import { Coercions } from '../normalize/coerce';
import { isRecord } from '../normalize/guards';
import { FindingSink } from '../normalize/sink';
import { readText } from '../normalize/text';
import type { SourceTree, TreeCollection, TreeContainer, TreeRequest } from '../normalize/tree';
import type { Assertion, Auth, Body, Capture, Container, KV, Part, Request, Var } from '../core/model';
import { printable } from '../util/chars';
import { protectCollection } from './credentials';
import { blankFolder, blankRequest, IMPORT_LIMITS, Notes, type Imported, type ImportedFolder, type ImportNote } from './types';
import { row, splitUrl } from './url';

/**
 * What the Thunder Client reader found (collections, folders, requests, environments, already placed and in order) becomes the model of the client.
 * The folders stay folders, and what a folder or a collection sets (its base address, its headers, its authentication, its tests, its scripts)
 * stays on it, to be inherited here the way Thunder inherited it; that is the difference from the conversion to `.http` files, which has to copy
 * it into every request. Thunder's `{{#guid}}` and `{{#number}}` become the dynamic variables of the client. A credential that is typed in is moved
 * to a secret variable of the collection (see credentials.ts). Whatever cannot be carried over is a note.
 */

const unsupportedType = (type: string): string => token(type);

/** Thunder's own default headers, which the person did not write. */
const isThunderDefault = (name: string, value: string): boolean => (name.toLowerCase() === 'accept' && value === '*/*') || (name.toLowerCase() === 'user-agent' && /thunderclient/i.test(value));

/** The findings of the stages before this one as notes, for the report. */
export const findingNotes = (findings: readonly Finding[]): ImportNote[] => findings.map(item => ({ where: item.where, message: item.message }));

interface Context {
  coerce: Coercions;
  sink: FindingSink;
  notes: Notes;
  unmapped: Set<string>;
  /** The scripts that were imported, to say once that they use Thunder's API. */
  scripts: number;
  requests: number;
  /** Requests that cannot be sent from here (WebSocket, SSE, gRPC). */
  skipped: number;
}

/** Thunder's `{{#guid}}`, `{{#number, a, b}}` and `{{#dateISO}}` as the words of the client; the others stay as they are and are listed by name. */
function mapVariables(text: string, context: Context): string {
  if (!text.includes('{{')) return text;
  return splitVariables(text).map(piece => {
    if (!piece.variable) return piece.text;
    const found = /^#([A-Za-z]+)(?:\s*,\s*([\s\S]*))?$/.exec(piece.text.slice(2, -2).trim());
    if (found === null) return piece.text;
    const word = found[1] ?? '';
    const args = found[2];
    if (word === 'guid' && args === undefined) return '{{$guid}}';
    if (word === 'dateISO' && args === undefined) return '{{$isoTimestamp}}';
    if (word === 'number') {
      const range = thunderRange(args === undefined ? [] : args.split(','));
      if (range !== undefined && Math.abs(range.min) < 1e9 && Math.abs(range.max) < 1e9) return `{{$randomInt ${range.min} ${range.max}}}`;
    }
    context.unmapped.add(['guid', 'name', 'string', 'number', 'email', 'bool', 'enum', 'date', 'dateISO'].includes(word) ? word : '<other>');
    return piece.text;
  }).join('');
}

const line = (text: string): string => oneLine(text).text.trim();

function assertionExpr(assertion: ImpAssertion): string {
  const subject = assertion.target === 'status' ? 'status'
    : assertion.target === 'time' ? 'duration'
    : assertion.target === 'body' ? 'body'
    : assertion.target === 'header' ? `header ${line(assertion.name ?? '')}`
    : `json ${line(assertion.name ?? '$')}`;
  const expected = line(assertion.expected);
  return `${subject} ${assertion.op}${expected === '' ? '' : ` ${expected}`}`;
}

const captureExpr = (capture: ImpCapture): string => `${capture.scope === 'active' ? '' : `${capture.scope}:`}${line(capture.variable)} = ${line(capture.source)}`;

/** Tests become lines of the grammar of the client; a test with no equivalent is a note. */
function convertTestList(list: unknown, context: Context, where: string): { tests: Assertion[]; captures: Capture[] } {
  const converted: TestConversion = convertTests(Array.isArray(list) ? list.filter(isRecord) : [], context.coerce);
  for (const unsupported of converted.unsupported) context.notes.add(where, `A ${unsupported} test has no equivalent and was left out.`);
  return {
    tests: converted.assertions.map(item => ({ expr: mapVariables(assertionExpr(item), context), enabled: true })),
    captures: converted.captures.map(item => ({ expr: mapVariables(captureExpr(item), context), enabled: true }))
  };
}

/** The scripts of Thunder are blocks of lines; the client has one text before and one after. */
function scriptText(scripts: unknown, context: Context, where: string): string {
  if (!isRecord(scripts)) return '';
  const blocks: string[] = [];
  const inline = scripts['inlineScripts'];
  if (Array.isArray(inline)) {
    for (const item of inline) {
      const lines = isRecord(item) && Array.isArray(item['script']) ? item['script'].filter((entry): entry is string => typeof entry === 'string') : [];
      if (lines.some(entry => entry.trim() !== '')) { blocks.push(lines.join('\n')); context.scripts++; }
    }
  }
  if (Array.isArray(scripts['runRequests']) && scripts['runRequests'].length > 0) context.notes.add(where, 'A "run other requests first" setting cannot be carried over.');
  const options = scripts['options'];
  if (isRecord(options) && options['skipRequest'] === true) context.notes.add(where, 'The settings say to run the scripts and not send the request, which cannot be carried over.');
  return blocks.join('\n\n');
}

function thunderAuth(auth: TcAuth | undefined, context: Context, where: string): Auth {
  if (!isRecord(auth)) return { kind: 'inherit' };
  const type = typeof auth.type === 'string' ? auth.type : '';
  if (type === '' || type === 'inherit') return { kind: 'inherit' };
  if (type === 'none') return { kind: 'none' };
  const result = convertAuth(auth, context.coerce);
  if (result.auth?.kind === 'bearer') return { kind: 'bearer', token: mapVariables(result.auth.token.value, context), prefix: 'Bearer' };
  if (result.auth?.kind === 'basic') return { kind: 'basic', username: mapVariables(result.auth.username.value, context), password: mapVariables(result.auth.password.value, context) };
  if (result.auth === undefined && (type === 'bearer' || type === 'basic')) return { kind: 'inherit' };
  context.notes.add(where, result.note !== undefined ? `${result.note.replace(/^\[|\]$/g, '')}: it was left to be inherited.` : `The ${unsupportedType(type)} authentication cannot be converted: it was left to be inherited.`);
  return { kind: 'inherit' };
}

const textBody = (body: Extract<ImpBody, { kind: 'text' }>): Body => (body.contentType === 'application/json' ? { kind: 'json', text: body.text } : body.contentType === 'application/xml' ? { kind: 'xml', text: body.text } : { kind: 'text', contentType: body.contentType, text: body.text });

function thunderBody(raw: unknown, context: Context, where: string): Body {
  const result = convertBody(raw, context.coerce);
  const said = result.issues.filter(issue => issue.message !== undefined);
  if (said.length === 0) for (const note of result.notes) context.notes.add(where, note.replace(/^\[|\]$/g, ''));
  for (const issue of said) context.notes.add(where, issue.message as string);
  const body = result.body;
  if (body === undefined) return { kind: 'none' };
  if (body.kind === 'text') return textBody({ ...body, text: mapVariables(body.text, context) });
  if (body.kind === 'form') return { kind: 'form', fields: body.fields.map(field => row(mapVariables(field.name, context), mapVariables(field.value, context), field.enabled)) };
  if (body.kind === 'graphql') return { kind: 'graphql', query: mapVariables(body.query, context), variables: mapVariables(body.variables ?? '', context) };
  const parts: Part[] = body.parts.map(part => {
    if (part.filePath === undefined) return { name: mapVariables(part.name, context), kind: 'text' as const, value: mapVariables(part.value ?? '', context), file: '', contentType: '', enabled: part.enabled };
    const path = part.filePath;
    const file = leavesFolder(path) ? (path.split(/[\\/]/).filter(piece => piece !== '').pop() ?? '') : path;
    if (leavesFolder(path)) context.notes.add(where, 'A file that is attached has a path outside the folder of the collection: put it in that folder.');
    return { name: mapVariables(part.name, context), kind: 'file' as const, value: '', file, contentType: '', enabled: part.enabled };
  });
  return { kind: 'multipart', parts };
}

function thunderRequest(item: TreeRequest, context: Context, collectionName: string): Request | undefined {
  const source = item.request;
  const { coerce } = context;
  const label = coerce.string(source.name).trim();
  const requestName = label === '' ? 'Request' : printable(label).slice(0, IMPORT_LIMITS.nameChars);
  const where = `${collectionName} / ${requestName}`;
  const type = source.reqType === undefined ? '' : coerce.string(source.reqType);
  if (type !== '' && type !== 'http' && type !== 'graphql') {
    context.notes.add(where, `A ${token(type)} request cannot be sent from here and was skipped.`);
    context.skipped++;
    return undefined;
  }
  context.requests++;
  const request = blankRequest(requestName);
  const method = coerce.string(source.method).trim().toUpperCase();
  request.method = method === '' ? 'GET' : /^[A-Z][A-Z0-9_-]{0,31}$/.test(method) ? method : 'GET';
  if (method !== '' && request.method === 'GET' && method !== 'GET') context.notes.add(where, 'The method was not valid and was replaced by GET.');
  request.docs = readText(source.docs).text;

  // The address and its parameters: the query that the address already has becomes rows; a parameter that the address lacks is added, a disabled one is kept off.
  const split = splitUrl(mapVariables(coerce.string(source.url), context));
  request.url = split.url;
  const query: KV[] = [...split.query];
  const pathParams: KV[] = [];
  for (const param of Array.isArray(source.params) ? source.params : []) {
    if (!isRecord(param)) continue;
    const name = mapVariables(coerce.string(param['name']), context);
    const value = mapVariables(coerce.string(param['value']), context);
    const enabled = !coerce.flag(param['isDisabled']);
    if (name === '') continue;
    if (coerce.flag(param['isPath'])) { pathParams.push(row(name, value, enabled)); continue; }
    if (enabled && query.some(existing => existing.enabled && existing.name === name && existing.value === value)) continue;
    query.push(row(name, value, enabled));
  }
  request.query = query;
  request.pathParams = pathParams;

  request.headers = readHeaders(source.headers, coerce)
    .filter(header => !(header.enabled && isThunderDefault(header.name, header.value)))
    .map(header => row(mapVariables(header.name, context), mapVariables(header.value, context), header.enabled));
  request.body = thunderBody(source.body, context, where);
  request.auth = thunderAuth(source.auth, context, where);
  const tests = convertTestList(source.tests, context, where);
  request.tests = tests.tests;
  request.captures = tests.captures;
  request.scripts = { pre: scriptText(source.preReq, context, where), post: scriptText(source.postReq, context, where) };
  if ((Array.isArray(source.cookies) && source.cookies.length > 0) || (isRecord(source.settings) && Object.keys(source.settings).length > 0)) context.notes.add(where, 'The cookies and the settings of the request (timeout, redirects...) have no equivalent and were dropped.');
  return request;
}

/** The settings of a collection or a folder that the client keeps on it. */
function thunderContainer(name: string, settings: TcSettings | undefined, context: Context, where: string): Container {
  const container = blankFolder(name).container;
  if (!isRecord(settings)) return container;
  container.docs = readText(settings.docs).text;
  const options = settings.options;
  if (isRecord(options) && typeof options['baseUrl'] === 'string') container.baseUrl = mapVariables(options['baseUrl'], context);
  container.headers = readHeaders(settings.headers, context.coerce)
    .filter(header => !(header.enabled && isThunderDefault(header.name, header.value)))
    .map(header => row(mapVariables(header.name, context), mapVariables(header.value, context), header.enabled));
  container.auth = thunderAuth(isRecord(settings.auth) ? (settings.auth as TcAuth) : undefined, context, where);
  const tests = convertTestList(settings.tests, context, where);
  container.tests = tests.tests;
  if (tests.captures.length > 0) context.notes.add(where, `${tests.captures.length} ${tests.captures.length === 1 ? 'test that saves' : 'tests that save'} a variable ${tests.captures.length === 1 ? 'is' : 'are'} set here and ${tests.captures.length === 1 ? 'was' : 'were'} left out: captures belong to a request.`);
  container.scripts = { pre: scriptText(settings.preReq, context, where), post: scriptText(settings.postReq, context, where) };
  if (typeof settings.envId === 'string' && settings.envId !== '') context.notes.add(where, 'The environment that is linked to this folder is not kept: choose the environment in the status bar.');
  return container;
}

function thunderFolder(source: TreeContainer, container: Container, context: Context, where: string, collectionName: string): ImportedFolder {
  const folder: ImportedFolder = { container, requests: [], folders: [] };
  for (const item of source.requests) {
    if (context.requests >= IMPORT_LIMITS.requests) { context.notes.add(where, `A collection of more than ${IMPORT_LIMITS.requests} requests is cut there.`); break; }
    const request = thunderRequest(item, context, collectionName);
    if (request !== undefined) folder.requests.push(request);
  }
  for (const child of source.folders) {
    const label = printable(child.name).trim().slice(0, IMPORT_LIMITS.nameChars);
    const childName = label === '' ? 'Folder' : label;
    const here = `${where} / ${childName}`;
    folder.folders.push(thunderFolder(child, thunderContainer(childName, child.source.settings, context, here), context, here, collectionName));
  }
  return folder;
}

function thunderCollection(collection: TreeCollection, context: Context): { folder: ImportedFolder; moved: number } {
  const label = printable(collection.name).trim().slice(0, IMPORT_LIMITS.nameChars);
  const name = label === '' ? 'Collection' : label;
  const folder = thunderFolder(collection, thunderContainer(name, collection.settings, context, name), context, name, name);
  const protectedCollection = protectCollection(folder);
  return { folder: protectedCollection.collection, moved: protectedCollection.moved };
}

/** From the tree that the Thunder reader and the normaliser made to what the client holds. */
export function thunderToImported(tree: SourceTree): Imported {
  const context: Context = { coerce: new Coercions(), sink: new FindingSink(), notes: new Notes(), unmapped: new Set(), scripts: 0, requests: 0, skipped: 0 };
  const imported: Imported = { collections: [], environments: [], notes: [], skipped: 0 };
  let moved = 0;
  for (const collection of tree.collections) {
    const result = thunderCollection(collection, context);
    imported.collections.push(result.folder);
    moved += result.moved;
  }
  const converted = convertEnvironments(tree.environments, true, context.sink);
  for (const environment of converted.environments) {
    const vars: Var[] = environment.variables.map(variable => ({ name: variable.name, value: mapVariables(variable.value, context), secret: variable.secret || (SECRET_VARIABLE.test(variable.name) && variable.value !== ''), enabled: true }));
    imported.environments.push({ name: environment.name, vars });
  }
  const where = imported.collections[0]?.container.name ?? '';
  if (moved > 0) context.notes.add(where, `${moved} ${moved === 1 ? 'credential that was' : 'credentials that were'} typed into requests ${moved === 1 ? 'was' : 'were'} moved to secret variables of the collection: their values are in a file next to it that Git ignores.`);
  if (context.scripts > 0) context.notes.add(where, `${context.scripts} ${context.scripts === 1 ? 'script was' : 'scripts were'} imported as written. They use Thunder's tc API, of which only a part exists here, and they run only after you allow them.`);
  if (context.unmapped.size > 0) context.notes.add(where, `Thunder's dynamic variables with no equivalent were left as they are: ${[...context.unmapped].sort().join(', ')}.`);
  if (context.coerce.count > 0) context.notes.add(where, `${context.coerce.count} values of the wrong type were converted.`);
  imported.skipped = context.skipped;
  imported.notes = [...findingNotes(tree.findings), ...findingNotes(context.sink.flush()), ...context.notes.done()];
  return imported;
}
