import { leavesFolder, MULTIPART_BOUNDARY } from '../convert/body';
import { protectBodyText } from '../convert/body-secrets';
import { SECRET_VARIABLE, SecretStore } from '../convert/secrets';
import { hasLiteral, mapLiteral, oneLine, splitOutsideVariables } from '../convert/text';
import { parseAssertion, parseCapture } from '../core/assert';
import { effectiveRequest, type Level } from '../core/inherit';
import type { KV, Request, SettingsOverride } from '../core/model';
import { renderRequest } from '../emit/http';
import { identifier } from '../emit/names';
import type { ImpAuth, ImpBody, ImpHeader, ImpQuery, ImpRequest } from '../model/ir';
import { textHash } from '../util/hash';
import { httpSafe } from './safe';

/**
 * The `.http` file that is written next to a request (`list-pets.req.yml` gives `list-pets.http`), for people who use the files with REST
 * Client, JetBrains or httpYac, or only read them in a pull request. It is generated from the request as it is in its collection: the
 * address with its base URL, the headers and the authentication it inherits, the body, the tests and the captures. It is a one-way copy:
 * the request is the source, and what a `.http` file cannot say (scripts, OAuth, settings) is one comment line or left out.
 *
 * The file never holds a secret. Values are not resolved: `{{variables}}` stay as they are. A value that is a literal under the name of
 * a secret (a typed token, a password, the value of an API key, a `"password"` in a body) is written as a `{{secret_...}}` variable
 * that the person defines in an environment, and a note names it.
 */

export interface MirrorInput {
  request: Request;
  /** The collection and the folders above the request, outermost first. */
  levels: readonly Level[];
  /** The settings of the workspace, the weakest level. */
  workspaceSettings: SettingsOverride;
  /** The file of the request, such as `list-pets.req.yml`; its name is on the first line of the mirror and gives the `@name`. */
  file: string;
  /** The name of the collection, for the names of the variables that stand for secrets. */
  collection: string;
  /** How many folders below the folder of its collection the request is, so that a file named in the request can be said from the mirror. */
  depth: number;
}

export interface Mirror {
  /** The request block without the header: what the hash is of. */
  block: string;
  hash: string;
  /** The variables that stand for secrets in the block, with the values they stand for. Kept in memory so that edits of the file can be taken back into the request; never written. */
  secrets: ReadonlyMap<string, string>;
}

const CONTENT_TYPE = 'content-type';
const hasHeader = (headers: readonly ImpHeader[], name: string): boolean => headers.some(header => header.enabled && header.name.toLowerCase() === name);

/** A literal under the name of a secret becomes a variable; anything else stays as it is. */
function protectedBy(store: SecretStore, collection: string, label: string, name: string, value: string): string {
  return SECRET_VARIABLE.test(name) ? store.protect(collection, `${label}_${name}`, value).text : value;
}

const enabled = (rows: readonly KV[]): KV[] => rows.filter(row => row.enabled && row.name !== '');

/** A path that a part of the body names, said from the folder of the mirror: the model keeps it from the folder of the collection. */
function fromMirror(file: string, depth: number): string {
  if (/^(?:[A-Za-z]:|[\\/]|~)/.test(file) || depth === 0) return file;
  return `${'../'.repeat(depth)}${file.replace(/^\.\//, '')}`;
}

function impOf(input: MirrorInput, store: SecretStore, withBody: boolean): ImpRequest {
  const { request, collection } = input;
  const effective = effectiveRequest(request, input.levels, input.workspaceSettings);
  const protect = (label: string, value: string): string => store.protect(collection, label, value).text;
  const notes: string[] = [];

  // ---- headers: the inherited ones and the request's own, and the switched-off ones of the request as comments ----
  const headers: ImpHeader[] = effective.headers.map(header => ({ name: header.name, value: store.protectHeader(collection, header.name, header.value).text, enabled: true, secret: false }));
  for (const row of request.headers) if (!row.enabled && row.name !== '') headers.push({ name: row.name, value: store.protectHeader(collection, row.name, row.value).text, enabled: false, secret: false });

  // ---- authentication ----
  let auth: ImpAuth | undefined;
  const queryFromAuth: string[] = [];
  const given = effective.auth;
  const ownAuthorization = hasHeader(headers, 'authorization');
  if (given.kind === 'bearer' && !ownAuthorization) {
    const token = protect('bearer_token', given.token);
    const prefix = given.prefix.trim();
    if (prefix === '' || prefix === 'Bearer') auth = { kind: 'bearer', token: { value: token, secret: false } };
    else headers.push({ name: 'Authorization', value: `${prefix} ${token}`, enabled: true, secret: false });
  } else if (given.kind === 'basic' && !ownAuthorization) {
    auth = { kind: 'basic', username: { value: given.username, secret: false }, password: { value: protect('basic_password', given.password), secret: false } };
  } else if (given.kind === 'apikey' && given.name !== '') {
    const value = protect(`apikey_${given.name}`, given.value);
    if (given.in === 'query') queryFromAuth.push(`${mapLiteral(given.name, encodeURIComponent)}=${mapLiteral(value, encodeURIComponent)}`);
    else headers.push({ name: given.name, value, enabled: true, secret: false });
  } else if (given.kind === 'oauth2') notes.push('[auth OAuth 2.0 is in the .req.yml: get a token, and send it as Authorization: Bearer]');

  // ---- the address: path parameters, then the query ----
  let url = effective.url.replace(/#.*$/s, '');
  const pathRows = enabled(request.pathParams);
  if (pathRows.length > 0) {
    const values = new Map(pathRows.map(row => [row.name, row.value]));
    const hook = url.indexOf('?');
    const head = (hook < 0 ? url : url.slice(0, hook)).replace(/\{([^{}/?#]+)\}/g, (whole, name: string) => (values.has(name) ? mapLiteral(values.get(name) as string, encodeURIComponent) : whole));
    url = hook < 0 ? head : head + url.slice(hook);
  }
  const encode = effective.settings.encodeUrl ? (text: string): string => mapLiteral(text, encodeURIComponent) : (text: string): string => text;
  const pairs = enabled(request.query).map(row => `${encode(row.name)}=${encode(protectedBy(store, collection, 'query', row.name, row.value))}`);
  // A query that is already in the address is read for secrets too.
  const written = url.indexOf('?');
  if (written >= 0) {
    const fixed = splitOutsideVariables(url.slice(written + 1), '&').map(pair => {
      const cut = pair.indexOf('=');
      return cut < 0 ? pair : `${pair.slice(0, cut + 1)}${protectedBy(store, collection, 'query', pair.slice(0, cut), pair.slice(cut + 1))}`;
    });
    url = `${url.slice(0, written + 1)}${fixed.join('&')}`;
  }
  const query = [...pairs, ...queryFromAuth];
  if (query.length > 0) url += `${url.includes('?') ? (/[?&]$/.test(url) ? '' : '&') : '?'}${query.join('&')}`;
  const disabledQuery: ImpQuery[] = request.query.filter(row => !row.enabled && row.name !== '').map(row => ({ name: row.name, value: protectedBy(store, collection, 'query', row.name, row.value), enabled: false }));

  // ---- the body ----
  let body: ImpBody | undefined;
  let contentType: string | undefined;
  const spec = request.body;
  const inText = (label: string) => (name: string, value: string): string => (hasLiteral(value) ? protect(`${label}_${name}`, value) : value);
  switch (spec.kind) {
    case 'text': body = { kind: 'text', contentType: spec.contentType, text: protectBodyText(spec.text, inText('body')) }; contentType = spec.contentType === '' ? 'text/plain' : spec.contentType; break;
    case 'json': body = { kind: 'text', contentType: 'application/json', text: protectBodyText(spec.text, inText('body')) }; contentType = 'application/json'; break;
    case 'xml': body = { kind: 'text', contentType: 'application/xml', text: protectBodyText(spec.text, inText('body')) }; contentType = 'application/xml'; break;
    case 'form': body = { kind: 'form', fields: spec.fields.filter(field => field.name !== '').map(field => ({ name: field.name, value: protectedBy(store, collection, 'form', field.name, field.value), enabled: field.enabled })) }; contentType = 'application/x-www-form-urlencoded'; break;
    case 'graphql': body = { kind: 'graphql', query: protectBodyText(spec.query, inText('body')), variables: protectBodyText(spec.variables, inText('body')) }; contentType = 'application/json'; break;
    case 'multipart': {
      // A `.http` tool reads the file that a part names, wherever it is: a path that leaves the folder of the collection is not written (the client itself refuses it when it sends).
      const parts: Extract<ImpBody, { kind: 'multipart' }>['parts'] = [];
      for (const part of spec.parts.filter(item => item.name !== '')) {
        if (part.kind === 'file' && leavesFolder(part.file)) notes.push(`[the file part ${oneLine(part.name).text} is not written: its path leaves the folder of the collection]`);
        else if (part.kind === 'file') parts.push({ name: part.name, filePath: fromMirror(part.file, input.depth), enabled: part.enabled });
        else parts.push({ name: part.name, value: protectedBy(store, collection, 'form', part.name, part.value), enabled: part.enabled });
      }
      body = { kind: 'multipart', parts };
      contentType = `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`;
      break;
    }
    case 'binary': notes.push(`[the body is the file ${oneLine(spec.file).text}: it is not written here]`); break;
    default: break;
  }
  if (!withBody && body !== undefined) { body = undefined; contentType = undefined; notes.push('[the body is not written here: a line of it would be read as something else by a .http tool; see the .req.yml]'); }
  if (contentType !== undefined && body !== undefined) {
    if (spec.kind === 'multipart') {
      const at = headers.findIndex(header => header.enabled && header.name.toLowerCase() === CONTENT_TYPE);
      if (at >= 0) headers.splice(at, 1);
      headers.push({ name: 'Content-Type', value: contentType, enabled: true, secret: false });
    } else if (!hasHeader(headers, CONTENT_TYPE)) headers.push({ name: 'Content-Type', value: contentType, enabled: true, secret: false });
  }

  // ---- tests and captures: the grammar is the one of the .http file of the importer, line for line ----
  const directives: string[] = [];
  for (const test of effective.tests) {
    const parsed = parseAssertion(test.expr);
    directives.push(parsed.ok ? `# @assert ${oneLine(parsed.value.source).text}` : `# [test not written: ${oneLine(test.expr).text}]`);
  }
  for (const capture of request.captures) {
    if (!capture.enabled || capture.expr.trim() === '') continue;
    const parsed = parseCapture(capture.expr);
    directives.push(parsed.ok ? `# @capture ${oneLine(parsed.value.source).text}` : `# [capture not written: ${oneLine(capture.expr).text}]`);
  }
  if (effective.preScripts.length > 0 || effective.postScripts.length > 0) notes.push('[the scripts of this request are in the .req.yml: they are not written here]');

  return {
    sourceId: request.id, name: request.name, method: request.method.toUpperCase(), url, query: disabledQuery, headers,
    assertions: [], captures: [], directives, notes, skippedScripts: [],
    ...(request.docs.trim() === '' ? {} : { docs: request.docs }), ...(auth === undefined ? {} : { auth }), ...(body === undefined ? {} : { body })
  };
}

/** The block of the request, as it goes below the header. */
export function mirrorOf(input: MirrorInput): Mirror {
  const store = new SecretStore(true);
  const atName = identifier(input.file.replace(/\.req\.ya?ml$/i, ''));
  let external = false;
  let rendered = renderRequest(impOf(input, store, true), atName, () => { external = true; return ''; });
  if (external) rendered = renderRequest(impOf(input, store, false), atName, () => '');
  // The variables that stand for secrets are named, so that the person knows what to define; their values are not kept anywhere.
  let block = rendered.text;
  if (store.variables.size > 0) {
    const names = [...store.variables.keys()].slice(0, 20);
    const line = `# [values of secrets are not written here: define ${names.join(', ')}${store.variables.size > names.length ? ' and more' : ''} in your environment]`;
    const lines = block.split('\n');
    const at = lines.findIndex((text, index) => index >= 2 && !text.startsWith('#'));
    lines.splice(at < 0 ? lines.length : at, 0, line);
    block = lines.join('\n');
  }
  block = httpSafe(`${block}\n`);
  return { block, hash: textHash(block), secrets: store.variables };
}
