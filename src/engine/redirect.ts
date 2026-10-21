import { CREDENTIAL_HEADERS, isSecretName } from '../core/redact';
import type { HeaderList, WireRequest } from './types';

/**
 * What to do with a redirect. A redirect is chosen by the server, so it is where a request can be turned against the person:
 * the credentials they typed for one site must not go to another, a request over https must not slide down to http, and a
 * public address must not send a request to the person's own machine or network (loopback, 0.0.0.0, link-local addresses where the metadata services
 * of clouds are, private and shared ranges) unless the person allowed it in the settings of the request. Every rule here is pure and is tested without a network.
 */
export interface RedirectPolicy {
  /** Follow a redirect from https to http. */
  allowDowngrade: boolean;
  /** Follow a redirect from a public address to this machine or a private network (the setting `allowPrivateRedirects`). */
  allowLocal: boolean;
}

export type Hop = { follow: true; request: WireRequest } | { follow: false; reason: string };

export const isRedirectStatus = (status: number): boolean => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/** The scheme, host and port of an address: what makes two addresses the same site for the purpose of credentials. */
export const originOf = (url: URL): string => `${url.protocol}//${url.host}`;

/** Whether the first two octets of an IPv4 address are in a range that is not public: loopback, unspecified, link-local, private (RFC 1918) or shared (CGNAT, 100.64/10). */
const isNonPublicV4 = (a: number, b: number): boolean => a === 127 || a === 0 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);

/**
 * Hosts that are this machine or its network and not the internet: loopback (127/8, ::1, localhost), unspecified (0.0.0.0/8 and :: reach this machine), link-local
 * (169.254/16, fe80::/10, where the metadata services of clouds are), private (10/8, 172.16/12, 192.168/16, fc00::/7) and shared (100.64/10) addresses.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4 !== null) return isNonPublicV4(Number(v4[1]), Number(v4[2]));
  const mapped = /^::ffff:(?:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
  if (mapped !== null) {
    if (mapped[1] !== undefined) return isNonPublicV4(Number(mapped[1]), Number(mapped[2]));
    const high = parseInt(mapped[3] ?? '0', 16);
    return isNonPublicV4(high >> 8, high & 0xff);
  }
  return /^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host);
}

/** Entity headers that describe a body that is no longer sent. */
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location', 'content-length'];

function without(headers: HeaderList, names: ReadonlySet<string>, secretNames: boolean): HeaderList {
  return headers.filter(([name]) => !names.has(name.toLowerCase()) && !(secretNames && isSecretName(name)));
}

/**
 * The request to send after a redirect response, or the reason it is not followed. 301 and 302 turn a POST into a GET, 303 turns
 * everything but HEAD into a GET, 307 and 308 keep the method and the body. Moving to another origin drops the credentials and
 * every header whose name looks secret.
 */
export function nextHop(current: WireRequest, status: number, location: string, policy: RedirectPolicy): Hop {
  let from: URL;
  let to: URL;
  try {
    from = new URL(current.url);
    to = new URL(location, from);
  } catch {
    return { follow: false, reason: 'the Location header is not a valid address' };
  }
  if (to.protocol !== 'http:' && to.protocol !== 'https:') return { follow: false, reason: `redirected to ${to.protocol}, which is not followed` };
  if (from.protocol === 'https:' && to.protocol === 'http:' && !policy.allowDowngrade) return { follow: false, reason: 'redirected from https to http, which is not followed' };
  if (isLocalHost(to.hostname) && !isLocalHost(from.hostname) && !policy.allowLocal) return { follow: false, reason: 'redirected to an address on this machine or network, which is not followed unless the request allows it in its settings' };

  const crossOrigin = originOf(from) !== originOf(to);
  const dropBody = status === 303 ? current.method.toUpperCase() !== 'HEAD' : (status === 301 || status === 302) && current.method.toUpperCase() === 'POST';
  const dropped = new Set<string>(['host', 'content-length', ...(crossOrigin ? CREDENTIAL_HEADERS : []), ...(dropBody ? BODY_HEADERS : [])]);
  const request: WireRequest = {
    method: dropBody ? 'GET' : current.method,
    url: to.href,
    headers: without(current.headers, dropped, crossOrigin)
  };
  if (!dropBody && current.body !== undefined) request.body = current.body;
  return { follow: true, request };
}
