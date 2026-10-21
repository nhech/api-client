import type { Settings } from '../core/model';
import { DEFAULT_DECODE_LIMITS, type DecodeLimits } from './decode';
import { resolveProxy, type ProxyConfig } from './proxy';
import { isLocalHost, isRedirectStatus, nextHop, type Hop, type RedirectPolicy } from './redirect';
import { exchange, type ExchangeOptions } from './transport';
import { EngineError, type HeaderList, type RedirectHop, type TlsOptions, type WireRequest, type WireResponse } from './types';

/** Where cookies are kept between requests. The engine asks it for the header of an address and gives it every Set-Cookie it sees. */
export interface CookieStore {
  header(url: URL): string | undefined;
  store(url: URL, setCookies: string[]): void;
}

export interface SendOptions {
  /** For the whole request, redirects included. */
  timeoutMs: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  followRedirects: boolean;
  maxRedirects: number;
  allowDowngrade?: boolean;
  allowLocalRedirect?: boolean;
  tls: TlsOptions;
  responseLimitBytes: number;
  spill?: ExchangeOptions['spill'];
  decode?: DecodeLimits;
  cookies?: CookieStore;
  /** Where the proxy is, for each address that is not in its no-proxy list. */
  proxy?: ProxyConfig;
  /** Adds User-Agent, Accept and Accept-Encoding when the request has none. On by default. */
  defaultHeaders?: boolean;
  userAgent?: string;
  signal?: AbortSignal;
  createConnection?: ExchangeOptions['createConnection'];
}

export const USER_AGENT = 'api-client/0.2';

/** The options that the settings decide. */
export function sendOptionsFrom(settings: Settings): Pick<SendOptions, 'timeoutMs' | 'followRedirects' | 'maxRedirects' | 'responseLimitBytes' | 'allowLocalRedirect'> & { tls: TlsOptions } {
  return {
    timeoutMs: settings.timeoutMs, followRedirects: settings.followRedirects, maxRedirects: settings.maxRedirects, responseLimitBytes: settings.responseLimitBytes, allowLocalRedirect: settings.allowPrivateRedirects,
    tls: { rejectUnauthorized: settings.rejectUnauthorized }
  };
}

const hasHeader = (headers: HeaderList, name: string): boolean => headers.some(([key]) => key.toLowerCase() === name);

function withDefaults(request: WireRequest, options: SendOptions): WireRequest {
  if (options.defaultHeaders === false) return request;
  const headers: HeaderList = [...request.headers];
  if (!hasHeader(headers, 'user-agent')) headers.push(['User-Agent', options.userAgent ?? USER_AGENT]);
  if (!hasHeader(headers, 'accept')) headers.push(['Accept', '*/*']);
  if (!hasHeader(headers, 'accept-encoding')) headers.push(['Accept-Encoding', 'gzip, deflate, br']);
  return { ...request, headers };
}

function withCookies(request: WireRequest, jar: CookieStore | undefined): WireRequest {
  if (jar === undefined) return request;
  let url: URL;
  try { url = new URL(request.url); } catch { return request; }
  const header = jar.header(url);
  if (header === undefined || header === '') return request;
  const own = request.headers.findIndex(([name]) => name.toLowerCase() === 'cookie');
  if (own < 0) return { ...request, headers: [...request.headers, ['Cookie', header]] };
  const headers: HeaderList = [...request.headers];
  headers[own] = ['Cookie', `${headers[own]?.[1] ?? ''}; ${header}`];
  return { ...request, headers };
}

const headerValue = (headers: HeaderList, name: string): string | undefined => headers.find(([key]) => key.toLowerCase() === name)?.[1];

/**
 * After a redirect from a public address to ANOTHER name, the address that the name resolves to is checked too (see lookup.ts), unless the person allowed
 * redirects to this machine. The same name again is the address the person already reached.
 */
function mustCheckAddress(redirects: readonly RedirectHop[], target: string, policy: RedirectPolicy): boolean {
  const from = redirects.at(-1)?.url;
  if (from === undefined || policy.allowLocal) return false;
  try {
    const before = new URL(from).hostname.toLowerCase();
    return before !== new URL(target).hostname.toLowerCase() && !isLocalHost(before);
  } catch { return false; }
}

export async function send(request: WireRequest, options: SendOptions): Promise<WireResponse> {
  const total = new AbortController();
  const timer = setTimeout(() => total.abort(new EngineError('timeout', `The request took longer than ${Math.round(options.timeoutMs / 1000)} s.`, 'Raise the timeout in the settings if the server is slow.')), options.timeoutMs);
  const signal = options.signal === undefined ? total.signal : AbortSignal.any([options.signal, total.signal]);
  const policy = { allowDowngrade: options.allowDowngrade ?? false, allowLocal: options.allowLocalRedirect ?? false };
  try {
    let current = withDefaults(request, options);
    const redirects: RedirectHop[] = [];
    for (;;) {
      const attempt = withCookies(current, options.cookies);
      // An address that is not valid is reported by the exchange itself, so the proxy is looked up only for one that is.
      const proxy = ((): ReturnType<typeof resolveProxy> => { try { return resolveProxy(new URL(attempt.url), options.proxy); } catch (error) { if (error instanceof EngineError) throw error; return undefined; } })();
      // What to do with a redirect, decided from the status line so that the body of a redirect that will be followed is not read.
      let decision: Hop | undefined;
      const decide = (status: number, headers: HeaderList): Hop | undefined => {
        if (!options.followRedirects || !isRedirectStatus(status)) return undefined;
        const location = headerValue(headers, 'location');
        return location === undefined ? undefined : nextHop(current, status, location, policy);
      };
      const result = await exchange(attempt, {
        signal, connectTimeoutMs: options.connectTimeoutMs ?? Math.min(options.timeoutMs, 30_000), idleTimeoutMs: options.idleTimeoutMs ?? options.timeoutMs,
        tls: options.tls, responseLimitBytes: options.responseLimitBytes, decode: options.decode ?? DEFAULT_DECODE_LIMITS,
        ...(options.spill === undefined ? {} : { spill: options.spill }), ...(options.createConnection === undefined ? {} : { createConnection: options.createConnection }),
        ...(proxy === undefined ? {} : { proxy }),
        ...(mustCheckAddress(redirects, attempt.url, policy) ? { refuseLocalAddresses: true } : {}),
        body: (status, headers) => { decision = decide(status, headers); return decision?.follow === true ? 'discard' : 'read'; }
      });
      if (options.cookies !== undefined) {
        const setCookies = result.headers.filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value);
        if (setCookies.length > 0) options.cookies.store(new URL(attempt.url), setCookies);
      }
      const hop = decision as Hop | undefined;
      if (hop === undefined) return { ...result, redirects, finalUrl: current.url, sent: attempt };
      if (!hop.follow) return { ...result, redirects, finalUrl: current.url, sent: attempt, warnings: [...result.warnings, `Not followed: ${hop.reason}.`] };
      if (redirects.length >= options.maxRedirects) throw new EngineError('too-many-redirects', `The server redirected more than ${options.maxRedirects} times.`, 'It may be a loop; raise the limit in the settings if it is not.');
      redirects.push({ url: current.url, status: result.status });
      current = hop.request;
    }
  } finally {
    clearTimeout(timer);
  }
}
