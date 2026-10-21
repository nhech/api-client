import { leavesFolder } from '../convert/body';
import type { Auth, Body, KV, Part, Request, SettingsOverride } from '../core/model';
import { printable } from '../util/chars';
import { blankRequest } from './types';
import { row, splitUrl } from './url';

/**
 * A cURL command, as people copy it from a browser, from documentation or from a terminal, becomes a request of the client. The command is read as
 * the shell would split it (single and double quotes, `$'...'`, the line continuations of bash, PowerShell and cmd) and then by what its options
 * mean; nothing is run, no file is read, and nothing that cURL does with the answer (output files, proxies, retries) is taken over. What has no
 * place in a request is said in the notes, so the person knows what the pasted command did that the request does not.
 */
export const CURL_LIMITS = { textChars: 1_000_000, words: 5000, headers: 200, nameChars: 100 } as const;

export type CurlResult = { ok: true; request: Request; notes: string[] } | { ok: false; error: string };

/** Whether a text is a cURL command, for offering a paste as one. */
export const looksLikeCurl = (text: string): boolean => /^\s*(?:[$>#%]\s*)?curl(?:\.exe)?(?:\s|$)/i.test(text.slice(0, 200));

// ---- splitting into words ----

type Split = { ok: true; words: string[] } | { ok: false; error: string };

const ANSI_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', a: '\u0007', b: '\b', f: '\f', v: '\v', e: '\u001b', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** The words of a command line, as a shell would make them; the command stops at a pipe, a `;`, a `&&` or a redirection. */
export function splitCommand(input: string): Split {
  let text = input.replace(/\r\n?/g, '\n');
  // The cmd.exe form that browsers write: a caret before every special character, and before each line break.
  if (/\^\n/.test(text) || /\^"/.test(text)) text = text.replace(/\^\n/g, ' ').replace(/\^([\s\S])/g, '$1');
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let at = 0;
  const end = (): void => { if (inWord) { words.push(current); current = ''; inWord = false; } };
  while (at < text.length) {
    if (words.length > CURL_LIMITS.words) return { ok: false, error: 'The command has too many words to be a request.' };
    const char = text[at] as string;
    const next = text[at + 1];
    if (char === ' ' || char === '\t' || char === '\n') { end(); at++; continue; }
    if ((char === '\\' || char === '`') && next === '\n') { at += 2; continue; }
    if (char === '|' || char === ';' || char === '>' || (char === '&' && next === '&')) break;
    if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close < 0) return { ok: false, error: 'A quote that was opened is not closed.' };
      current += text.slice(at + 1, close); inWord = true; at = close + 1;
      continue;
    }
    if (char === '$' && next === "'") {
      let index = at + 2;
      let closed = false;
      inWord = true;
      while (index < text.length) {
        const c = text[index] as string;
        if (c === "'") { closed = true; index++; break; }
        if (c !== '\\') { current += c; index++; continue; }
        const e = text[index + 1] ?? '';
        const hex = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/.exec(text.slice(index + 1, index + 10));
        if (hex !== null) {
          const code = hex[1] !== undefined ? parseInt(hex[1], 16) : hex[2] !== undefined ? parseInt(hex[2], 16) : hex[3] !== undefined ? parseInt(hex[3], 16) : parseInt(hex[4] ?? '0', 8);
          current += code > 0x10ffff ? '?' : String.fromCodePoint(code);
          index += 1 + hex[0].length;
        } else { current += ANSI_ESCAPES[e] ?? `\\${e}`; index += 2; }
      }
      if (!closed) return { ok: false, error: 'A quote that was opened is not closed.' };
      at = index;
      continue;
    }
    if (char === '"' || (char === '$' && next === '"')) {
      let index = at + (char === '$' ? 2 : 1);
      let closed = false;
      inWord = true;
      while (index < text.length) {
        const c = text[index] as string;
        if (c === '"') { closed = true; index++; break; }
        if (c === '\\') {
          const e = text[index + 1];
          if (e === '\n') { index += 2; continue; }
          if (e === '"' || e === '\\' || e === '$' || e === '`') { current += e; index += 2; continue; }
        }
        current += c; index++;
      }
      if (!closed) return { ok: false, error: 'A quote that was opened is not closed.' };
      at = index;
      continue;
    }
    if (char === '\\') { current += next ?? ''; inWord = true; at += 2; continue; }
    current += char; inWord = true; at++;
  }
  end();
  return { ok: true, words };
}

// ---- the options ----

/** Short options that take the next word (or the rest of the word) as their value. */
const SHORT_WITH_VALUE = new Set('XHdFuAebmoxwTcKYyzUErCtPQDB'.split(''));
/** Long options that take a value, and mean something (the others that take one are in IGNORED_WITH_VALUE). */
const LONG_WITH_VALUE = new Set(['request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'form', 'form-string', 'user', 'user-agent', 'referer', 'cookie', 'url', 'max-time', 'json', 'oauth2-bearer', 'upload-file']);
const IGNORED_WITH_VALUE = new Set(['output', 'proxy', 'proxy-user', 'cacert', 'cert', 'key', 'capath', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'resolve', 'connect-to', 'limit-rate', 'max-redirs', 'write-out', 'config', 'cookie-jar', 'dump-header', 'interface', 'local-port', 'noproxy', 'keepalive-time', 'range', 'continue-at', 'time-cond', 'trace', 'trace-ascii', 'user-agent', 'dns-servers', 'doh-url', 'pinnedpubkey', 'proxy-header', 'unix-socket', 'alt-svc', 'etag-save', 'etag-compare', 'cert-type', 'key-type', 'pass', 'ciphers', 'tls-max', 'tlsv1.0', 'engine', 'expect100-timeout', 'happy-eyeballs-timeout-ms', 'hsts', 'ipfs-gateway', 'login-options', 'netrc-file', 'parallel-max', 'proto', 'proto-default', 'proto-redir', 'proxy-cacert', 'proxy-cert', 'proxy-key', 'quote', 'referer-url', 'request-target', 'sasl-authzid', 'service-name', 'socks5-hostname', 'speed-limit', 'speed-time', 'stderr', 'telnet-option', 'tftp-blksize', 'time', 'url-query', 'variable', 'oauth2-bearer-file']);
const QUIET = new Set(['s', 'S', 'v', 'i', 'f', 'g', 'N', 'L', 'compressed', 'silent', 'show-error', 'verbose', 'include', 'fail', 'globoff', 'no-buffer', 'no-keepalive', 'progress-bar', 'location', 'tcp-nodelay', 'basic', 'path-as-is', 'tr-encoding', 'location-trusted', 'fail-with-body', 'no-progress-meter', 'ssl-no-revoke', 'http1.0', 'ipv4', 'ipv6', '4', '6', 'O', 'remote-name', 'junk-session-cookies', 'raw', 'styled-output', 'xattr', 'remote-time', 'ssl', 'tlsv1.2', 'tlsv1.3', 'sslv3', 'tcp-fastopen', 'anyauth', 'negotiate', 'http2-prior-knowledge', 'expect100', 'ignore-content-length', 'create-dirs', 'suppress-connect-headers', 'trace-time', 'sessionid', 'no-sessionid']);

interface Option { name: string; value: string }

interface State {
  method: string | undefined;
  urls: string[];
  headers: KV[];
  data: { raw: string }[];
  forms: Part[];
  user: string | undefined;
  bearer: string | undefined;
  digest: boolean;
  get: boolean;
  head: boolean;
  insecure: boolean;
  maxTime: number | undefined;
  httpVersion: '1.1' | '2' | undefined;
  upload: string | undefined;
  json: boolean;
  fileBody: string | undefined;
  notes: string[];
}

const SHORT_TO_LONG: Readonly<Record<string, string>> = {
  X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', A: 'user-agent', e: 'referer', b: 'cookie', m: 'max-time', T: 'upload-file', G: 'get', I: 'head', k: 'insecure', o: 'output', x: 'proxy', w: 'write-out', c: 'cookie-jar'
};

/** The command's words as options and values, in order; what is not an option is the address. */
function options(words: readonly string[]): { list: Option[]; positional: string[] } {
  const list: Option[] = [];
  const positional: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as string;
    if (word === '--') { positional.push(...words.slice(index + 1)); break; }
    if (word.startsWith('--') && word.length > 2) {
      const equals = word.indexOf('=');
      const name = equals < 0 ? word.slice(2) : word.slice(2, equals);
      if (equals >= 0) { list.push({ name, value: word.slice(equals + 1) }); continue; }
      if (LONG_WITH_VALUE.has(name) || IGNORED_WITH_VALUE.has(name)) { list.push({ name, value: words[index + 1] ?? '' }); index++; } else list.push({ name, value: '' });
      continue;
    }
    if (word.startsWith('-') && word.length > 1 && word !== '-') {
      // `-sSL`: flags without a value in a row; `-XPOST`, `-H'a: b'`: a flag with its value attached; `-X POST`: the value is the next word.
      for (let at = 1; at < word.length; at++) {
        const flag = word[at] as string;
        if (SHORT_WITH_VALUE.has(flag)) {
          const attached = word.slice(at + 1);
          const value = attached !== '' ? attached : (words[index + 1] ?? '');
          if (attached === '') index++;
          list.push({ name: SHORT_TO_LONG[flag] ?? flag, value });
          break;
        }
        list.push({ name: SHORT_TO_LONG[flag] ?? flag, value: '' });
      }
      continue;
    }
    positional.push(word);
  }
  return { list, positional };
}

/** `a=1&b=2` as rows, or nothing when it is not a form. */
function formRows(text: string): KV[] | undefined {
  const pieces = text.split('&');
  if (text === '' || pieces.some(piece => !/^[^\s=&]+=[^\s&]*$/.test(piece) && !/^[^\s=&]+$/.test(piece))) return undefined;
  const decode = (value: string): string => { try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; } };
  return pieces.map(piece => { const equals = piece.indexOf('='); return row(decode(equals < 0 ? piece : piece.slice(0, equals)), decode(equals < 0 ? '' : piece.slice(equals + 1))); });
}

const encodeForm = (value: string): string => encodeURIComponent(value).replace(/%20/g, '+');

function addHeader(state: State, spec: string): void {
  const colon = spec.indexOf(':');
  if (colon < 0) {
    const bare = spec.replace(/;\s*$/, '').trim();
    if (spec.trimEnd().endsWith(';') && bare !== '') state.headers.push(row(bare, ''));
    return;
  }
  const name = spec.slice(0, colon).trim();
  const value = spec.slice(colon + 1).trim();
  if (name === '') return;
  if (value === '') { state.notes.push(`The header ${printable(name.slice(0, CURL_LIMITS.nameChars))} is given with no value, which makes cURL leave out its own: it is not sent here either.`); return; }
  if (state.headers.length < CURL_LIMITS.headers) state.headers.push(row(name, value));
}

/**
 * A file named in the command is a file of the folder of the collection. A path that leads out of it (an absolute path, a drive, `~`, `..`) is the
 * kind of thing a command copied from somewhere may carry on purpose, so only the name of the file is kept, and the note says so.
 */
function localFile(state: State, path: string): string {
  if (!leavesFolder(path)) return path;
  const name = path.split(/[\\/]/).filter(piece => piece !== '' && piece !== '..' && piece !== '~').pop() ?? '';
  state.notes.push(`The path ${printable(path.slice(0, 100))} leads out of the folder of the collection: only the name of the file, ${printable(name.slice(0, 100))}, was kept.`);
  return name;
}

/** A part of `-F name=value`, `name=@file;type=text/plain;filename=x`, `name=<file`. */
function addForm(state: State, spec: string, literal: boolean): void {
  const equals = spec.indexOf('=');
  if (equals <= 0) { state.notes.push('A form field without a name was left out.'); return; }
  const name = spec.slice(0, equals);
  const rest = spec.slice(equals + 1);
  const part: Part = { name, kind: 'text', value: rest, file: '', contentType: '', enabled: true };
  if (!literal && rest.startsWith('@')) {
    const [named = '', ...modifiers] = rest.slice(1).split(';');
    const file = localFile(state, named);
    part.kind = 'file'; part.file = file; part.value = '';
    for (const modifier of modifiers) { const m = /^\s*type=(.+)$/i.exec(modifier); if (m?.[1] !== undefined) part.contentType = m[1].trim(); }
    state.notes.push(`The file ${printable(file.slice(0, 100))} of the form field ${printable(name.slice(0, CURL_LIMITS.nameChars))} is read from the folder of the collection: put it there.`);
  } else if (!literal && rest.startsWith('<')) {
    state.notes.push(`The field ${printable(name.slice(0, CURL_LIMITS.nameChars))} takes its value from a file, which is not read here: type the value in.`);
    part.value = '';
  } else if (!literal) {
    const [value = '', ...modifiers] = rest.split(';');
    const typed = modifiers.map(modifier => /^\s*type=(.+)$/i.exec(modifier)?.[1]).find(item => item !== undefined);
    if (typed !== undefined) { part.value = value; part.contentType = typed.trim(); }
  }
  state.forms.push(part);
}

function addData(state: State, name: string, value: string): void {
  if (name === 'data-urlencode') {
    // `content`, `=content`, `name=content`, `@file`, `name@file`.
    const equals = value.indexOf('=');
    const at = value.indexOf('@');
    if (equals < 0 && at >= 0) { state.notes.push('A --data-urlencode value is read from a file, which is not read here: type it in.'); return; }
    state.data.push({ raw: equals <= 0 ? encodeForm(value.slice(equals + 1)) : `${value.slice(0, equals)}=${encodeForm(value.slice(equals + 1))}` });
    return;
  }
  if (name !== 'data-raw' && value.startsWith('@')) {
    state.fileBody = localFile(state, value.slice(1));
    state.notes.push(`The body is read from the file ${printable(state.fileBody.slice(0, 100))}: put it in the folder of the collection, and set it in the Body tab.`);
    return;
  }
  state.data.push({ raw: value });
}

const hostOf = (url: string): string => /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '';

/** A name for the request: the method and the path. */
function titleOf(method: string, url: string): string {
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0] ?? '';
  const shown = path === '' || path === '/' ? hostOf(url) || url : path;
  return printable(`${method} ${shown}`).slice(0, 100).trim();
}

export function parseCurl(input: string): CurlResult {
  if (input.length > CURL_LIMITS.textChars) return { ok: false, error: 'The text is too long to be one command.' };
  const split = splitCommand(input);
  if (!split.ok) return split;
  const start = split.words.findIndex(word => /^curl(?:\.exe)?$/i.test(word));
  if (start < 0) return { ok: false, error: 'This is not a cURL command: it does not start with curl.' };
  const { list, positional } = options(split.words.slice(start + 1));
  const state: State = { method: undefined, urls: [...positional], headers: [], data: [], forms: [], user: undefined, bearer: undefined, digest: false, get: false, head: false, insecure: false, maxTime: undefined, httpVersion: undefined, upload: undefined, json: false, fileBody: undefined, notes: [] };
  const ignored = new Set<string>();
  for (const { name, value } of list) {
    switch (name) {
      case 'request': state.method = value.trim().toUpperCase(); break;
      case 'url': state.urls.unshift(value); break;
      case 'header': addHeader(state, value); break;
      case 'data': case 'data-ascii': case 'data-raw': case 'data-binary': case 'data-urlencode': addData(state, name, value); break;
      case 'json': state.json = true; state.data.push({ raw: value }); break;
      case 'form': addForm(state, value, false); break;
      case 'form-string': addForm(state, value, true); break;
      case 'user': state.user = value; break;
      case 'oauth2-bearer': state.bearer = value; break;
      case 'user-agent': state.headers.push(row('User-Agent', value)); break;
      case 'referer': state.headers.push(row('Referer', value)); break;
      case 'cookie':
        if (value.includes('=')) state.headers.push(row('Cookie', value));
        else state.notes.push('A cookie file is not read: put the cookies in a Cookie header.');
        break;
      case 'get': state.get = true; break;
      case 'head': state.head = true; break;
      case 'insecure': state.insecure = true; break;
      case 'max-time': { const seconds = Number(value); if (Number.isFinite(seconds) && seconds > 0) state.maxTime = Math.round(seconds * 1000); break; }
      case 'http1.1': state.httpVersion = '1.1'; break;
      case 'http2': case 'http2-prior-knowledge': state.httpVersion = '2'; break;
      case 'upload-file': state.upload = localFile(state, value); break;
      case 'digest': state.digest = true; break;
      default:
        if (!QUIET.has(name) && !ignored.has(name)) { ignored.add(name); state.notes.push(`The option ${printable(name.length === 1 ? `-${name}` : `--${name}`.slice(0, 40))} has no place in a request and was left out.`); }
    }
  }

  const address = state.urls[0];
  if (address === undefined || address.trim() === '') return { ok: false, error: 'There is no address in the command.' };
  if (state.urls.length > 1) state.notes.push(`cURL can fetch several addresses; the first one is used and ${state.urls.length - 1} more ${state.urls.length === 2 ? 'was' : 'were'} left out.`);
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(address) || address.startsWith('{{') ? address : `http://${address}`;

  // The method: what -X says; else HEAD for -I, GET for -G, POST for a body or a form, PUT for an upload, else GET.
  const hasBody = state.data.length > 0 || state.forms.length > 0 || state.fileBody !== undefined || state.upload !== undefined;
  const query: KV[] = [];
  const method = state.method ?? (state.head ? 'HEAD' : state.get ? 'GET' : state.upload !== undefined ? 'PUT' : hasBody ? 'POST' : 'GET');

  let body: Body = { kind: 'none' };
  const headers = [...state.headers];
  const typeIndex = headers.findIndex(header => header.name.toLowerCase() === 'content-type');
  const type = typeIndex < 0 ? '' : (headers[typeIndex] as KV).value.toLowerCase();
  if (state.json) {
    if (!headers.some(header => header.name.toLowerCase() === 'content-type')) headers.push(row('Content-Type', 'application/json'));
    if (!headers.some(header => header.name.toLowerCase() === 'accept')) headers.push(row('Accept', 'application/json'));
  }
  if (state.get && state.data.length > 0) {
    // -G puts the data in the query of the address, not in a body.
    for (const piece of state.data) for (const item of formRows(piece.raw) ?? [row(piece.raw, '')]) query.push(item);
  } else if (state.forms.length > 0) {
    body = { kind: 'multipart', parts: state.forms };
    if (typeIndex >= 0 && type.startsWith('multipart/form-data')) headers.splice(typeIndex, 1);
  } else if (state.upload !== undefined) {
    body = { kind: 'binary', file: state.upload };
    state.notes.push(`The file ${printable(state.upload.slice(0, 100))} is sent as the body: put it in the folder of the collection.`);
  } else if (state.fileBody !== undefined && state.data.length === 0) {
    body = { kind: 'binary', file: state.fileBody };
  } else if (state.data.length > 0) {
    const text = state.data.map(piece => piece.raw).join('&');
    if (type.includes('json') || state.json || (type === '' && /^\s*[{[]/.test(text))) {
      body = { kind: 'json', text };
      if (type === '' && !state.json) state.notes.push('cURL would send this body as a form (it has no Content-Type); it is sent as JSON here, which is what it looks like.');
    } else if (type.includes('xml')) body = { kind: 'xml', text };
    else {
      const fields = type === '' || type.startsWith('application/x-www-form-urlencoded') ? formRows(text) : undefined;
      body = fields !== undefined ? { kind: 'form', fields } : { kind: 'text', contentType: typeIndex < 0 ? 'application/x-www-form-urlencoded' : (headers[typeIndex] as KV).value, text };
    }
  }

  let auth: Auth = { kind: 'inherit' };
  if (state.bearer !== undefined) auth = { kind: 'bearer', token: state.bearer, prefix: 'Bearer' };
  else if (state.user !== undefined) {
    const colon = state.user.indexOf(':');
    auth = { kind: 'basic', username: colon < 0 ? state.user : state.user.slice(0, colon), password: colon < 0 ? '' : state.user.slice(colon + 1) };
    if (colon < 0) state.notes.push('The command gives a user name and no password (cURL asks for it): type the password in the Auth tab.');
    if (state.digest) state.notes.push('The command asks for digest authentication, which is not supported yet: basic authentication is set instead.');
  }

  const split2 = splitUrl(absolute);
  const settings: SettingsOverride = {};
  if (state.insecure) { settings.rejectUnauthorized = false; state.notes.push('The command says -k, so the certificate of the server is not checked for this request.'); }
  if (state.maxTime !== undefined) settings.timeoutMs = state.maxTime;
  if (state.httpVersion !== undefined) settings.httpVersion = state.httpVersion;
  const request: Request = { ...blankRequest(titleOf(method, absolute)), method, url: split2.url, query: [...split2.query, ...query], headers, auth, body, settings };
  return { ok: true, request, notes: state.notes };
}
