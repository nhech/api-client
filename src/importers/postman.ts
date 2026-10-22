import { SECRET_VARIABLE } from '../convert/secrets';
import { hasLiteral, splitVariables } from '../convert/text';
import { DYNAMIC_WORDS } from '../core/vars';
import { newAuth, type Auth, type Body, type Container, type KV, type Part, type Request, type SettingsOverride, type Var } from '../core/model';
import { printable, printableText } from '../util/chars';
import { protectCollection } from './credentials';
import { blankFolder, blankRequest, IMPORT_LIMITS, Notes, type Imported, type ImportedEnvironment, type ImportedFolder } from './types';
import { row, splitUrl } from './url';

/**
 * A Postman collection (v2.0 or v2.1, the file that "Export" writes), or a Postman environment or globals file, becomes collections and
 * environments of the client. The folders and their order are kept; what a folder or the collection sets (authentication, scripts, variables)
 * stays on it and is inherited the way the client inherits; Postman's `{{variables}}` are the same text here. The scripts are kept as they are: they
 * use the `pm` API, of which the client has a part, and they only run after the person has allowed them. What has no equivalent (an
 * authentication type, a Postman-only variable) is left out and said in the notes. The text is only read: no script is run and no file is opened.
 */
export const POSTMAN_LIMITS = { fileChars: 64 * 1024 * 1024 } as const;

export type PostmanResult = { ok: true; imported: Imported } | { ok: false; error: string };

// ---- reading JSON that somebody else made ----

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Json, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const text = (value: unknown, limit = 100_000): string => (typeof value === 'string' ? printable(value.length > limit ? value.slice(0, limit) : value) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');
/** Text that has lines (a body, a script, a description): the line breaks stay, which `text` would turn into question marks. */
const lines = (value: unknown, limit = 100_000): string => (typeof value === 'string' ? printableText(value.length > limit ? value.slice(0, limit) : value) : text(value, limit));
const flag = (value: unknown): boolean => value === true;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const name = (value: unknown, fallback: string): string => {
  const shown = text(value, IMPORT_LIMITS.nameChars * 2).replace(/[\r\n\t]+/g, ' ').trim().slice(0, IMPORT_LIMITS.nameChars);
  return shown === '' ? fallback : shown;
};
/** A description is a string or `{ content, type }`. */
const description = (value: unknown): string => (isRecord(value) ? lines(own(value, 'content')) : lines(value));
const baseName = (path: string): string => path.split(/[\\/]/).filter(part => part !== '').pop() ?? '';

/** The variables of a text, with Postman's dynamic variables written the way the client knows them; the others are counted by name. */
function mapDynamic(value: string, unmapped: Set<string>): string {
  if (!value.includes('{{$')) return value;
  return splitVariables(value).map(piece => {
    if (!piece.variable) return piece.text;
    const inner = piece.text.slice(2, -2).trim();
    if (!inner.startsWith('$')) return piece.text;
    const word = inner.split(/\s+/)[0] ?? '';
    if (word === '$randomUUID') return '{{$uuid}}';
    if ((DYNAMIC_WORDS as readonly string[]).includes(word)) return piece.text;
    unmapped.add(word.slice(0, 40));
    return piece.text;
  }).join('');
}

interface Context {
  notes: Notes;
  unmapped: Set<string>;
  requests: number;
  scripts: number;
  files: Set<string>;
}

const dyn = (context: Context, value: string): string => mapDynamic(value, context.unmapped);

// ---- the pieces ----

/** `[{ key, value }]` (v2.1) or `{ key: value }` as a record of strings. */
function params(value: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (Array.isArray(value)) {
    for (const item of value) if (isRecord(item)) { const key = text(own(item, 'key'), 100); if (key !== '') out[key] = text(own(item, 'value')); }
  } else if (isRecord(value)) {
    for (const key of Object.keys(value).slice(0, 100)) out[key] = text(own(value, key));
  }
  return out;
}

function readAuth(raw: unknown, where: string, context: Context): Auth {
  if (!isRecord(raw)) return { kind: 'inherit' };
  const type = text(own(raw, 'type'), 40);
  const values = params(own(raw, type));
  const get = (key: string): string => dyn(context, Object.hasOwn(values, key) ? (values[key] as string) : '');
  switch (type) {
    case 'noauth': return { kind: 'none' };
    case 'bearer': return { kind: 'bearer', token: get('token'), prefix: 'Bearer' };
    case 'basic': return { kind: 'basic', username: get('username'), password: get('password') };
    case 'apikey': return { kind: 'apikey', name: get('key'), value: get('value'), in: get('in') === 'query' ? 'query' : 'header' };
    case 'oauth2': {
      const grant = get('grant_type');
      if (grant === 'implicit') { context.notes.add(where, 'The OAuth 2.0 implicit grant is not supported: the authentication was left to be inherited.'); return { kind: 'inherit' }; }
      if (get('addTokenTo') === 'queryParams') context.notes.add(where, 'The OAuth 2.0 access token is sent in a header here, not in the query as Postman was set to.');
      const base = newAuth('oauth2');
      if (base.kind !== 'oauth2') return { kind: 'inherit' };
      return {
        ...base,
        grant: grant === 'client_credentials' ? 'client_credentials' : grant === 'password_credentials' ? 'password' : 'authorization_code',
        pkce: grant === 'authorization_code_with_pkce', authUrl: get('authUrl'), tokenUrl: get('accessTokenUrl'), clientId: get('clientId'), clientSecret: get('clientSecret'),
        scope: get('scope'), audience: get('audience'), username: get('username'), password: get('password'), redirectUrl: get('redirect_uri'),
        clientAuth: /body/i.test(get('client_authentication')) ? 'body' : 'header'
      };
    }
    case '': return { kind: 'inherit' };
    default:
      context.notes.add(where, `The ${printable(type)} authentication is not supported: the authentication was left to be inherited.`);
      return { kind: 'inherit' };
  }
}

/** The scripts of the events: what runs before (prerequest) and after (test) the request. */
function readEvents(raw: unknown, context: Context): { pre: string; post: string } {
  const pre: string[] = [];
  const post: string[] = [];
  for (const event of list(raw)) {
    if (!isRecord(event) || flag(own(event, 'disabled'))) continue;
    const script = own(event, 'script');
    if (!isRecord(script)) continue;
    const exec = own(script, 'exec');
    const code = (Array.isArray(exec) ? exec.map(line => lines(line, 10_000)).join('\n') : lines(exec)).trim();
    if (code === '') continue;
    const listen = text(own(event, 'listen'), 20);
    if (listen === 'prerequest') pre.push(code);
    else if (listen === 'test') post.push(code);
    else continue;
    context.scripts++;
  }
  return { pre: pre.join('\n\n'), post: post.join('\n\n') };
}

function readHeaders(raw: unknown, context: Context): KV[] {
  const headers: KV[] = [];
  for (const item of list(raw)) {
    if (headers.length >= 500) break;
    if (isRecord(item)) {
      const key = text(own(item, 'key'), 300).trim();
      if (key !== '') headers.push(row(dyn(context, key), dyn(context, text(own(item, 'value'))), !flag(own(item, 'disabled')), description(own(item, 'description'))));
    } else if (typeof item === 'string') {
      const colon = item.indexOf(':');
      if (colon > 0) headers.push(row(text(item.slice(0, colon), 300).trim(), text(item.slice(colon + 1)).trim()));
    }
  }
  return headers;
}

function readUrl(raw: unknown, context: Context): { url: string; query: KV[]; pathParams: KV[] } {
  if (typeof raw === 'string') { const split = splitUrl(dyn(context, text(raw, 20_000))); return { url: split.url, query: split.query, pathParams: [] }; }
  if (!isRecord(raw)) return { url: '', query: [], pathParams: [] };
  let address = text(own(raw, 'raw'), 20_000);
  if (address === '') {
    const host = list(own(raw, 'host')).map(part => text(part, 500)).join('.');
    const path = list(own(raw, 'path')).map(part => text(part, 500)).join('/');
    const protocol = text(own(raw, 'protocol'), 20);
    const port = text(own(raw, 'port'), 10);
    address = `${protocol === '' ? '' : `${protocol}://`}${host}${port === '' ? '' : `:${port}`}${path === '' ? '' : `/${path}`}`;
  }
  const split = splitUrl(dyn(context, address));
  const given = own(raw, 'query');
  const query = Array.isArray(given)
    ? given.filter(isRecord).slice(0, 1000).map(item => row(dyn(context, text(own(item, 'key'), 1000)), dyn(context, text(own(item, 'value'))), !flag(own(item, 'disabled')), description(own(item, 'description')))).filter(item => item.name !== '' || item.value !== '')
    : split.query;
  const pathParams = list(own(raw, 'variable')).filter(isRecord).slice(0, 200).map(item => row(text(own(item, 'key'), 200), dyn(context, text(own(item, 'value'))), !flag(own(item, 'disabled')))).filter(item => item.name !== '');
  return { url: split.url, query, pathParams };
}

const RAW_TYPES: Readonly<Record<string, string>> = { text: 'text/plain', html: 'text/html', javascript: 'application/javascript' };

function readBody(raw: unknown, headers: readonly KV[], where: string, context: Context): Body {
  if (!isRecord(raw)) return { kind: 'none' };
  const mode = text(own(raw, 'mode'), 20);
  const type = (headers.find(header => header.enabled && header.name.toLowerCase() === 'content-type')?.value ?? '').toLowerCase();
  if (mode === 'raw') {
    const content = dyn(context, lines(own(raw, 'raw')));
    if (content.trim() === '') return { kind: 'none' };
    const options = own(raw, 'options');
    const rawOptions = isRecord(options) ? own(options, 'raw') : undefined;
    const language = isRecord(rawOptions) ? text(own(rawOptions, 'language'), 20) : '';
    if (language === 'json' || type.includes('json')) return { kind: 'json', text: content };
    if (language === 'xml' || type.includes('xml')) return { kind: 'xml', text: content };
    return { kind: 'text', contentType: RAW_TYPES[language] ?? (type !== '' ? type : 'text/plain'), text: content };
  }
  if (mode === 'urlencoded') {
    const fields = list(own(raw, 'urlencoded')).filter(isRecord).slice(0, 2000).map(item => row(dyn(context, text(own(item, 'key'), 1000)), dyn(context, text(own(item, 'value'))), !flag(own(item, 'disabled')), description(own(item, 'description'))));
    return fields.length === 0 ? { kind: 'none' } : { kind: 'form', fields };
  }
  if (mode === 'formdata') {
    const parts: Part[] = [];
    for (const item of list(own(raw, 'formdata')).filter(isRecord).slice(0, 2000)) {
      const partName = dyn(context, text(own(item, 'key'), 1000));
      const enabled = !flag(own(item, 'disabled'));
      const contentType = text(own(item, 'contentType'), 200);
      if (text(own(item, 'type'), 10) === 'file') {
        const src = own(item, 'src');
        const path = text(Array.isArray(src) ? src[0] : src, 1000);
        const file = baseName(path);
        if (file !== '') context.files.add(file);
        parts.push({ name: partName, kind: 'file', value: '', file, contentType, enabled });
      } else parts.push({ name: partName, kind: 'text', value: dyn(context, text(own(item, 'value'))), file: '', contentType, enabled });
    }
    return parts.length === 0 ? { kind: 'none' } : { kind: 'multipart', parts };
  }
  if (mode === 'file') {
    const file = own(raw, 'file');
    const src = isRecord(file) ? text(own(file, 'src'), 1000) : '';
    const shown = baseName(src);
    if (shown === '') return { kind: 'none' };
    context.files.add(shown);
    return { kind: 'binary', file: shown };
  }
  if (mode === 'graphql') {
    const graphql = own(raw, 'graphql');
    if (!isRecord(graphql)) return { kind: 'none' };
    const variables = own(graphql, 'variables');
    return { kind: 'graphql', query: dyn(context, lines(own(graphql, 'query'))), variables: dyn(context, typeof variables === 'string' ? lines(variables) : isRecord(variables) ? JSON.stringify(variables) : '') };
  }
  if (mode !== '') context.notes.add(where, `A body of the kind ${printable(mode)} is not supported: the request was imported without a body.`);
  return { kind: 'none' };
}

function readSettings(raw: unknown): SettingsOverride {
  const settings: SettingsOverride = {};
  if (!isRecord(raw)) return settings;
  if (own(raw, 'followRedirects') === false) settings.followRedirects = false;
  if (own(raw, 'strictSSL') === false) settings.rejectUnauthorized = false;
  if (own(raw, 'disableCookies') === true) settings.cookies = false;
  const max = own(raw, 'maxRedirects');
  if (typeof max === 'number' && Number.isInteger(max) && max >= 0 && max <= 50) settings.maxRedirects = max;
  return settings;
}

function readRequest(item: Json, context: Context, where: string): Request {
  const requestName = name(own(item, 'name'), 'Request');
  const here = `${where} / ${requestName}`;
  const source = own(item, 'request');
  const record = isRecord(source) ? source : {};
  const request: Request = blankRequest(requestName);
  const method = text(own(record, 'method'), 20).toUpperCase();
  request.method = /^[A-Z][A-Z0-9_-]{0,31}$/.test(method) ? method : 'GET';
  const address = readUrl(typeof source === 'string' ? source : own(record, 'url'), context);
  request.url = address.url;
  request.query = address.query;
  request.pathParams = address.pathParams;
  request.headers = readHeaders(own(record, 'header'), context);
  request.auth = readAuth(own(record, 'auth'), here, context);
  request.body = readBody(own(record, 'body'), request.headers, here, context);
  request.docs = dyn(context, description(own(record, 'description')));
  const events = readEvents(own(item, 'event'), context);
  request.scripts = { pre: events.pre, post: events.post };
  request.settings = readSettings(own(item, 'protocolProfileBehavior'));
  return request;
}

function readVariables(raw: unknown, context: Context): Var[] {
  const vars: Var[] = [];
  const seen = new Set<string>();
  for (const item of list(raw).filter(isRecord).slice(0, IMPORT_LIMITS.variables)) {
    const key = text(own(item, 'key'), 200).trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const value = dyn(context, text(own(item, 'value')));
    vars.push({ name: key, value, secret: text(own(item, 'type'), 20) === 'secret' || (SECRET_VARIABLE.test(key) && hasLiteral(value)), enabled: !flag(own(item, 'disabled')) });
  }
  return vars;
}

/** A collection or a folder: `header` is what names and describes it (the `info` of a collection, the folder item itself). */
function readContainer(item: Json, header: Json, fallback: string, context: Context, where: string): Container {
  const events = readEvents(own(item, 'event'), context);
  const container = blankFolder(name(own(header, 'name'), fallback)).container;
  container.docs = dyn(context, description(own(header, 'description')));
  container.auth = readAuth(own(item, 'auth'), where, context);
  container.scripts = { pre: events.pre, post: events.post };
  container.vars = readVariables(own(item, 'variable'), context);
  return container;
}

function readFolder(item: Json, header: Json, context: Context, where: string, depth: number): ImportedFolder {
  const container = readContainer(item, header, where === '' ? 'Collection' : 'Folder', context, where);
  const folder: ImportedFolder = { container, requests: [], folders: [] };
  const here = where === '' ? container.name : `${where} / ${container.name}`;
  for (const child of list(own(item, 'item'))) {
    if (!isRecord(child)) continue;
    if (Array.isArray(own(child, 'item'))) {
      if (depth >= IMPORT_LIMITS.folderDepth) { context.notes.add(here, `The folders are nested more than ${IMPORT_LIMITS.folderDepth} deep: what is below was left out.`); continue; }
      folder.folders.push(readFolder(child, child, context, here, depth + 1));
    } else if (own(child, 'request') !== undefined) {
      if (context.requests >= IMPORT_LIMITS.requests) { context.notes.add(here, `A collection of more than ${IMPORT_LIMITS.requests} requests is cut there.`); break; }
      context.requests++;
      folder.requests.push(readRequest(child, context, here));
    } else context.notes.add(here, `An item with neither requests nor folders (${name(own(child, 'name'), 'unnamed')}) was left out.`);
  }
  return folder;
}

function readEnvironment(file: Json, context: Context): ImportedEnvironment {
  const scope = text(own(file, '_postman_variable_scope'), 20);
  const vars: Var[] = [];
  const seen = new Set<string>();
  for (const item of list(own(file, 'values')).filter(isRecord).slice(0, IMPORT_LIMITS.variables)) {
    const key = text(own(item, 'key'), 200).trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const value = dyn(context, text(own(item, 'value')));
    vars.push({ name: key, value, secret: text(own(item, 'type'), 20) === 'secret' || (SECRET_VARIABLE.test(key) && hasLiteral(value)), enabled: own(item, 'enabled') !== false });
  }
  const fallback = scope === 'globals' ? 'Postman globals' : 'Postman environment';
  return { name: name(own(file, 'name'), fallback), vars };
}

/** What a Postman file holds: a collection, an environment or a globals file. */
export function parsePostman(input: string): PostmanResult {
  if (input.length > POSTMAN_LIMITS.fileChars) return { ok: false, error: 'The file is too large to be a Postman export.' };
  let json: unknown;
  try { json = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input); } catch { return { ok: false, error: 'This is not JSON, so it is not a Postman export.' }; }
  if (!isRecord(json)) return { ok: false, error: 'This is not a Postman collection or environment: a file of that kind is one JSON object.' };
  const context: Context = { notes: new Notes(), unmapped: new Set(), requests: 0, scripts: 0, files: new Set() };
  const imported: Imported = { collections: [], environments: [], notes: [], skipped: 0 };
  const info = own(json, 'info');
  let moved = 0;
  if (isRecord(info) && Array.isArray(own(json, 'item'))) {
    const made = protectCollection(readFolder(json, info, context, '', 0));
    imported.collections.push(made.collection);
    moved = made.moved;
  } else if (Array.isArray(own(json, 'values'))) {
    imported.environments.push(readEnvironment(json, context));
  } else if (Array.isArray(own(json, 'requests')) || Array.isArray(own(json, 'folders'))) {
    return { ok: false, error: 'This is a Postman collection of the first version (v1), which is not supported. Export it again as Collection v2.1.' };
  } else return { ok: false, error: 'This is not a Postman collection or environment: it has no "info" and "item", and no "values".' };

  const where = imported.collections[0]?.container.name ?? imported.environments[0]?.name ?? '';
  if (moved > 0) context.notes.add(where, `${moved} ${moved === 1 ? 'credential that was' : 'credentials that were'} typed into requests ${moved === 1 ? 'was' : 'were'} moved to secret variables of the collection: their values are in a file next to it that Git ignores.`);
  if (context.scripts > 0) context.notes.add(where, `${context.scripts} ${context.scripts === 1 ? 'script was' : 'scripts were'} imported as written. They use Postman's pm API, of which only a part exists here, and they run only after you allow them.`);
  if (context.files.size > 0) context.notes.add(where, `These files are sent by the requests: put them in the folder of the collection (${[...context.files].slice(0, 5).join(', ')}${context.files.size > 5 ? ', ...' : ''}).`);
  if (context.unmapped.size > 0) context.notes.add(where, `Postman's dynamic variables with no equivalent were left as they are: ${[...context.unmapped].sort().join(', ')}.`);
  imported.notes = context.notes.done();
  return { ok: true, imported };
}
