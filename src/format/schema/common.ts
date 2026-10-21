import type { Assertion, Auth, Body, Capture, HttpVersion, KV, OAuthGrant, Part, Scripts, SettingsOverride, Var } from '../../core/model';
import type { YMap } from '../yaml';
import { Out, type Fields, type Reader } from './read';

/**
 * The parts that requests, folders and collections share. Each `decode*` reads a part from a mapping and each `encode*` writes
 * it back in the one order of the file format, leaving out what has its default value.
 */

// ---- rows ----

export function decodeKV(fields: Fields): KV {
  return { name: fields.str('name'), value: fields.str('value'), enabled: fields.bool('enabled', true), description: fields.str('description') };
}

export function encodeKV(row: KV): YMap {
  return new Out().put('name', row.name).put('value', row.value).bool('enabled', row.enabled, true).text('description', row.description).map;
}

export function decodeVar(fields: Fields): Var {
  return { name: fields.str('name'), value: fields.str('value'), secret: fields.bool('secret', false), enabled: fields.bool('enabled', true) };
}

export function encodeVar(variable: Var): YMap {
  return new Out().put('name', variable.name).put('value', variable.value).bool('secret', variable.secret, false).bool('enabled', variable.enabled, true).map;
}

// ---- authentication ----

const GRANTS: readonly OAuthGrant[] = ['authorization_code', 'client_credentials', 'password'];
const AUTH_KINDS = ['inherit', 'none', 'bearer', 'basic', 'apikey', 'oauth2'] as const;

export function decodeAuth(parent: Fields, key: string): Auth {
  const fields = parent.child(key);
  if (fields === undefined) return { kind: 'inherit' };
  const kind = fields.oneOf('kind', AUTH_KINDS, 'inherit');
  let auth: Auth;
  switch (kind) {
    case 'bearer': auth = { kind, token: fields.str('token'), prefix: fields.str('prefix', 'Bearer') }; break;
    case 'basic': auth = { kind, username: fields.str('username'), password: fields.str('password') }; break;
    case 'apikey': auth = { kind, name: fields.str('name'), value: fields.str('value'), in: fields.oneOf('in', ['header', 'query'] as const, 'header') }; break;
    case 'oauth2':
      auth = {
        kind, grant: fields.oneOf('grant', GRANTS, 'authorization_code'), pkce: fields.bool('pkce', true), authUrl: fields.str('authUrl'), tokenUrl: fields.str('tokenUrl'),
        clientId: fields.str('clientId'), clientSecret: fields.str('clientSecret'), scope: fields.str('scope'), audience: fields.str('audience'), username: fields.str('username'),
        password: fields.str('password'), redirectUrl: fields.str('redirectUrl'), clientAuth: fields.oneOf('clientAuth', ['header', 'body'] as const, 'header'), extra: fields.list('extra', decodeKV)
      };
      break;
    default: auth = { kind };
  }
  fields.finish();
  return auth;
}

/** The mapping of an authentication, or an empty one for the default (inherit). */
export function encodeAuth(auth: Auth): YMap {
  const out = new Out();
  if (auth.kind === 'inherit') return out.map;
  out.put('kind', auth.kind);
  switch (auth.kind) {
    case 'bearer': out.put('token', auth.token).text('prefix', auth.prefix, 'Bearer'); break;
    case 'basic': out.put('username', auth.username).put('password', auth.password); break;
    case 'apikey': out.put('name', auth.name).put('value', auth.value).text('in', auth.in, 'header'); break;
    case 'oauth2':
      out.put('grant', auth.grant).bool('pkce', auth.pkce, true).text('authUrl', auth.authUrl).text('tokenUrl', auth.tokenUrl).text('clientId', auth.clientId)
        .text('clientSecret', auth.clientSecret).text('scope', auth.scope).text('audience', auth.audience).text('username', auth.username).text('password', auth.password)
        .text('redirectUrl', auth.redirectUrl).text('clientAuth', auth.clientAuth, 'header').list('extra', auth.extra.map(encodeKV));
      break;
    default: break;
  }
  return out.map;
}

// ---- body ----

function decodePart(fields: Fields): Part {
  return {
    name: fields.str('name'), kind: fields.oneOf('kind', ['text', 'file'] as const, 'text'), value: fields.str('value'), file: fields.str('file'),
    contentType: fields.str('contentType'), enabled: fields.bool('enabled', true)
  };
}

const encodePart = (part: Part): YMap =>
  new Out().put('name', part.name).text('kind', part.kind, 'text').text('value', part.value).text('file', part.file).text('contentType', part.contentType).bool('enabled', part.enabled, true).map;

const BODY_KINDS = ['none', 'text', 'json', 'xml', 'form', 'multipart', 'graphql', 'binary'] as const;

export function decodeBody(parent: Fields, key: string): Body {
  const fields = parent.child(key);
  if (fields === undefined) return { kind: 'none' };
  const kind = fields.oneOf('kind', BODY_KINDS, 'none');
  let body: Body;
  switch (kind) {
    case 'text': body = { kind, contentType: fields.str('contentType', 'text/plain'), text: fields.str('text') }; break;
    case 'json':
    case 'xml': body = { kind, text: fields.str('text') }; break;
    case 'form': body = { kind, fields: fields.list('fields', decodeKV) }; break;
    case 'multipart': body = { kind, parts: fields.list('parts', decodePart) }; break;
    case 'graphql': body = { kind, query: fields.str('query'), variables: fields.str('variables') }; break;
    case 'binary': body = { kind, file: fields.str('file') }; break;
    default: body = { kind };
  }
  fields.finish();
  return body;
}

export function encodeBody(body: Body): YMap {
  const out = new Out();
  if (body.kind === 'none') return out.map;
  out.put('kind', body.kind);
  switch (body.kind) {
    case 'text': out.text('contentType', body.contentType, 'text/plain').put('text', body.text); break;
    case 'json':
    case 'xml': out.put('text', body.text); break;
    case 'form': out.list('fields', body.fields.map(encodeKV)); break;
    case 'multipart': out.list('parts', body.parts.map(encodePart)); break;
    case 'graphql': out.put('query', body.query).text('variables', body.variables); break;
    case 'binary': out.put('file', body.file); break;
    default: break;
  }
  return out.map;
}

// ---- scripts, assertions, captures ----

export function decodeScripts(parent: Fields, key: string): Scripts {
  const fields = parent.child(key);
  if (fields === undefined) return { pre: '', post: '' };
  const scripts = { pre: fields.str('pre'), post: fields.str('post') };
  fields.finish();
  return scripts;
}

export const encodeScripts = (scripts: Scripts): YMap => new Out().text('pre', scripts.pre).text('post', scripts.post).map;

export const decodeAssertion = (fields: Fields): Assertion | Capture => ({ expr: fields.str('expr'), enabled: fields.bool('enabled', true) });
export const encodeAssertion = (line: Assertion | Capture): YMap => new Out().put('expr', line.expr).bool('enabled', line.enabled, true).map;

// ---- settings ----

const VERSIONS: readonly HttpVersion[] = ['1.1', '2', 'auto'];

export function decodeSettings(parent: Fields, key: string): SettingsOverride {
  const fields = parent.child(key);
  if (fields === undefined) return {};
  const settings: SettingsOverride = {};
  const timeoutMs = fields.optionalInt('timeoutMs', 1, 3_600_000);
  if (timeoutMs !== undefined) settings.timeoutMs = timeoutMs;
  const followRedirects = fields.optionalBool('followRedirects');
  if (followRedirects !== undefined) settings.followRedirects = followRedirects;
  const maxRedirects = fields.optionalInt('maxRedirects', 0, 50);
  if (maxRedirects !== undefined) settings.maxRedirects = maxRedirects;
  const rejectUnauthorized = fields.optionalBool('rejectUnauthorized');
  if (rejectUnauthorized !== undefined) settings.rejectUnauthorized = rejectUnauthorized;
  const httpVersion = fields.optionalOneOf('httpVersion', VERSIONS);
  if (httpVersion !== undefined) settings.httpVersion = httpVersion;
  const responseLimitBytes = fields.optionalInt('responseLimitBytes', 1024, 1024 * 1024 * 1024);
  if (responseLimitBytes !== undefined) settings.responseLimitBytes = responseLimitBytes;
  const encodeUrl = fields.optionalBool('encodeUrl');
  if (encodeUrl !== undefined) settings.encodeUrl = encodeUrl;
  const cookies = fields.optionalBool('cookies');
  if (cookies !== undefined) settings.cookies = cookies;
  fields.finish();
  return settings;
}

export function encodeSettings(settings: SettingsOverride): YMap {
  const out = new Out();
  const flag = (key: string, value: boolean | undefined): void => {
    if (value === undefined) return;
    if (typeof value !== 'boolean') throw new TypeError(`${key} must be true or false`);
    out.put(key, value ? 'true' : 'false');
  };
  out.int('timeoutMs', settings.timeoutMs);
  flag('followRedirects', settings.followRedirects);
  out.int('maxRedirects', settings.maxRedirects);
  flag('rejectUnauthorized', settings.rejectUnauthorized);
  if (settings.httpVersion !== undefined) out.put('httpVersion', settings.httpVersion);
  out.int('responseLimitBytes', settings.responseLimitBytes);
  flag('encodeUrl', settings.encodeUrl);
  flag('cookies', settings.cookies);
  return out.map;
}

export type { Reader };
