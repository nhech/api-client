import { newAuth, type Auth, type Body, type KV, type Part, type Request, type Var } from '../core/model';
import { parseLooseYaml } from '../format/yaml/loose';
import { printable, printableText } from '../util/chars';
import { blankFolder, blankRequest, IMPORT_LIMITS, Notes, type Imported, type ImportedEnvironment, type ImportedFolder } from './types';
import { row } from './url';

/**
 * An OpenAPI description (Swagger 2.0, OpenAPI 3.0 and 3.1, as JSON or YAML) becomes a collection of the client: one folder for each tag, one request for
 * each operation, the parameters as rows, a body made from the example of the description or, when there is none, from its schema, the security
 * schemes as authentication with the credentials as secret variables that are left empty, and the servers as environments with the address in
 * `baseUrl`. Only the references inside the file (`#/components/...`) are followed: a reference to another file or to an address is never fetched (the
 * text is only read), and it is said in the notes. The text is data: nothing in it is run, a reference that loops is cut, and the size of what is made
 * from a schema is limited.
 */
export const OPENAPI_LIMITS = { fileChars: 32 * 1024 * 1024, parameters: 200, servers: 10, bodyChars: 64 * 1024, sampleNodes: 2000, sampleDepth: 8, properties: 50 } as const;

export type OpenApiResult = { ok: true; imported: Imported } | { ok: false; error: string };

// ---- reading data that somebody else made ----

type Json = { [key: string]: unknown };
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Json, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, limit = 100_000): string => (typeof value === 'string' ? printable(value.length > limit ? value.slice(0, limit) : value) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');
/** Text that has lines (a description, a body): the line breaks stay, which `text` would turn into question marks. */
const multiline = (value: unknown, limit = 100_000): string => (typeof value === 'string' ? printableText(value.length > limit ? value.slice(0, limit) : value) : text(value, limit));
const oneLine = (value: unknown, limit: number): string => text(value, limit * 2).replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
const name = (value: unknown, fallback: string): string => {
  const shown = oneLine(value, IMPORT_LIMITS.nameChars);
  return shown === '' ? fallback : shown;
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/** Reads the text of a file as JSON or YAML. */
function read(source: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (source.length > OPENAPI_LIMITS.fileChars) return { ok: false, error: 'The file is too large to be an OpenAPI description.' };
  const trimmed = source.trimStart();
  if (trimmed.startsWith('{')) {
    try { return { ok: true, value: JSON.parse(trimmed) as unknown }; } catch { /* a text that is not JSON may still be YAML (a flow mapping), below */ }
  }
  const result = parseLooseYaml(source);
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, error: `The file is not JSON or YAML that can be read (line ${result.error.line}, column ${result.error.column}: ${printable(result.error.message)}).` };
}

// ---- references ----

class Document {
  readonly unresolved = new Set<string>();
  external = 0;

  constructor(readonly root: Json) {}

  /** What a local reference (`#/components/schemas/Pet`) points at, or undefined. */
  private pointer(ref: string): unknown {
    if (ref === '#') return this.root;
    if (!ref.startsWith('#/')) return undefined;
    let current: unknown = this.root;
    for (const raw of ref.slice(2).split('/')) {
      let segment = raw;
      try { segment = decodeURIComponent(raw); } catch { /* as it is */ }
      segment = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(current)) {
        const index = /^(?:0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : -1;
        current = index >= 0 ? current[index] : undefined;
      } else if (isRecord(current)) current = own(current, segment);
      else return undefined;
      if (current === undefined) return undefined;
    }
    return current;
  }

  /** The value, with a `$ref` (and a `$ref` that it points at) followed; `refs` are the references that were followed, to cut a loop. */
  deref(value: unknown): { value: unknown; refs: string[] } {
    const refs: string[] = [];
    let current = value;
    for (let step = 0; step < 20 && isRecord(current); step++) {
      const ref = own(current, '$ref');
      if (typeof ref !== 'string') break;
      if (!ref.startsWith('#')) { this.external++; return { value: undefined, refs }; }
      if (refs.includes(ref)) return { value: undefined, refs };
      refs.push(ref);
      const target = this.pointer(ref);
      if (target === undefined) { this.unresolved.add(oneLine(ref, 80)); return { value: undefined, refs }; }
      current = target;
    }
    return { value: current, refs };
  }

  resolve(value: unknown): unknown { return this.deref(value).value; }
}

// ---- examples made from schemas ----

interface Sample { nodes: number; truncated: boolean }

const FORMATS: Record<string, string> = {
  'date-time': '2024-01-01T00:00:00Z', date: '2024-01-01', time: '00:00:00Z', email: 'user@example.com', uuid: '00000000-0000-0000-0000-000000000000', uri: 'https://example.com',
  url: 'https://example.com', hostname: 'example.com', ipv4: '192.0.2.1', ipv6: '2001:db8::1', byte: 'c3RyaW5n', password: 'string', duration: 'P1D'
};

/** What the schema says a value could be: the example, the default, the first of the enum, or a value of the type. */
function sample(doc: Document, schema: unknown, state: Sample, depth: number, path: string[], forRequest: boolean): unknown {
  if (state.nodes >= OPENAPI_LIMITS.sampleNodes) { state.truncated = true; return null; }
  state.nodes++;
  const resolved = doc.deref(schema);
  // A schema that contains itself, or that is nested deeper than an example needs, is cut with null.
  if (resolved.refs.some(ref => path.includes(ref)) || depth > OPENAPI_LIMITS.sampleDepth) return null;
  const next = [...path, ...resolved.refs];
  const value = resolved.value;
  if (!isRecord(value)) return null;
  for (const key of ['example', 'x-example', 'const', 'default']) if (Object.hasOwn(value, key) && own(value, key) !== undefined) return own(value, key);
  const examples = own(value, 'examples');
  if (Array.isArray(examples) && examples.length > 0) return examples[0];
  if (isRecord(examples)) { const first = Object.values(examples)[0]; if (isRecord(first) && Object.hasOwn(first, 'value')) return own(first, 'value'); }
  const enumeration = list(own(value, 'enum'));
  if (enumeration.length > 0) return enumeration[0];
  const all = list(own(value, 'allOf'));
  if (all.length > 0) {
    const merged: Json = {};
    for (const part of all) {
      const piece = sample(doc, part, state, depth + 1, next, forRequest);
      if (isRecord(piece)) Object.assign(merged, piece);
      else if (all.length === 1) return piece;
    }
    if (isRecord(own(value, 'properties'))) Object.assign(merged, objectSample(doc, value, state, depth, next, forRequest));
    return merged;
  }
  for (const key of ['oneOf', 'anyOf']) {
    const alternatives = list(own(value, key));
    if (alternatives.length > 0) return sample(doc, alternatives[0], state, depth + 1, next, forRequest);
  }
  const declared = own(value, 'type');
  const types = (Array.isArray(declared) ? declared : [declared]).filter(item => typeof item === 'string' && item !== 'null');
  const type = types.length > 0 ? (types[0] as string) : isRecord(own(value, 'properties')) || isRecord(own(value, 'additionalProperties')) ? 'object' : isRecord(own(value, 'items')) ? 'array' : '';
  switch (type) {
    case 'object': return objectSample(doc, value, state, depth, next, forRequest);
    case 'array': return [sample(doc, own(value, 'items'), state, depth + 1, next, forRequest)];
    case 'string': {
      const format = typeof own(value, 'format') === 'string' ? (own(value, 'format') as string) : '';
      return format === 'binary' ? '' : Object.hasOwn(FORMATS, format) ? FORMATS[format] : 'string';
    }
    case 'integer':
    case 'number': return 0;
    case 'boolean': return true;
    default: return declared === 'null' ? null : {};
  }
}

function objectSample(doc: Document, schema: Json, state: Sample, depth: number, path: string[], forRequest: boolean): Json {
  const result: Json = {};
  const properties = own(schema, 'properties');
  let count = 0;
  if (isRecord(properties)) {
    for (const key of Object.keys(properties)) {
      if (++count > OPENAPI_LIMITS.properties) { state.truncated = true; break; }
      const property = doc.resolve(own(properties, key));
      // What the server makes (readOnly) is not something to send.
      if (forRequest && isRecord(property) && own(property, 'readOnly') === true) continue;
      result[key] = sample(doc, own(properties, key), state, depth + 1, path, forRequest);
    }
  } else if (isRecord(doc.resolve(own(schema, 'additionalProperties')))) {
    result['key'] = sample(doc, own(schema, 'additionalProperties'), state, depth + 1, path, forRequest);
  }
  return result;
}

/** A small XML text for a value that was made from a schema: one element for each property, one for each item of a list. */
function xmlOf(value: unknown, tag: string, depth: number, out: string[]): void {
  const safe = /^[A-Za-z_][\w.-]*$/.test(tag) ? tag : 'item';
  if (Array.isArray(value)) { for (const item of value) xmlOf(item, safe, depth, out); return; }
  const pad = '  '.repeat(depth);
  if (isRecord(value)) {
    out.push(`${pad}<${safe}>`);
    for (const key of Object.keys(value)) xmlOf(value[key], key, depth + 1, out);
    out.push(`${pad}</${safe}>`);
    return;
  }
  const raw = value === null || value === undefined ? '' : String(value);
  out.push(`${pad}<${safe}>${raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</${safe}>`);
}

// ---- parameters ----

interface Param { name: string; in: string; required: boolean; value: string; description: string }

/** A value for a parameter: the example, the default or the first of the enum; a list becomes its items joined with a comma. */
function paramValue(doc: Document, param: Json): string {
  const schema = isRecord(doc.resolve(own(param, 'schema'))) ? doc.resolve(own(param, 'schema')) : param;
  let picked: unknown;
  for (const source of [param, schema]) {
    if (!isRecord(source)) continue;
    for (const key of ['example', 'x-example', 'default']) if (picked === undefined && own(source, key) !== undefined) picked = own(source, key);
  }
  const examples = own(param, 'examples');
  if (picked === undefined && isRecord(examples)) { const first = Object.values(examples)[0]; if (isRecord(first)) picked = own(first, 'value'); }
  if (picked === undefined && isRecord(schema)) {
    const enumeration = list(own(schema, 'enum'));
    if (enumeration.length > 0) picked = enumeration[0];
    else if (isRecord(doc.resolve(own(schema, 'items')))) { const inner = doc.resolve(own(schema, 'items')) as Json; const e = list(own(inner, 'enum')); if (e.length > 0) picked = [e[0]]; }
  }
  if (Array.isArray(picked)) return picked.map(item => text(item, 200)).join(',');
  if (isRecord(picked)) return '';
  return text(picked, 1000);
}

function readParams(doc: Document, lists: unknown[][], notes: Notes, where: string): Param[] {
  const byKey = new Map<string, Param>();
  let cookies = 0;
  for (const entries of lists) {
    for (const raw of entries.slice(0, OPENAPI_LIMITS.parameters)) {
      const param = doc.resolve(raw);
      if (!isRecord(param)) continue;
      const place = text(own(param, 'in'), 20);
      const paramName = oneLine(own(param, 'name'), 100);
      if (paramName === '' || place === '') continue;
      if (place === 'cookie') { cookies++; continue; }
      if (place !== 'query' && place !== 'header' && place !== 'path') continue;
      // The description says these three are not carried by a parameter.
      if (place === 'header' && /^(?:accept|content-type|authorization)$/i.test(paramName)) continue;
      byKey.set(`${place}\n${paramName}`, { name: paramName, in: place, required: own(param, 'required') === true || place === 'path', value: paramValue(doc, param), description: oneLine(own(param, 'description'), 200) });
    }
  }
  if (cookies > 0) notes.add(where, `${cookies === 1 ? 'A cookie parameter was' : `${cookies} cookie parameters were`} left out: cookies are sent from the cookie jar.`);
  return [...byKey.values()];
}

// ---- security ----

interface Scheme { kind: 'bearer' | 'basic' | 'apikey' | 'oauth2' | 'unsupported'; label: string; apiName: string; apiIn: 'header' | 'query' | 'cookie'; flows: Json; flow2: string; authUrl: string; tokenUrl: string }

class Security {
  private readonly schemes = new Map<string, Scheme>();
  /** The names of the variables that were made, by scheme and field. */
  private readonly names = new Map<string, string>();
  private readonly taken = new Set<string>();
  readonly vars: Var[] = [];

  constructor(private readonly doc: Document, private readonly notes: Notes) {
    const definitions = doc.root['openapi'] === undefined ? own(doc.root, 'securityDefinitions') : own(isRecord(own(doc.root, 'components')) ? (own(doc.root, 'components') as Json) : {}, 'securitySchemes');
    if (!isRecord(definitions)) return;
    for (const key of Object.keys(definitions).slice(0, 50)) {
      const raw = doc.resolve(own(definitions, key));
      if (isRecord(raw)) this.schemes.set(key, this.scheme(raw));
    }
  }

  private scheme(raw: Json): Scheme {
    const type = text(own(raw, 'type'), 30);
    const base: Scheme = { kind: 'unsupported', label: oneLine(type === 'http' ? `http ${text(own(raw, 'scheme'), 20)}` : type, 40), apiName: '', apiIn: 'header', flows: {}, flow2: '', authUrl: '', tokenUrl: '' };
    if (type === 'http') {
      const scheme = text(own(raw, 'scheme'), 20).toLowerCase();
      return scheme === 'bearer' ? { ...base, kind: 'bearer' } : scheme === 'basic' ? { ...base, kind: 'basic' } : base;
    }
    if (type === 'basic') return { ...base, kind: 'basic' };
    if (type === 'apiKey') {
      const place = text(own(raw, 'in'), 10);
      return { ...base, kind: 'apikey', apiName: oneLine(own(raw, 'name'), 100), apiIn: place === 'query' ? 'query' : place === 'cookie' ? 'cookie' : 'header' };
    }
    if (type === 'oauth2') {
      const flows = own(raw, 'flows');
      return { ...base, kind: 'oauth2', flows: isRecord(flows) ? flows : {}, flow2: text(own(raw, 'flow'), 20), authUrl: oneLine(own(raw, 'authorizationUrl'), 500), tokenUrl: oneLine(own(raw, 'tokenUrl'), 500) };
    }
    return base;
  }

  /** The name of a variable for a field of a scheme: the plain word for the first scheme of a kind, the name of the scheme in front of it for the others. */
  private variable(scheme: string, kind: string, field: string, secret: boolean): string {
    const key = `${scheme}\n${field}`;
    const known = this.names.get(key);
    if (known !== undefined) return known;
    let chosen = field;
    if (this.taken.has(chosen)) chosen = `${scheme.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || kind}_${field}`;
    let candidate = chosen;
    for (let index = 2; this.taken.has(candidate); index++) candidate = `${chosen}_${index}`;
    this.taken.add(candidate);
    this.names.set(key, candidate);
    this.vars.push({ name: candidate, value: '', secret, enabled: true });
    return candidate;
  }

  /** The authentication for a requirement (`{ scheme: [scopes] }`): the first scheme of the first alternative that the client can use. */
  auth(requirements: unknown, where: string): Auth | undefined {
    const alternatives = list(requirements).filter(isRecord);
    if (alternatives.length === 0) return undefined;
    for (const requirement of alternatives) {
      const keys = Object.keys(requirement);
      for (const key of keys) {
        const scheme = this.schemes.get(key);
        if (scheme === undefined) { this.notes.add(where, `The security scheme ${oneLine(key, 60)} is not defined in the description.`); continue; }
        const made = this.convert(key, scheme, list(own(requirement, key)).map(item => text(item, 100)).filter(item => item !== ''), where);
        if (made !== undefined) {
          if (keys.length > 1) this.notes.add(where, 'More than one security scheme is required together; only the first is used.');
          if (alternatives.length > 1) this.notes.add(where, `${alternatives.length} ways to authenticate are allowed; the first one that can be used was taken.`);
          return made;
        }
      }
    }
    return undefined;
  }

  private convert(key: string, scheme: Scheme, scopes: string[], where: string): Auth | undefined {
    switch (scheme.kind) {
      case 'bearer': return { kind: 'bearer', token: `{{${this.variable(key, 'bearer', 'token', true)}}}`, prefix: 'Bearer' };
      case 'basic': return { kind: 'basic', username: `{{${this.variable(key, 'basic', 'username', false)}}}`, password: `{{${this.variable(key, 'basic', 'password', true)}}}` };
      case 'apikey':
        if (scheme.apiIn === 'cookie') { this.notes.add(where, 'An API key in a cookie cannot be set here.'); return undefined; }
        return { kind: 'apikey', name: scheme.apiName, value: `{{${this.variable(key, 'apikey', 'apiKey', true)}}}`, in: scheme.apiIn };
      case 'oauth2': return this.oauth(key, scheme, scopes, where);
      default:
        this.notes.add(where, `The ${scheme.label === '' ? 'security' : scheme.label} scheme is not supported.`);
        return undefined;
    }
  }

  private oauth(key: string, scheme: Scheme, scopes: string[], where: string): Auth | undefined {
    const base = newAuth('oauth2');
    if (base.kind !== 'oauth2') return undefined;
    let grant: 'authorization_code' | 'client_credentials' | 'password' | undefined;
    let authUrl = '';
    let tokenUrl = '';
    let allScopes: string[] = [];
    const flows = scheme.flows;
    const pick = (flowName: string): Json | undefined => { const value = own(flows, flowName); return isRecord(value) ? value : undefined; };
    if (Object.keys(flows).length > 0) {
      const code = pick('authorizationCode');
      const credentials = pick('clientCredentials');
      const password = pick('password');
      const chosen = code ?? credentials ?? password;
      if (chosen === undefined) { this.notes.add(where, 'Only the implicit OAuth 2.0 flow is described, and it is not supported.'); return undefined; }
      grant = code !== undefined ? 'authorization_code' : credentials !== undefined ? 'client_credentials' : 'password';
      authUrl = oneLine(own(chosen, 'authorizationUrl'), 500);
      tokenUrl = oneLine(own(chosen, 'tokenUrl'), 500);
      const declared = own(chosen, 'scopes');
      if (isRecord(declared)) allScopes = Object.keys(declared).slice(0, 50);
    } else {
      grant = scheme.flow2 === 'accessCode' ? 'authorization_code' : scheme.flow2 === 'application' ? 'client_credentials' : scheme.flow2 === 'password' ? 'password' : undefined;
      if (grant === undefined) { this.notes.add(where, 'Only the implicit OAuth 2.0 flow is described, and it is not supported.'); return undefined; }
      authUrl = scheme.authUrl;
      tokenUrl = scheme.tokenUrl;
    }
    const clientId = this.variable(key, 'oauth', 'clientId', false);
    const clientSecret = this.variable(key, 'oauth', 'clientSecret', true);
    const result: Auth = {
      ...base, grant, pkce: grant === 'authorization_code', authUrl, tokenUrl, clientId: `{{${clientId}}}`, clientSecret: grant === 'authorization_code' ? '' : `{{${clientSecret}}}`,
      scope: (scopes.length > 0 ? scopes : allScopes).join(' ')
    };
    if (grant === 'password') {
      result.username = `{{${this.variable(key, 'oauth', 'username', false)}}}`;
      result.password = `{{${this.variable(key, 'oauth', 'password', true)}}}`;
    }
    return result;
  }
}

const sameAuth = (left: Auth, right: Auth): boolean => JSON.stringify(left) === JSON.stringify(right);

// ---- bodies ----

interface BodyChoice { mediaType: string; schema: unknown; example: unknown; hasExample: boolean }

const PREFERENCE = [
  (type: string) => type === 'application/json',
  (type: string) => /^application\/[\w.+-]*\+json$/.test(type) || type === 'text/json',
  (type: string) => type === 'application/x-www-form-urlencoded',
  (type: string) => type === 'multipart/form-data',
  (type: string) => type === 'application/xml' || type === 'text/xml' || /^application\/[\w.+-]*\+xml$/.test(type),
  (type: string) => type === 'text/plain'
];

function chooseBody(choices: BodyChoice[]): BodyChoice | undefined {
  for (const accepts of PREFERENCE) { const found = choices.find(choice => accepts(choice.mediaType)); if (found !== undefined) return found; }
  return choices[0];
}

/** The text of an example value for a body, shortened to what a request file can hold. */
function jsonText(value: unknown): string {
  let out = '';
  try { out = JSON.stringify(value, null, 2) ?? ''; } catch { out = ''; }
  return out.length > OPENAPI_LIMITS.bodyChars ? '' : printableText(out);
}

/** Whether a schema says what a value could be (an example, a default, a constant, a list to choose from), and not only its type. */
const given = (schema: unknown): boolean => isRecord(schema) && ['example', 'x-example', 'default', 'const', 'enum', 'examples'].some(key => own(schema, key) !== undefined);

/**
 * The fields of an object schema, for a form: each property with a value from its example or default, switched on when it is required or has one; a field
 * that is optional and has nothing to start from is empty and off.
 */
interface FormField { name: string; value: string; on: boolean; file: boolean; description: string }

function fieldsOf(doc: Document, schema: unknown, state: Sample): FormField[] {
  const resolved = doc.resolve(schema);
  if (!isRecord(resolved)) return [];
  const properties = own(resolved, 'properties');
  if (!isRecord(properties)) return [];
  const required = new Set(list(own(resolved, 'required')).map(item => text(item, 100)));
  const fields: FormField[] = [];
  for (const key of Object.keys(properties).slice(0, OPENAPI_LIMITS.properties)) {
    const property = doc.resolve(own(properties, key));
    if (isRecord(property) && own(property, 'readOnly') === true) continue;
    const file = isRecord(property) && (own(property, 'format') === 'binary' || own(property, 'type') === 'file');
    const on = required.has(key) || given(property);
    const value = file || !on ? '' : sample(doc, own(properties, key), state, 1, [], true);
    fields.push({
      name: oneLine(key, 100), value: typeof value === 'object' && value !== null ? JSON.stringify(value) : text(value, 1000), on, file,
      description: isRecord(property) ? oneLine(own(property, 'description'), 200) : ''
    });
  }
  return fields;
}

// ---- the operation ----

interface Context {
  doc: Document;
  notes: Notes;
  security: Security;
  collectionAuth: Auth;
  version: 2 | 3;
  consumes: string[];
}

function bodyChoices(context: Context, operation: Json, params: unknown[]): BodyChoice[] {
  const { doc } = context;
  if (context.version === 3) {
    const body = doc.resolve(own(operation, 'requestBody'));
    if (!isRecord(body)) return [];
    const content = own(body, 'content');
    if (!isRecord(content)) return [];
    const choices: BodyChoice[] = [];
    for (const type of Object.keys(content).slice(0, 20)) {
      const media = own(content, type);
      if (!isRecord(media)) continue;
      const examples = own(media, 'examples');
      let example: unknown = own(media, 'example');
      if (example === undefined && isRecord(examples)) { const first = doc.resolve(Object.values(examples)[0]); if (isRecord(first)) example = own(first, 'value'); }
      choices.push({ mediaType: type.split(';')[0]?.trim().toLowerCase() ?? type, schema: own(media, 'schema'), example, hasExample: example !== undefined });
    }
    return choices;
  }
  // Swagger 2.0: the body parameter, or the form parameters, and the media types the operation consumes.
  const operationConsumes = list(own(operation, 'consumes')).map(item => text(item, 100).toLowerCase()).filter(item => item !== '');
  const consumes = operationConsumes.length > 0 ? operationConsumes : context.consumes;
  const resolved = params.map(item => doc.resolve(item)).filter(isRecord);
  const body = resolved.find(item => own(item, 'in') === 'body');
  if (body !== undefined) {
    const types = consumes.length > 0 ? consumes : ['application/json'];
    const example = own(body, 'x-example') ?? own(body, 'example');
    return types.map(type => ({ mediaType: type, schema: own(body, 'schema'), example, hasExample: example !== undefined }));
  }
  const form = resolved.filter(item => own(item, 'in') === 'formData');
  if (form.length === 0) return [];
  const properties: Json = {};
  const required: string[] = [];
  for (const field of form.slice(0, OPENAPI_LIMITS.parameters)) {
    const fieldName = oneLine(own(field, 'name'), 100);
    if (fieldName === '') continue;
    properties[fieldName] = own(field, 'type') === 'file' ? { type: 'string', format: 'binary' } : field;
    if (own(field, 'required') === true) required.push(fieldName);
  }
  const hasFile = form.some(field => own(field, 'type') === 'file');
  // Form parameters go in a form: whatever else the description says it consumes (JSON, usually, for all the operations) is not how they are sent.
  const formTypes = consumes.filter(type => type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data');
  const types = hasFile ? ['multipart/form-data'] : formTypes.length > 0 ? formTypes : ['application/x-www-form-urlencoded'];
  return types.map(type => ({ mediaType: type, schema: { type: 'object', properties, required }, example: undefined, hasExample: false }));
}

function makeBody(context: Context, choices: BodyChoice[], where: string): { body: Body; header?: KV } {
  const choice = chooseBody(choices);
  if (choice === undefined) return { body: { kind: 'none' } };
  const { doc, notes } = context;
  const type = choice.mediaType;
  const state: Sample = { nodes: 0, truncated: false };
  const value = (): unknown => (choice.hasExample ? choice.example : sample(doc, choice.schema, state, 0, [], true));
  const others = choices.filter(item => item !== choice).map(item => item.mediaType);
  if (others.length > 0) notes.add(where, `The body is also described as ${others.slice(0, 4).join(', ')}; ${type} was used.`);
  let result: { body: Body; header?: KV };
  if (PREFERENCE[0]?.(type) === true || PREFERENCE[1]?.(type) === true) {
    const made = value();
    const body = typeof made === 'string' && choice.hasExample ? printableText(made.slice(0, OPENAPI_LIMITS.bodyChars)) : jsonText(made);
    result = { body: { kind: 'json', text: body } };
    if (type !== 'application/json') result.header = row('Content-Type', type);
  } else if (type === 'application/x-www-form-urlencoded') {
    const fields = fieldsOf(doc, choice.schema, state).map(field => row(field.name, field.value, field.on, field.description));
    result = { body: { kind: 'form', fields } };
  } else if (type === 'multipart/form-data') {
    const parts: Part[] = fieldsOf(doc, choice.schema, state).map(field => ({ name: field.name, kind: field.file ? 'file' : 'text', value: field.file ? '' : field.value, file: '', contentType: '', enabled: field.on || field.file }));
    if (parts.some(part => part.kind === 'file')) notes.add(where, 'Choose the files of the form in the Body tab.');
    result = { body: { kind: 'multipart', parts } };
  } else if (PREFERENCE[4]?.(type) === true) {
    const made = value();
    let xml = '';
    if (typeof made === 'string') xml = printableText(made.slice(0, OPENAPI_LIMITS.bodyChars));
    else {
      const lines: string[] = [];
      const schemaRoot = doc.deref(choice.schema);
      const rootName = isRecord(schemaRoot.value) && isRecord(own(schemaRoot.value, 'xml')) ? oneLine(own(own(schemaRoot.value, 'xml') as Json, 'name'), 60) : (schemaRoot.refs[0]?.split('/').pop() ?? 'root');
      xmlOf(made, rootName === '' ? 'root' : rootName, 0, lines);
      xml = printableText(lines.join('\n'));
    }
    result = { body: { kind: 'xml', text: xml.length > OPENAPI_LIMITS.bodyChars ? '' : xml } };
    if (type !== 'application/xml') result.header = row('Content-Type', type);
  } else if (type === 'text/plain' || type.startsWith('text/')) {
    const made = value();
    result = { body: { kind: 'text', contentType: type, text: typeof made === 'string' ? printableText(made.slice(0, OPENAPI_LIMITS.bodyChars)) : jsonText(made) } };
  } else {
    notes.add(where, `The body is ${type}: choose the file in the Body tab.`);
    result = { body: { kind: 'binary', file: '' } };
  }
  if (state.truncated) { notes.add(where, 'The example of the body was cut: the schema is large or deeply nested.'); }
  if (result.body.kind === 'json' && result.body.text === '' && !choice.hasExample) notes.add(where, 'The body is too large to be made from its schema; write it in the Body tab.');
  return result;
}

const PATH_PARAM = /\{([^{}/?#]+)\}/g;

function makeRequest(context: Context, method: string, path: string, pathItem: Json, operation: Json, where: string): Request {
  const { doc, notes } = context;
  const summary = oneLine(own(operation, 'summary'), IMPORT_LIMITS.nameChars);
  const operationId = oneLine(own(operation, 'operationId'), IMPORT_LIMITS.nameChars);
  const request = blankRequest(name(summary !== '' ? summary : operationId, `${method.toUpperCase()} ${path}`));
  request.method = method.toUpperCase();
  request.url = printable(path);
  const parameterLists = [list(own(pathItem, 'parameters')), list(own(operation, 'parameters'))];
  const params = readParams(doc, parameterLists, notes, where);
  for (const param of params) {
    if (param.in === 'query') request.query.push(row(param.name, param.value, param.required, param.description));
    else if (param.in === 'header') request.headers.push(row(param.name, param.value, param.required, param.description));
  }
  const declared = new Map(params.filter(param => param.in === 'path').map(param => [param.name, param]));
  const names: string[] = [];
  for (const match of path.matchAll(PATH_PARAM)) { const found = match[1] as string; if (!names.includes(found)) names.push(found); }
  for (const found of names) {
    const param = declared.get(found);
    request.pathParams.push(row(found, param !== undefined && param.value !== '' ? param.value : `{{${found.replace(/[^A-Za-z0-9_-]+/g, '_')}}}`, true, param?.description ?? ''));
  }
  const choices = bodyChoices(context, operation, [...list(own(pathItem, 'parameters')), ...list(own(operation, 'parameters'))]);
  const made = makeBody(context, choices, where);
  request.body = made.body;
  if (made.header !== undefined) request.headers.push(made.header);
  // Authentication: what the operation says, or what the description says for all of them.
  if (Object.hasOwn(operation, 'security')) {
    const requirements = list(own(operation, 'security'));
    const hasAlternative = requirements.some(item => isRecord(item) && Object.keys(item).length > 0);
    if (!hasAlternative) request.auth = context.collectionAuth.kind === 'inherit' || context.collectionAuth.kind === 'none' ? { kind: 'inherit' } : { kind: 'none' };
    else {
      const auth = context.security.auth(requirements, where);
      request.auth = auth === undefined || sameAuth(auth, context.collectionAuth) ? { kind: 'inherit' } : auth;
    }
  }
  const description = multiline(own(operation, 'description'));
  const lines: string[] = [];
  if (own(operation, 'deprecated') === true) lines.push('**Deprecated.**');
  if (description !== '') lines.push(description);
  else if (summary !== '' && request.name !== summary) lines.push(summary);
  if (operationId !== '') lines.push(`Operation ID: ${operationId}`);
  request.docs = lines.join('\n\n');
  const responses = own(operation, 'responses');
  if (isRecord(responses)) {
    const codes = Object.keys(responses).filter(code => /^2\d\d$/.test(code)).sort();
    if (codes.length > 0) request.tests.push({ expr: `status == ${codes[0]}`, enabled: true });
  }
  if (isRecord(own(operation, 'callbacks'))) notes.add(where, 'The callbacks of the operation were left out: they are requests that the server sends.');
  return request;
}

// ---- servers ----

function serverUrl(server: Json, notes: Notes): string {
  let url = oneLine(own(server, 'url'), 500);
  const variables = own(server, 'variables');
  url = url.replace(PATH_PARAM, (all, key: string) => {
    const variable = isRecord(variables) ? own(variables, key) : undefined;
    const value = isRecord(variable) ? own(variable, 'default') : undefined;
    if (typeof value === 'string' || typeof value === 'number') return oneLine(value, 100);
    notes.add('', `The server address has a variable ${oneLine(key, 40)} without a default.`);
    return all;
  });
  return url;
}

function environments(doc: Document, version: 2 | 3, notes: Notes): ImportedEnvironment[] {
  const root = doc.root;
  const addresses: { url: string; label: string }[] = [];
  if (version === 3) {
    for (const server of list(own(root, 'servers')).slice(0, OPENAPI_LIMITS.servers)) {
      if (isRecord(server)) addresses.push({ url: serverUrl(server, notes), label: oneLine(own(server, 'description'), 60) });
    }
  } else {
    const host = oneLine(own(root, 'host'), 200);
    const basePath = oneLine(own(root, 'basePath'), 200);
    const schemes = list(own(root, 'schemes')).map(item => text(item, 10));
    const scheme = schemes.includes('https') ? 'https' : schemes[0] ?? 'http';
    if (host !== '') addresses.push({ url: `${scheme}://${host}${basePath === '/' ? '' : basePath}`, label: '' });
    else if (basePath !== '') addresses.push({ url: basePath, label: '' });
  }
  if (addresses.length === 0) { notes.add('', 'The description names no server: baseUrl is http://localhost; change it to the address of the API.'); addresses.push({ url: 'http://localhost', label: 'Local' }); }
  const result: ImportedEnvironment[] = [];
  const used = new Set<string>();
  for (const [index, address] of addresses.entries()) {
    let value = address.url === '' ? '/' : address.url;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      notes.add('', `The server address ${oneLine(value, 80)} has no host: it was put after http://localhost; change baseUrl to the address of the API.`);
      value = `http://localhost${value.startsWith('/') ? '' : '/'}${value === '/' ? '' : value}`;
    }
    let label = address.label;
    if (label === '') { try { label = new URL(value).host; } catch { label = ''; } }
    let candidate = label === '' ? `Server ${index + 1}` : label;
    for (let count = 2; used.has(candidate); count++) candidate = `${label === '' ? `Server ${index + 1}` : label} ${count}`;
    used.add(candidate);
    result.push({ name: candidate, vars: [{ name: 'baseUrl', value, secret: false, enabled: true }] });
  }
  return result;
}

// ---- the whole description ----

/** A description is data from anywhere: one that is nested deeper than the engine can walk is refused, not a crash. */
export function parseOpenApi(source: string): OpenApiResult {
  try {
    return convert(source);
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, error: 'The description is nested too deeply to be read.' };
    throw error;
  }
}

function convert(source: string): OpenApiResult {
  const parsed = read(source);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) return { ok: false, error: 'This is not an OpenAPI or Swagger description: the file is not a mapping.' };
  const root = parsed.value;
  const openapi = own(root, 'openapi');
  const swagger = own(root, 'swagger');
  const version: 2 | 3 | undefined = typeof openapi === 'string' && openapi.startsWith('3.') ? 3 : swagger === '2.0' || swagger === 2 ? 2 : undefined;
  if (version === undefined) {
    return { ok: false, error: typeof openapi === 'string' ? `The OpenAPI version ${oneLine(openapi, 20)} is not supported: versions 2.0 (Swagger), 3.0 and 3.1 are.` : 'This is not an OpenAPI or Swagger description: it has no "openapi" or "swagger" field.' };
  }
  const paths = own(root, 'paths');
  const webhooks = isRecord(own(root, 'webhooks')) ? Object.keys(own(root, 'webhooks') as Json).length : 0;
  if (!isRecord(paths) && webhooks === 0) return { ok: false, error: 'The description has no "paths": there is nothing to import.' };

  const doc = new Document(root);
  const notes = new Notes();
  const info = isRecord(own(root, 'info')) ? (own(root, 'info') as Json) : {};
  const title = name(own(info, 'title'), 'OpenAPI');
  const security = new Security(doc, notes);
  const collection = blankFolder(title);
  const versionText = oneLine(own(info, 'version'), 40);
  collection.container.docs = [multiline(own(info, 'description')), versionText === '' ? '' : `Version: ${versionText}`].filter(item => item !== '').join('\n\n');
  collection.container.baseUrl = '{{baseUrl}}';
  const rootRequirement = security.auth(own(root, 'security'), '');
  collection.container.auth = rootRequirement ?? { kind: 'inherit' };

  const consumes = list(own(root, 'consumes')).map(item => text(item, 100).toLowerCase()).filter(item => item !== '');
  const context: Context = { doc, notes, security, collectionAuth: collection.container.auth, version, consumes };

  // The folders: the tags in the order the description lists them, then the others in the order they are met.
  const folders = new Map<string, ImportedFolder>();
  for (const tag of list(own(root, 'tags')).slice(0, 200)) {
    if (!isRecord(tag)) continue;
    const tagName = name(own(tag, 'name'), '');
    if (tagName === '' || folders.has(tagName)) continue;
    const folder = blankFolder(tagName);
    folder.container.docs = multiline(own(tag, 'description'));
    folders.set(tagName, folder);
  }
  const folderOf = (tagName: string): ImportedFolder => {
    let folder = folders.get(tagName);
    if (folder === undefined) { folder = blankFolder(tagName); folders.set(tagName, folder); }
    return folder;
  };

  let operations = 0;
  let several = 0;
  let trace = 0;
  let stopped = false;
  if (isRecord(paths)) {
    for (const path of Object.keys(paths)) {
      if (!path.startsWith('/')) continue;
      const pathItem = doc.resolve(own(paths, path));
      if (!isRecord(pathItem)) continue;
      if (isRecord(own(pathItem, 'trace'))) trace++;
      for (const method of METHODS) {
        const operation = doc.resolve(own(pathItem, method));
        if (!isRecord(operation)) continue;
        if (operations >= IMPORT_LIMITS.requests) { stopped = true; break; }
        operations++;
        const where = `${method.toUpperCase()} ${oneLine(path, 100)}`;
        const request = makeRequest(context, method, path, pathItem, operation, where);
        const tags = list(own(operation, 'tags')).map(item => name(item, '')).filter(item => item !== '');
        if (tags.length > 1) several++;
        (tags.length === 0 ? collection : folderOf(tags[0] as string)).requests.push(request);
      }
      if (stopped) break;
    }
  }
  collection.folders = [...folders.values()].filter(folder => folder.requests.length > 0);
  collection.container.vars = security.vars;

  if (stopped) notes.add('', `Only the first ${IMPORT_LIMITS.requests} operations were imported.`);
  if (several > 0) notes.add('', `${several} ${several === 1 ? 'operation has' : 'operations have'} more than one tag: ${several === 1 ? 'it was' : 'each was'} put in the folder of its first tag.`);
  if (trace > 0) notes.add('', `${trace} ${trace === 1 ? 'operation uses' : 'operations use'} the TRACE method, which is not imported.`);
  if (webhooks > 0) notes.add('', `${webhooks === 1 ? 'A webhook of the description was' : `${webhooks} webhooks of the description were`} left out: they are requests that the server sends.`);
  if (doc.external > 0) notes.add('', `${doc.external === 1 ? 'A reference to another file or address was' : `${doc.external} references to other files or addresses were`} not followed: only references inside the file are, and nothing is fetched.`);
  if (doc.unresolved.size > 0) notes.add('', `${doc.unresolved.size === 1 ? '1 reference points' : `${doc.unresolved.size} references point`} at nothing in the file (${[...doc.unresolved].slice(0, 3).join(', ')}${doc.unresolved.size > 3 ? ', ...' : ''}).`);
  if (security.vars.length > 0) notes.add('', `The credentials are variables of the collection (${security.vars.map(item => item.name).slice(0, 6).join(', ')}) with no value: fill them in; the values are kept in a file that Git ignores.`);

  const imported: Imported = { collections: operations === 0 && collection.folders.length === 0 ? [] : [collection], environments: environments(doc, version, notes), notes: [], skipped: 0 };
  imported.notes = notes.done();
  return { ok: true, imported };
}
