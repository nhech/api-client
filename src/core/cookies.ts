/**
 * The cookie jar: RFC 6265 for a client that is not a browser. Time comes from the function the jar is given, so the jar
 * never reads the clock; the cookies it holds can be written out and read back. What a server may set is limited the way a
 * browser limits it: a cookie belongs to the host that set it or to a parent domain that is not a public suffix, a `Secure`
 * cookie is not accepted over plain http, a cookie is at most 4096 bytes, and a jar holds a few thousand of them at most.
 */
export interface Cookie {
  name: string;
  value: string;
  /** Lower case, without a leading dot. */
  domain: string;
  /** The cookie came without a Domain attribute and goes only to this exact host. */
  hostOnly: boolean;
  path: string;
  /** Epoch milliseconds, or undefined for a session cookie. */
  expires: number | undefined;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  created: number;
}

export const JAR_LIMITS = { totalCookies: 3000, cookiesPerDomain: 150, cookieBytes: 4096, headerBytes: 8192 } as const;

/** Two-label public suffixes that a Domain attribute may not claim. A full list is a later improvement; every single-label domain is refused anyway. */
const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'com.br', 'com.cn', 'com.hk', 'com.sg', 'com.tw',
  'com.mx', 'co.in', 'co.za', 'co.kr', 'com.tr', 'com.ar', 'github.io', 'gitlab.io', 'herokuapp.com', 'appspot.com', 'blogspot.com', 'cloudfront.net', 'azurewebsites.net',
  'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'amazonaws.com', 's3.amazonaws.com', 'compute.amazonaws.com'
]);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Days from 1970-01-01 to a civil date, for dates before or after. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The cookie date algorithm of RFC 6265 section 5.1.1, which accepts the formats servers actually send. Undefined when there is no date in the text. */
export function parseCookieDate(text: string): number | undefined {
  let time: [number, number, number] | undefined;
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  for (const token of text.split(/[^A-Za-z0-9:]+/)) {
    if (token === '') continue;
    let match: RegExpExecArray | null;
    if (time === undefined && (match = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D|$)/.exec(token)) !== null) time = [Number(match[1]), Number(match[2]), Number(match[3])];
    else if (day === undefined && (match = /^(\d{1,2})(?:\D|$)/.exec(token)) !== null) day = Number(match[1]);
    else if (month === undefined && token.length >= 3 && MONTHS.includes(token.slice(0, 3).toLowerCase())) month = MONTHS.indexOf(token.slice(0, 3).toLowerCase()) + 1;
    else if (year === undefined && (match = /^(\d{2,4})(?:\D|$)/.exec(token)) !== null) year = Number(match[1]);
  }
  if (time === undefined || day === undefined || month === undefined || year === undefined) return undefined;
  if (year >= 70 && year <= 99) year += 1900;
  else if (year >= 0 && year <= 69) year += 2000;
  if (day < 1 || day > 31 || year < 1601 || time[0] > 23 || time[1] > 59 || time[2] > 59) return undefined;
  return (daysFromCivil(year, month, day) * 86_400 + time[0] * 3600 + time[1] * 60 + time[2]) * 1000;
}

const isIp = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');

/** Whether a Domain attribute may be claimed by a page on `host`: the host itself or a parent of it that is not a public suffix. */
function domainAllowed(domain: string, host: string): boolean {
  if (domain === host) return true;
  if (isIp(host) || isIp(domain) || !domain.includes('.') || PUBLIC_SUFFIXES.has(domain)) return false;
  return host.endsWith(`.${domain}`);
}

const domainMatches = (host: string, cookie: Cookie): boolean => (cookie.hostOnly ? host === cookie.domain : host === cookie.domain || (!isIp(host) && host.endsWith(`.${cookie.domain}`)));

/** The path of a request URL as a cookie path: up to, not including, the last slash (RFC 6265 5.1.4). */
const defaultPath = (pathname: string): string => {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
};

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

const isLocalHost = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);

export class CookieJar {
  private cookies: Cookie[] = [];

  constructor(private readonly now: () => number) {}

  /** Parses a `Set-Cookie` header received from `url` and keeps the cookie if it is allowed; an expired one removes the cookie it replaces. */
  private accept(url: URL, header: string, time: number): void {
    if (header.length > JAR_LIMITS.headerBytes) return;
    const parts = header.split(';');
    const first = parts.shift() ?? '';
    const equals = first.indexOf('=');
    if (equals < 0) return;
    const name = first.slice(0, equals).trim();
    const value = first.slice(equals + 1).trim();
    if (name === '' || /[\u0000-\u001f\u007f]/.test(name + value) || name.length + value.length > JAR_LIMITS.cookieBytes) return;

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const secureOrigin = url.protocol === 'https:' || isLocalHost(host);
    let domainAttribute = '';
    let pathAttribute = '';
    let maxAge: number | undefined;
    let expires: number | undefined;
    let secure = false;
    let httpOnly = false;
    let sameSite = '';
    for (const part of parts) {
      const at = part.indexOf('=');
      const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
      const raw = at < 0 ? '' : part.slice(at + 1).trim();
      if (key === 'domain') domainAttribute = raw.replace(/^\./, '').toLowerCase();
      else if (key === 'path') pathAttribute = raw;
      else if (key === 'max-age') { if (/^-?\d{1,15}$/.test(raw)) maxAge = Number(raw); }
      else if (key === 'expires') expires = parseCookieDate(raw);
      else if (key === 'secure') secure = true;
      else if (key === 'httponly') httpOnly = true;
      else if (key === 'samesite') sameSite = raw;
    }
    if (domainAttribute !== '' && !domainAllowed(domainAttribute, host)) return;
    if (secure && !secureOrigin) return;
    if (name.startsWith('__Secure-') && !secure) return;
    if (name.startsWith('__Host-') && (!secure || domainAttribute !== '' || (pathAttribute !== '' && pathAttribute !== '/'))) return;
    const lifetime = maxAge !== undefined ? time + maxAge * 1000 : expires;
    const cookie: Cookie = {
      name, value, domain: domainAttribute !== '' ? domainAttribute : host, hostOnly: domainAttribute === '', path: pathAttribute.startsWith('/') ? pathAttribute : defaultPath(url.pathname),
      expires: lifetime, secure, httpOnly, sameSite, created: time
    };
    // The same name, domain and path replaces the old cookie and keeps its creation time.
    const index = this.cookies.findIndex(held => held.name === cookie.name && held.domain === cookie.domain && held.path === cookie.path);
    const old = index >= 0 ? this.cookies[index] : undefined;
    if (lifetime !== undefined && lifetime <= time) {
      if (index >= 0) this.cookies.splice(index, 1);
      return;
    }
    if (old !== undefined) {
      cookie.created = old.created;
      this.cookies[index] = cookie;
    } else this.cookies.push(cookie);
    this.trim(cookie.domain);
  }

  private trim(domain: string): void {
    const sameDomain = this.cookies.filter(held => held.domain === domain);
    if (sameDomain.length > JAR_LIMITS.cookiesPerDomain) {
      const oldest = sameDomain.sort((a, b) => a.created - b.created).slice(0, sameDomain.length - JAR_LIMITS.cookiesPerDomain);
      this.cookies = this.cookies.filter(held => !oldest.includes(held));
    }
    if (this.cookies.length > JAR_LIMITS.totalCookies) {
      const oldest = [...this.cookies].sort((a, b) => a.created - b.created).slice(0, this.cookies.length - JAR_LIMITS.totalCookies);
      this.cookies = this.cookies.filter(held => !oldest.includes(held));
    }
  }

  store(url: URL, setCookies: string[]): void {
    const time = this.now();
    this.dropExpired(time);
    for (const header of setCookies) this.accept(url, header, time);
  }

  private dropExpired(time: number): void {
    this.cookies = this.cookies.filter(held => held.expires === undefined || held.expires > time);
  }

  /** The `Cookie` header for a request to `url`: the cookies whose domain, path and security fit, longest path first, then oldest first. */
  header(url: URL): string | undefined {
    const time = this.now();
    this.dropExpired(time);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const secureOrigin = url.protocol === 'https:' || isLocalHost(host);
    const path = url.pathname === '' ? '/' : url.pathname;
    const matching = this.cookies.filter(cookie => domainMatches(host, cookie) && pathMatches(path, cookie.path) && (!cookie.secure || secureOrigin));
    if (matching.length === 0) return undefined;
    matching.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return matching.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }

  list(): Cookie[] {
    this.dropExpired(this.now());
    return this.cookies.map(cookie => ({ ...cookie }));
  }

  /** Removes the cookie with this name, domain and path. */
  remove(name: string, domain: string, path: string): boolean {
    const before = this.cookies.length;
    this.cookies = this.cookies.filter(held => !(held.name === name && held.domain === domain && held.path === path));
    return this.cookies.length < before;
  }

  /** Removes every cookie, or those of one domain. */
  clear(domain?: string): void {
    this.cookies = domain === undefined ? [] : this.cookies.filter(held => held.domain !== domain);
  }

  /** The cookies that outlive the session, for saving; a session cookie is gone when the jar is. */
  persistent(): Cookie[] {
    return this.list().filter(cookie => cookie.expires !== undefined);
  }

  /** Puts saved cookies back; anything that is not a well-formed cookie is skipped. */
  load(saved: unknown): void {
    if (!Array.isArray(saved)) return;
    const time = this.now();
    for (const item of saved) {
      if (typeof item !== 'object' || item === null) continue;
      const value = item as Record<string, unknown>;
      if (typeof value['name'] !== 'string' || typeof value['value'] !== 'string' || typeof value['domain'] !== 'string' || typeof value['path'] !== 'string') continue;
      const expires = typeof value['expires'] === 'number' ? value['expires'] : undefined;
      if (expires !== undefined && expires <= time) continue;
      this.cookies.push({
        name: value['name'], value: value['value'], domain: value['domain'], path: value['path'], hostOnly: value['hostOnly'] === true, expires, secure: value['secure'] === true,
        httpOnly: value['httpOnly'] === true, sameSite: typeof value['sameSite'] === 'string' ? value['sameSite'] : '', created: typeof value['created'] === 'number' ? value['created'] : time
      });
      this.trim(value['domain']);
    }
  }
}
