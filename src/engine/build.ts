import type { Clock } from '../core/clock';
import type { EffectiveRequest } from '../core/inherit';
import type { KV, Request } from '../core/model';
import { basicCredential, MIN_SECRET_LENGTH } from '../core/redact';
import { resolveText, type ResolveOptions, type Scope } from '../core/vars';
import type { HeaderList, MultipartPart, WireBody, WireRequest } from './types';

/**
 * Turns a request of the model into what goes over the wire: the variables are replaced, the parameters are put into the
 * address, the authentication becomes a header or a parameter, and the body becomes bytes, a file or a multipart. The result
 * also says which variables had no value, and which secret values went in, so that the caller can warn before sending and
 * can hide those values from everything it writes down afterwards.
 */
export interface BuildInput {
  request: Request;
  effective: EffectiveRequest;
  scopes: readonly Scope[];
  clock: Clock;
  /** Maps a path written in the request (relative to its collection) to an absolute path the engine may open, or undefined when it is not allowed (outside the collection, a link, or files are switched off). */
  resolveFile: (relative: string) => string | undefined;
  /** The access token of an OAuth2 authentication that has been obtained already. */
  oauthToken?: { accessToken: string; tokenType: string };
}

export interface Built {
  wire: WireRequest;
  unresolved: string[];
  cycles: string[];
  /** Names of the secret variables whose values went into the request. */
  secrets: string[];
  /** Values to hide in anything written down about this request: the values of those variables and the credentials that were typed in. */
  redactions: string[];
  /** Why the request cannot be sent as it is (a file that is not allowed, GraphQL variables that are not JSON). */
  problems: string[];
  warnings: string[];
}

const encoder = new TextEncoder();
const hasHeader = (headers: HeaderList, name: string): boolean => headers.some(([key]) => key.toLowerCase() === name);

/** application/x-www-form-urlencoded: everything but letters, digits and `*-._` is a percent escape, and a space is a plus. */
export const formEncode = (value: string): string => encodeURIComponent(value).replace(/%20/g, '+').replace(/[!'()~]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

export function buildWire(input: BuildInput): Built {
  const { request, effective, scopes, clock } = input;
  const unresolved: string[] = [];
  const cycles: string[] = [];
  const secrets: string[] = [];
  const redactions = new Set<string>();
  const problems: string[] = [];
  const warnings: string[] = [];
  const note = (list: string[], names: readonly string[]): void => { for (const name of names) if (!list.includes(name)) list.push(name); };
  const options: ResolveOptions = { clock };

  const resolve = (text: string): string => {
    const result = resolveText(text, scopes, options);
    note(unresolved, result.unresolved);
    note(cycles, result.cycles);
    note(secrets, result.secrets);
    if (result.truncated) note(problems, ['a value is too large or nested too deeply to be put together']);
    return result.text;
  };
  /** The value of a secret that the person typed into the request itself: it is not a variable, but it is a secret. */
  const typed = (text: string): string => {
    const value = resolve(text);
    if (value.length >= MIN_SECRET_LENGTH) redactions.add(value);
    return value;
  };
  const rows = (list: readonly KV[]): [string, string][] => list.filter(row => row.enabled && row.name !== '').map(row => [resolve(row.name), resolve(row.value)]);
  const encode = effective.settings.encodeUrl ? encodeURIComponent : (value: string): string => value;

  // ---- the address ----
  let url = resolve(effective.url).replace(/#.*$/s, '');
  const path = request.pathParams.filter(row => row.enabled && row.name !== '');
  if (path.length > 0) {
    const values = new Map(path.map(row => [resolve(row.name), resolve(row.value)]));
    const hook = url.indexOf('?');
    const head = (hook < 0 ? url : url.slice(0, hook)).replace(/\{([^{}/?#]+)\}/g, (whole, name: string) => (values.has(name) ? encodeURIComponent(values.get(name) as string) : whole));
    url = hook < 0 ? head : head + url.slice(hook);
  }
  const query = rows(request.query).map(([name, value]) => `${encode(name)}=${encode(value)}`);

  // ---- headers ----
  const headers: HeaderList = effective.headers.map(({ name, value }) => [resolve(name), resolve(value)] as [string, string]).filter(([name]) => name !== '');

  // ---- authentication ----
  const auth = effective.auth;
  const explicitAuthorization = hasHeader(headers, 'authorization');
  const authorize = (value: string): void => {
    if (explicitAuthorization) { warnings.push('The request has its own Authorization header, so the authentication was not added.'); return; }
    headers.push(['Authorization', value]);
  };
  if (auth.kind === 'bearer') {
    const token = typed(auth.token);
    if (token !== '') authorize(`${resolve(auth.prefix) || 'Bearer'} ${token}`);
  } else if (auth.kind === 'basic') {
    const user = resolve(auth.username);
    const password = typed(auth.password);
    const credential = basicCredential(user, password);
    redactions.add(credential);
    authorize(`Basic ${credential}`);
  } else if (auth.kind === 'apikey') {
    const name = resolve(auth.name);
    const value = typed(auth.value);
    if (name !== '') {
      if (auth.in === 'query') query.push(`${encode(name)}=${encode(value)}`);
      else headers.push([name, value]);
    }
  } else if (auth.kind === 'oauth2') {
    if (input.oauthToken !== undefined) {
      redactions.add(input.oauthToken.accessToken);
      authorize(`${input.oauthToken.tokenType === '' ? 'Bearer' : input.oauthToken.tokenType} ${input.oauthToken.accessToken}`);
    } else warnings.push('The authentication is OAuth 2.0 and no access token has been obtained yet.');
  }

  if (query.length > 0) url += `${url.includes('?') ? (/[?&]$/.test(url) ? '' : '&') : '?'}${query.join('&')}`;

  // ---- body ----
  let body: WireBody | undefined;
  let contentType: string | undefined;
  const spec = request.body;
  switch (spec.kind) {
    case 'text': body = { kind: 'bytes', bytes: encoder.encode(resolve(spec.text)) }; contentType = resolve(spec.contentType) || 'text/plain'; break;
    case 'json': body = { kind: 'bytes', bytes: encoder.encode(resolve(spec.text)) }; contentType = 'application/json'; break;
    case 'xml': body = { kind: 'bytes', bytes: encoder.encode(resolve(spec.text)) }; contentType = 'application/xml'; break;
    case 'form': body = { kind: 'bytes', bytes: encoder.encode(rows(spec.fields).map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`).join('&')) }; contentType = 'application/x-www-form-urlencoded'; break;
    case 'graphql': {
      const variablesText = resolve(spec.variables).trim();
      let variables: unknown;
      if (variablesText !== '') {
        try { variables = JSON.parse(variablesText); } catch { problems.push('The GraphQL variables are not valid JSON.'); }
      }
      body = { kind: 'bytes', bytes: encoder.encode(JSON.stringify(variables === undefined ? { query: resolve(spec.query) } : { query: resolve(spec.query), variables })) };
      contentType = 'application/json';
      break;
    }
    case 'binary': {
      const file = input.resolveFile(resolve(spec.file));
      if (file === undefined) problems.push(`The file ${spec.file} is not allowed or does not exist.`);
      else body = { kind: 'file', path: file };
      contentType = 'application/octet-stream';
      break;
    }
    case 'multipart': {
      const parts: MultipartPart[] = [];
      for (const part of spec.parts) {
        if (!part.enabled || part.name === '') continue;
        const name = resolve(part.name);
        if (part.kind === 'file') {
          const file = input.resolveFile(resolve(part.file));
          if (file === undefined) { problems.push(`The file ${part.file} is not allowed or does not exist.`); continue; }
          const filename = part.file.split(/[\\/]/).pop() ?? 'file';
          parts.push({ name, filePath: file, filename, ...(part.contentType === '' ? {} : { contentType: resolve(part.contentType) }) });
        } else parts.push({ name, value: resolve(part.value), ...(part.contentType === '' ? {} : { contentType: resolve(part.contentType) }) });
      }
      let boundary = '----api-client-';
      for (let index = 0; index < 24; index++) boundary += '0123456789abcdef'[Math.min(15, Math.floor(clock.random() * 16))];
      body = { kind: 'multipart', boundary, parts };
      contentType = `multipart/form-data; boundary=${boundary}`;
      break;
    }
    default: break;
  }
  if (contentType !== undefined) {
    if (spec.kind === 'multipart') {
      const existing = headers.findIndex(([name]) => name.toLowerCase() === 'content-type');
      if (existing >= 0) headers.splice(existing, 1);
      headers.push(['Content-Type', contentType]);
    } else if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', contentType]);
  }

  const wire: WireRequest = { method: request.method.toUpperCase(), url, headers };
  if (body !== undefined) wire.body = body;
  for (const name of secrets) for (const scope of scopes) { const value = scope.get(name); if (value !== undefined) { if (value.value.length >= MIN_SECRET_LENGTH) redactions.add(value.value); break; } }
  return { wire, unresolved, cycles, secrets, redactions: [...redactions], problems, warnings };
}
