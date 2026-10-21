import { createHash, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Auth } from '../../src/core/model';
import { resolveText, type Scope } from '../../src/core/vars';
import { startLoopback } from '../../src/engine/loopback';
import {
  authorizationUrl, base64Url, clientCredentialsRequest, codeRequest, endpointProblem, isUsable, parseTokenResponse, passwordRequest, pkcePair, refreshRequest, type OAuthConfig, type TokenSet
} from '../../src/engine/oauth';
import type { ProxyConfig } from '../../src/engine/proxy';
import { send, type SendOptions } from '../../src/engine/send';
import { EngineError, type WireRequest } from '../../src/engine/types';
import { printable } from '../../src/util/chars';
import { realClock } from './clientWorkspace';

/**
 * Getting an access token for a request that has OAuth 2.0 authentication, and keeping it. The token lives in the secret storage of VS
 * Code, on this computer, never in a file of the collection, under a key made of what the token is for (the collection, the grant, the
 * token URL, the client, the scope), so that changing any of them asks for a new one. A request that needs a token gets, in order: the one
 * that is kept, if it is still good; a refreshed one; a new one (client credentials and password need nothing from the person; the
 * authorization code grant opens the browser and waits on this computer for the answer).
 *
 * The address of the token server comes from the collection, which can come from somebody else, and the client secret goes there: so the
 * first time a collection is to send credentials to a server, or to open a sign-in page, the person is asked, and the answer is kept for
 * that server in that collection.
 */
const TOKEN_PREFIX = 'apiClient.oauth.';
const HOSTS_KEY = 'apiClient.oauthHosts';
const KEYS_KEY = 'apiClient.oauthKeys';
const TOKEN_TIMEOUT_MS = 30_000;
const ALLOW = 'Allow';

export type OAuthOutcome =
  | { kind: 'token'; token: { accessToken: string; tokenType: string }; fresh: boolean }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string; hint: string };

export interface TokenRequestInput {
  /** The folder of the collection, for the key and for what was confirmed. */
  collection: string;
  /** The authentication that applies to the request; anything but OAuth 2.0 gives no outcome. */
  auth: Auth;
  /** The variables of the request, to replace in the settings of the authentication. */
  scopes: readonly Scope[];
  signal: AbortSignal;
  proxy: ProxyConfig;
  tls: SendOptions['tls'];
}

export interface OAuthStatus {
  state: 'none' | 'valid' | 'expired';
  /** Seconds until the token stops working, when it has an end and has not. */
  expiresInSeconds?: number;
  scope?: string;
}

export type HostAnswer = 'allow' | 'refuse';

export class OAuthService {
  /** Set by the tests of the extension to answer the question about a server, and to stand for the browser. */
  answer: ((question: { host: string; what: string }) => Promise<HostAnswer>) | undefined;
  /** Set by the tests of the extension: instead of opening the browser, gets the address that it would have opened. */
  openBrowser: ((address: string) => Promise<void>) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ---- what the settings say ----

  /** The settings of the authentication with the variables replaced, or what is missing. */
  private resolve(auth: Extract<Auth, { kind: 'oauth2' }>, scopes: readonly Scope[]): { config: OAuthConfig } | { problem: string } {
    const missing = new Set<string>();
    const put = (text: string): string => { const resolved = resolveText(text, scopes, { clock: realClock }); for (const name of resolved.unresolved) missing.add(name); return resolved.text.trim(); };
    const config: OAuthConfig = {
      grant: auth.grant, pkce: auth.pkce, authUrl: put(auth.authUrl), tokenUrl: put(auth.tokenUrl), clientId: put(auth.clientId), clientSecret: put(auth.clientSecret), scope: put(auth.scope), audience: put(auth.audience),
      username: put(auth.username), password: put(auth.password), redirectUrl: put(auth.redirectUrl), clientAuth: auth.clientAuth,
      extra: auth.extra.filter(row => row.enabled && row.name !== '').map((row): [string, string] => [put(row.name), put(row.value)])
    };
    if (missing.size > 0) return { problem: `These variables of the OAuth 2.0 settings have no value: ${[...missing].join(', ')}.` };
    if (config.tokenUrl === '') return { problem: 'The token URL of the OAuth 2.0 settings is empty.' };
    if (config.grant === 'authorization_code' && config.authUrl === '') return { problem: 'The authorization URL of the OAuth 2.0 settings is empty.' };
    if (config.grant === 'password' && config.username === '') return { problem: 'The username of the OAuth 2.0 settings is empty.' };
    return { config };
  }

  private keyOf(collection: string, config: OAuthConfig): string {
    // The secrets are not part of the key: it is what the token is for.
    const digest = createHash('sha256').update(JSON.stringify([collection, config.grant, config.tokenUrl, config.clientId, config.scope, config.audience, config.grant === 'password' ? config.username : ''])).digest('hex');
    return `${TOKEN_PREFIX}${digest.slice(0, 40)}`;
  }

  private async read(key: string): Promise<TokenSet | undefined> {
    const kept = await this.context.secrets.get(key);
    if (kept === undefined) return undefined;
    try {
      const raw = JSON.parse(kept) as Record<string, unknown>;
      const token: TokenSet = { accessToken: String(raw['accessToken']), tokenType: String(raw['tokenType'] ?? 'Bearer') };
      if (typeof raw['refreshToken'] === 'string') token.refreshToken = raw['refreshToken'];
      if (typeof raw['expiresAt'] === 'number') token.expiresAt = raw['expiresAt'];
      if (typeof raw['scope'] === 'string') token.scope = raw['scope'];
      return typeof raw['accessToken'] === 'string' && raw['accessToken'] !== '' ? token : undefined;
    } catch { return undefined; }
  }

  // ---- the servers that credentials may be sent to ----

  private confirmedHosts(): Record<string, string[]> {
    const kept = this.context.globalState.get<unknown>(HOSTS_KEY);
    return typeof kept === 'object' && kept !== null && !Array.isArray(kept) ? (kept as Record<string, string[]>) : {};
  }

  /** Whether the person agreed that this collection sends credentials to (or sends the person to) this server; asks when it has not been agreed. */
  private async allowed(collection: string, addresses: readonly string[], what: string): Promise<boolean> {
    const hosts = [...new Set(addresses.filter(address => address !== '').map(address => new URL(address).host))];
    const known = this.confirmedHosts();
    const have = Object.hasOwn(known, collection) && Array.isArray(known[collection]) ? known[collection] : [];
    const unknown = hosts.filter(host => !have.includes(host));
    if (unknown.length === 0) return true;
    for (const host of unknown) {
      const answer = this.answer !== undefined
        ? await this.answer({ host, what })
        : ((await vscode.window.showWarningMessage(`This collection wants to ${what} ${printable(host)}.`, { modal: true, detail: `Allow it only if you know this server and trust the collection: ${what === 'sign in at' ? 'the browser will open its page' : 'the client ID and the client secret, or the username and password, of this collection will be sent to it'}.` }, ALLOW)) === ALLOW ? 'allow' : 'refuse');
      if (answer !== 'allow') return false;
    }
    await this.context.globalState.update(HOSTS_KEY, { ...known, [collection]: [...have, ...unknown] });
    return true;
  }

  // ---- asking the server ----

  private async ask(wire: WireRequest, input: TokenRequestInput, previous?: TokenSet): Promise<{ ok: true; token: TokenSet } | { ok: false; error: string }> {
    try {
      const response = await send(wire, { timeoutMs: TOKEN_TIMEOUT_MS, followRedirects: false, maxRedirects: 0, tls: input.tls, responseLimitBytes: 1024 * 1024, proxy: input.proxy, signal: input.signal });
      const bytes = response.body.kind === 'memory' ? response.body.bytes : new Uint8Array(0);
      return parseTokenResponse(response.status, new TextDecoder('utf-8').decode(bytes), Date.now(), previous);
    } catch (error) {
      if (error instanceof EngineError && error.code === 'aborted') throw error;
      return { ok: false, error: `The token server could not be reached: ${printable(error instanceof Error ? error.message : 'the request failed')}` };
    }
  }

  /** The access token for a request: kept, refreshed or new. */
  async token(input: TokenRequestInput): Promise<OAuthOutcome> {
    if (input.auth.kind !== 'oauth2') return { kind: 'failed', message: 'This request does not use OAuth 2.0.', hint: '' };
    const resolved = this.resolve(input.auth, input.scopes);
    if ('problem' in resolved) return { kind: 'failed', message: resolved.problem, hint: 'Set the variables in the environment, or write the values in the Auth tab.' };
    const { config } = resolved;
    const problem = endpointProblem(config.tokenUrl, 'The token URL') ?? (config.grant === 'authorization_code' ? endpointProblem(config.authUrl, 'The authorization URL') : undefined);
    if (problem !== undefined) return { kind: 'failed', message: problem, hint: 'Change the address in the Auth tab.' };
    const key = this.keyOf(input.collection, config);
    try {
      const kept = await this.read(key);
      if (kept !== undefined && isUsable(kept, Date.now())) return { kind: 'token', token: kept, fresh: false };
      if (!await this.allowed(input.collection, [config.tokenUrl, config.grant === 'authorization_code' ? config.authUrl : ''], config.grant === 'authorization_code' ? 'sign in at' : 'send its credentials to')) {
        return { kind: 'failed', message: 'The server was not allowed, so no token was asked for.', hint: 'Send the request again and allow the server, or change the address in the Auth tab.' };
      }
      if (kept?.refreshToken !== undefined) {
        const refreshed = await this.ask(refreshRequest(config, kept.refreshToken), input, kept);
        if (refreshed.ok) { await this.keep(key, refreshed.token); return { kind: 'token', token: refreshed.token, fresh: true }; }
        await this.context.secrets.delete(key);
      }
      const obtained = config.grant === 'client_credentials' ? await this.ask(clientCredentialsRequest(config), input)
        : config.grant === 'password' ? await this.ask(passwordRequest(config), input)
        : await this.signIn(config, input);
      if (!obtained.ok) return { kind: 'failed', message: obtained.error, hint: 'Check the settings in the Auth tab.' };
      await this.keep(key, obtained.token);
      return { kind: 'token', token: obtained.token, fresh: true };
    } catch (error) {
      if (input.signal.aborted || (error instanceof EngineError && error.code === 'aborted')) return { kind: 'cancelled' };
      return { kind: 'failed', message: printable(error instanceof Error ? error.message : 'Getting the token failed.'), hint: '' };
    }
  }

  private async keep(key: string, token: TokenSet): Promise<void> {
    await this.context.secrets.store(key, JSON.stringify(token));
    // The secret storage cannot be listed, so the keys that were used are written down (the keys only, never a token).
    const known = this.context.globalState.get<string[]>(KEYS_KEY, []);
    if (!known.includes(key)) await this.context.globalState.update(KEYS_KEY, [...known, key].slice(-200));
  }

  /** The authorization code grant: the browser, the answer on this computer, and the exchange of the code. */
  private async signIn(config: OAuthConfig, input: TokenRequestInput): Promise<{ ok: true; token: TokenSet } | { ok: false; error: string }> {
    const pkce = config.pkce ? pkcePair(randomBytes(32)) : undefined;
    const state = base64Url(randomBytes(16));
    const loopback = await startLoopback({ state, signal: input.signal, ...(config.redirectUrl === '' ? {} : { redirectUrl: config.redirectUrl }) });
    try {
      const address = authorizationUrl(config, { redirectUri: loopback.redirectUri, state, ...(pkce === undefined ? {} : { challenge: pkce.challenge }) });
      if (this.openBrowser !== undefined) await this.openBrowser(address);
      else if (!await vscode.env.openExternal(vscode.Uri.parse(address))) return { ok: false, error: 'The browser could not be opened.' };
      void vscode.window.setStatusBarMessage('API Client: waiting for you to sign in, in the browser...', 60_000);
      const answer = await loopback.result;
      if (input.signal.aborted) throw new EngineError('aborted', 'cancelled', '');
      if (!answer.ok) return { ok: false, error: answer.error };
      return await this.ask(codeRequest(config, answer.code, loopback.redirectUri, pkce?.verifier), input);
    } finally {
      loopback.close();
    }
  }

  // ---- what the page shows ----

  async status(input: Pick<TokenRequestInput, 'collection' | 'auth' | 'scopes'>): Promise<OAuthStatus> {
    if (input.auth.kind !== 'oauth2') return { state: 'none' };
    const resolved = this.resolve(input.auth, input.scopes);
    if ('problem' in resolved) return { state: 'none' };
    const kept = await this.read(this.keyOf(input.collection, resolved.config));
    if (kept === undefined) return { state: 'none' };
    const usable = isUsable(kept, Date.now());
    return { state: usable ? 'valid' : 'expired', ...(kept.expiresAt === undefined || !usable ? {} : { expiresInSeconds: Math.max(0, Math.round((kept.expiresAt - Date.now()) / 1000)) }), ...(kept.scope === undefined ? {} : { scope: kept.scope }) };
  }

  async forget(input: Pick<TokenRequestInput, 'collection' | 'auth' | 'scopes'>): Promise<void> {
    if (input.auth.kind !== 'oauth2') return;
    const resolved = this.resolve(input.auth, input.scopes);
    if (!('problem' in resolved)) await this.context.secrets.delete(this.keyOf(input.collection, resolved.config));
  }

  /** Forgets every token and every server that was allowed. */
  async forgetAll(): Promise<void> {
    await this.context.globalState.update(HOSTS_KEY, undefined);
    for (const key of this.context.globalState.get<string[]>(KEYS_KEY, [])) await this.context.secrets.delete(key);
    await this.context.globalState.update(KEYS_KEY, undefined);
  }
}
