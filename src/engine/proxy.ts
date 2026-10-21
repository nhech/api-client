import http from 'node:http';
import type { Socket } from 'node:net';
import { basicCredential } from '../core/redact';
import { EngineError } from './types';

/**
 * Sending a request through an HTTP proxy. A request to an http address goes to the proxy with the whole address as its path;
 * a request to an https address asks the proxy for a tunnel (CONNECT) and the TLS handshake with the real server happens
 * inside it, so the proxy never sees the request. The credentials for the proxy go to the proxy only.
 */
export interface ProxyConfig {
  /** One proxy for every address (VS Code's `http.proxy`). */
  all?: string;
  /** Proxies by scheme, as in the HTTP_PROXY and HTTPS_PROXY variables; they win over `all`. */
  http?: string;
  https?: string;
  /** Hosts that are not sent through the proxy: names, `.suffix` or `*.suffix`, addresses, `host:port`, or `*`. */
  noProxy?: string;
  /** Send loopback addresses through the proxy too; by default they go direct. */
  proxyLoopback?: boolean;
}

export interface ResolvedProxy {
  host: string;
  port: number;
  /** `user:password`, from the proxy's address. */
  auth?: string;
}

/** The proxy settings in the environment: HTTP_PROXY, HTTPS_PROXY and NO_PROXY in either case. */
export function proxyConfigFromEnv(env: Readonly<Record<string, string | undefined>>): ProxyConfig {
  const pick = (...names: string[]): string | undefined => names.map(name => env[name]).find(value => value !== undefined && value !== '');
  const config: ProxyConfig = {};
  const http = pick('HTTP_PROXY', 'http_proxy');
  const https = pick('HTTPS_PROXY', 'https_proxy');
  const noProxy = pick('NO_PROXY', 'no_proxy');
  if (http !== undefined) config.http = http;
  if (https !== undefined) config.https = https;
  if (noProxy !== undefined) config.noProxy = noProxy;
  return config;
}

const isLoopback = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);

/** Whether the NO_PROXY list says to go direct to this host and port. */
export function bypassesProxy(host: string, port: string, noProxy: string | undefined): boolean {
  if (noProxy === undefined) return false;
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of noProxy.split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry === '*') return true;
    let entryPort = '';
    const portMatch = /^(.*):(\d{1,5})$/.exec(entry);
    if (portMatch !== null && !entry.includes('::') && !entry.startsWith('[')) { entry = portMatch[1] as string; entryPort = portMatch[2] as string; }
    if (entryPort !== '' && entryPort !== port) continue;
    entry = entry.replace(/^\*?\./, '.').replace(/^\[|\]$/g, '');
    if (entry.startsWith('.') ? name.endsWith(entry) || name === entry.slice(1) : name === entry || name.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** A proxy address such as `proxy.corp:8080`, `http://user:pass@proxy:3128`; an https proxy is refused. */
export function parseProxy(text: string): ResolvedProxy {
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`); } catch { throw new EngineError('proxy', `The proxy address ${text} is not valid.`, 'Write it as http://host:port.'); }
  if (url.protocol !== 'http:') throw new EngineError('proxy', `A proxy at ${url.protocol}// is not supported: only http proxies are.`, 'Use an http:// proxy address.');
  const resolved: ResolvedProxy = { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port === '' ? 80 : Number(url.port) };
  if (url.username !== '') resolved.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return resolved;
}

/** The proxy to use for an address, or undefined to go direct. */
export function resolveProxy(target: URL, config: ProxyConfig | undefined): ResolvedProxy | undefined {
  if (config === undefined) return undefined;
  const text = target.protocol === 'https:' ? (config.https ?? config.all) : (config.http ?? config.all);
  if (text === undefined || text === '') return undefined;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopback(host) && config.proxyLoopback !== true) return undefined;
  const port = target.port === '' ? (target.protocol === 'https:' ? '443' : '80') : target.port;
  if (bypassesProxy(host, port, config.noProxy)) return undefined;
  return parseProxy(text);
}

export const proxyAuthorization = (proxy: ResolvedProxy): string | undefined => {
  if (proxy.auth === undefined) return undefined;
  const at = proxy.auth.indexOf(':');
  return `Basic ${basicCredential(at < 0 ? proxy.auth : proxy.auth.slice(0, at), at < 0 ? '' : proxy.auth.slice(at + 1))}`;
};

/** A tunnel to `host:port` through the proxy, as a connected socket, or an EngineError that says what the proxy answered. */
export function openTunnel(proxy: ResolvedProxy, target: { host: string; port: number }, options: { signal: AbortSignal; timeoutMs: number }): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const authority = `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`;
    const headers: http.OutgoingHttpHeaders = { Host: authority };
    const credential = proxyAuthorization(proxy);
    if (credential !== undefined) headers['Proxy-Authorization'] = credential;
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority, headers, agent: false, signal: options.signal });
    const timer = setTimeout(() => req.destroy(new EngineError('timeout', `The proxy ${proxy.host}:${proxy.port} did not set up the tunnel within ${Math.round(options.timeoutMs / 1000)} s.`, 'Check the proxy address and your network.')), options.timeoutMs);
    req.once('connect', (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode === 200) { resolve(socket); return; }
      socket.destroy();
      const status = res.statusCode ?? 0;
      reject(new EngineError('proxy', status === 407 ? `The proxy ${proxy.host}:${proxy.port} asks for a user name and password.` : `The proxy ${proxy.host}:${proxy.port} refused the tunnel to ${authority} (${status} ${res.statusMessage ?? ''}).`.trim(),
        status === 407 ? 'Put the credentials in the proxy address: http://user:password@host:port.' : 'Check that the proxy allows this address and port.'));
    });
    req.once('error', error => {
      clearTimeout(timer);
      if (error instanceof EngineError) { reject(error); return; }
      if (options.signal.aborted) { reject(error); return; }
      const code = (error as NodeJS.ErrnoException).code ?? '';
      reject(new EngineError('proxy', `Could not reach the proxy ${proxy.host}:${proxy.port} (${code === '' ? error.message : code}).`, 'Check the proxy address, your network and the proxy settings.'));
    });
    req.end();
  });
}
