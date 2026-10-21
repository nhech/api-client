import { createHash } from 'node:crypto';
import { printable } from '../util/chars';
import { formEncode } from './build';
import type { WireRequest } from './types';

/**
 * OAuth 2.0, the requests and the reading of the answers (RFC 6749, with PKCE of RFC 7636): the authorization URL, the request to the token
 * endpoint for each grant (authorization code, client credentials, password) and for a refresh, and the token that comes back. Nothing here
 * sends anything or keeps anything: the extension sends these requests through the engine and keeps the token in the secret storage of VS Code.
 *
 * What the server answers is read as data: the token is picked out of the JSON field by field, and a refusal is said with the `error` word
 * and a short description, never with the body, which may hold a token.
 */
export type OAuthGrantKind = 'authorization_code' | 'client_credentials' | 'password';

/** The settings of an OAuth 2.0 authentication with the variables already replaced. */
export interface OAuthConfig {
  grant: OAuthGrantKind;
  pkce: boolean;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  audience: string;
  username: string;
  password: string;
  redirectUrl: string;
  /** Where the client credentials go: in an Authorization header (the default of the RFC) or in the body. */
  clientAuth: 'header' | 'body';
  extra: [string, string][];
}

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  /** When the access token stops working, in milliseconds since 1970; absent when the server did not say. */
  expiresAt?: number;
  scope?: string;
}

/** A token is renewed this long before it runs out, so that it does not expire on the way. */
export const EXPIRY_SKEW_MS = 30_000;
const MAX_LIFETIME_SECONDS = 365 * 24 * 3600;
const MAX_FIELD_CHARS = 16 * 1024;

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const base64Url = (bytes: Uint8Array): string => base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/** Why an address cannot be used to send credentials to, or undefined when it can: it has to be https, except on this computer. */
export function endpointProblem(address: string, what: string): string | undefined {
  let url: URL;
  try { url = new URL(address); } catch { return `${what} is not a whole address`; }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return undefined;
  return `${what} has to start with https:// (http:// only for this computer), so that the credentials are not sent in the clear`;
}

// ---- PKCE ----

/** A code verifier of 43 characters from 32 random bytes, and its S256 challenge. */
export function pkcePair(random: Uint8Array): { verifier: string; challenge: string } {
  const verifier = base64Url(random);
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier, 'utf8').digest()) };
}

// ---- the authorization request ----

export interface AuthorizationParts {
  redirectUri: string;
  state: string;
  /** The S256 challenge, when PKCE is on. */
  challenge?: string;
}

/** The address the person is sent to to sign in. The parameters are added to the ones the address has already. */
export function authorizationUrl(config: OAuthConfig, parts: AuthorizationParts): string {
  const url = new URL(config.authUrl);
  const set = (name: string, value: string): void => { if (value !== '') url.searchParams.set(name, value); };
  set('response_type', 'code');
  set('client_id', config.clientId);
  set('redirect_uri', parts.redirectUri);
  set('scope', config.scope);
  set('state', parts.state);
  set('audience', config.audience);
  if (parts.challenge !== undefined) { set('code_challenge', parts.challenge); set('code_challenge_method', 'S256'); }
  for (const [name, value] of config.extra) if (name !== '') url.searchParams.set(name, value);
  return url.toString();
}

// ---- the requests to the token endpoint ----

function tokenRequest(config: OAuthConfig, grant: readonly (readonly [string, string])[], options: { scope: boolean } = { scope: true }): WireRequest {
  const pairs: [string, string][] = grant.map(([name, value]) => [name, value]);
  if (options.scope && config.scope !== '') pairs.push(['scope', config.scope]);
  if (config.audience !== '') pairs.push(['audience', config.audience]);
  for (const [name, value] of config.extra) if (name !== '') pairs.push([name, value]);
  const headers: WireRequest['headers'] = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']];
  if (config.clientId !== '') {
    // A client with no secret is a public one: it says who it is in the body, and has nothing to authenticate with.
    if (config.clientAuth === 'header' && config.clientSecret !== '') headers.push(['Authorization', `Basic ${base64(encoder.encode(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`))}`]);
    else { pairs.push(['client_id', config.clientId]); if (config.clientSecret !== '') pairs.push(['client_secret', config.clientSecret]); }
  }
  return { method: 'POST', url: config.tokenUrl, headers, body: { kind: 'bytes', bytes: encoder.encode(pairs.map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`).join('&')) } };
}

export const clientCredentialsRequest = (config: OAuthConfig): WireRequest => tokenRequest(config, [['grant_type', 'client_credentials']]);
export const passwordRequest = (config: OAuthConfig): WireRequest => tokenRequest(config, [['grant_type', 'password'], ['username', config.username], ['password', config.password]]);
/** A refresh does not ask for a scope again: the server keeps the one of the first grant. */
export const refreshRequest = (config: OAuthConfig, refreshToken: string): WireRequest => tokenRequest(config, [['grant_type', 'refresh_token'], ['refresh_token', refreshToken]], { scope: false });
export function codeRequest(config: OAuthConfig, code: string, redirectUri: string, verifier?: string): WireRequest {
  const grant: [string, string][] = [['grant_type', 'authorization_code'], ['code', code], ['redirect_uri', redirectUri]];
  if (verifier !== undefined) grant.push(['code_verifier', verifier]);
  return tokenRequest(config, grant, { scope: false });
}

// ---- the answer ----

export type TokenResult = { ok: true; token: TokenSet } | { ok: false; error: string };

const text = (value: unknown, limit = MAX_FIELD_CHARS): string | undefined => (typeof value === 'string' && value !== '' && value.length <= limit ? value : undefined);

/** Reads the answer of the token endpoint. `previous` supplies the refresh token that a server leaves out of the answer to a refresh. */
export function parseTokenResponse(status: number, body: string, now: number, previous?: TokenSet): TokenResult {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return { ok: false, error: `The token endpoint did not answer with JSON (status ${status}).` }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: `The token endpoint did not answer with an object (status ${status}).` };
  const field = (name: string): unknown => (Object.hasOwn(raw as object, name) ? (raw as Record<string, unknown>)[name] : undefined);
  const refused = text(field('error'), 100);
  if (refused !== undefined || status < 200 || status >= 300) {
    const why = text(field('error_description'), 200);
    return { ok: false, error: `The server refused the request${refused === undefined ? ` (status ${status})` : `: ${printable(refused)}`}${why === undefined ? '' : ` (${printable(why)})`}.` };
  }
  const accessToken = text(field('access_token'));
  if (accessToken === undefined) return { ok: false, error: 'The answer of the server has no access token.' };
  const given = field('token_type');
  const tokenType = typeof given === 'string' && /^[A-Za-z][A-Za-z0-9._~+/-]{0,40}$/.test(given) ? (given.toLowerCase() === 'bearer' ? 'Bearer' : given) : 'Bearer';
  const lifetime = Number(field('expires_in'));
  const token: TokenSet = { accessToken, tokenType };
  const refreshToken = text(field('refresh_token')) ?? previous?.refreshToken;
  if (refreshToken !== undefined) token.refreshToken = refreshToken;
  if (Number.isFinite(lifetime) && lifetime > 0) token.expiresAt = now + Math.min(lifetime, MAX_LIFETIME_SECONDS) * 1000;
  const scope = text(field('scope'), 1000);
  if (scope !== undefined) token.scope = scope;
  return { ok: true, token };
}

/** Whether the access token can still be sent: it has no end, or the end is not near. */
export const isUsable = (token: TokenSet, now: number): boolean => token.expiresAt === undefined || token.expiresAt - EXPIRY_SKEW_MS > now;
