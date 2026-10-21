import { parseSetCookie } from '../core/cookies';
import { redactedValue, redactValues } from '../core/redact';
import { isoTime } from '../core/vars';
import type { RedirectHop, Timings, TlsInfo, WireRequest, WireResponse } from '../engine/types';
import { printable } from '../util/chars';

/**
 * What the response pane shows, made from what the engine returned: the body as text in the charset it declared (or as a picture, or
 * as a hex dump when it is not text), formatted when it is JSON or XML, the cookies it sets, and the request as it went out with the
 * credentials hidden. Pure: the extension reads the bytes and gives them in; the page only draws what comes out.
 */
export const VIEW_TEXT_LIMIT = 2 * 1024 * 1024;
/** How much of a body the extension reads for the view; the rest stays where it is (in memory or in the file it was spilled to). */
export const VIEW_READ_BYTES = 4 * 1024 * 1024;
const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const HEX_BYTES = 512;
const SENT_BODY_LIMIT = 64 * 1024;
const MAX_JSON_DEPTH = 256;

export type Language = 'json' | 'xml' | 'html' | 'javascript' | 'text';

export interface BodyView {
  kind: 'empty' | 'text' | 'image' | 'binary';
  language: Language;
  /** The media type without parameters, lower case; empty when the response did not say. */
  mediaType: string;
  /** The charset the text was read with. */
  charset: string;
  /** The text as it came (cut at VIEW_TEXT_LIMIT characters); empty for a body that is not text. */
  raw: string;
  /** The text formatted, when it is JSON or XML that is well formed and the formatting changes it. */
  pretty: string | undefined;
  /** Only the beginning of the body is shown. */
  cut: boolean;
  /** The size of the whole body in bytes. */
  size: number;
  /** A data address for a picture. */
  image: string | undefined;
  /** The first bytes of a body that is not text. */
  hex: string | undefined;
}

export interface CookieView {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
}

export interface SentView {
  method: string;
  url: string;
  headers: [string, string][];
  /** The body as text, or a line saying what it is (a file, binary bytes). Credentials are hidden. */
  body: string;
}

export interface ResponseView {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: [string, string][];
  body: BodyView;
  size: number;
  wireBytes: number;
  timings: Timings;
  redirects: RedirectHop[];
  finalUrl: string;
  tls: TlsInfo | undefined;
  warnings: string[];
  cookies: CookieView[];
  sent: SentView;
  /** The engine cut the body at the limit of the settings. */
  truncated: boolean;
  /** The body is in a file, not in memory. */
  onDisk: boolean;
}

// ---- formatting ----

/** A JSON text laid out with line breaks and indentation, with every string and number exactly as written; undefined when it is not well-formed JSON. */
export function formatJson(text: string, indent = '  '): string | undefined {
  const n = text.length;
  let pos = 0;
  const out: string[] = [];
  const stack: ('{' | '[')[] = [];
  const skip = (): void => {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) pos++;
      else break;
    }
  };
  const lineBreak = (depth: number): string => `\n${indent.repeat(depth)}`;
  const string = (): boolean => {
    const start = pos;
    pos++;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 0x22) { pos++; out.push(text.slice(start, pos)); return true; }
      if (c < 0x20) return false;
      if (c === 0x5c) {
        const escape = text[pos + 1];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(pos + 2, pos + 6))) return false;
          pos += 6;
        } else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) pos += 2;
        else return false;
      } else pos++;
    }
    return false;
  };
  const number = (): boolean => {
    const pattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    pattern.lastIndex = pos;
    const match = pattern.exec(text);
    if (match === null) return false;
    pos += match[0].length;
    out.push(match[0]);
    return true;
  };
  const word = (literal: string): boolean => {
    if (!text.startsWith(literal, pos)) return false;
    pos += literal.length;
    out.push(literal);
    return true;
  };
  /** A key and its colon. */
  const key = (): boolean => {
    skip();
    if (text[pos] !== '"' || !string()) return false;
    skip();
    if (text[pos] !== ':') return false;
    pos++;
    out.push(': ');
    return true;
  };

  let wantValue = true;
  for (;;) {
    skip();
    if (wantValue) {
      const c = text[pos];
      if (c === undefined) return undefined;
      if (c === '{' || c === '[') {
        const close = c === '{' ? '}' : ']';
        if (stack.length >= MAX_JSON_DEPTH) return undefined;
        pos++;
        skip();
        if (text[pos] === close) { pos++; out.push(c, close); wantValue = false; continue; }
        stack.push(c);
        out.push(c, lineBreak(stack.length));
        if (c === '{' && !key()) return undefined;
        continue;
      }
      if (c === '"') { if (!string()) return undefined; }
      else if (c === 't') { if (!word('true')) return undefined; }
      else if (c === 'f') { if (!word('false')) return undefined; }
      else if (c === 'n') { if (!word('null')) return undefined; }
      else if (!number()) return undefined;
      wantValue = false;
      continue;
    }
    const open = stack[stack.length - 1];
    if (open === undefined) return pos === n ? out.join('') : undefined;
    const c = text[pos];
    if (c === ',') {
      pos++;
      out.push(',', lineBreak(stack.length));
      if (open === '{' && !key()) return undefined;
      wantValue = true;
    } else if (c === (open === '{' ? '}' : ']')) {
      pos++;
      stack.pop();
      out.push(lineBreak(stack.length), c);
    } else return undefined;
  }
}

const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_:](?:"[^"]*"|'[^']*'|[^>"'])*>|[^<]+/gy;

/** An XML text laid out one element to a line; undefined when the tags do not match. Text between tags that is only white space is dropped, so this is for reading, not for sending back. */
export function formatXml(text: string, indent = '  '): string | undefined {
  const tokens: string[] = [];
  XML_TOKEN.lastIndex = 0;
  let at = 0;
  while (at < text.length) {
    XML_TOKEN.lastIndex = at;
    const match = XML_TOKEN.exec(text);
    if (match === null) return undefined;
    const token = match[0].startsWith('<') ? match[0] : match[0].trim();
    if (token !== '') tokens.push(token);
    at = XML_TOKEN.lastIndex;
  }
  const nameOf = (tag: string): string => /^<\/?([^\s/>]+)/.exec(tag)?.[1] ?? '';
  const lines: string[] = [];
  const open: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    const pad = indent.repeat(open.length);
    if (!token.startsWith('<') || token.startsWith('<!') || token.startsWith('<?')) { lines.push(pad + token); continue; }
    if (token.startsWith('</')) {
      if (open.pop() !== nameOf(token)) return undefined;
      lines.push(indent.repeat(open.length) + token);
      continue;
    }
    if (token.endsWith('/>')) { lines.push(pad + token); continue; }
    const name = nameOf(token);
    const next = tokens[index + 1];
    const after = tokens[index + 2];
    // <a>text</a> and <a></a> stay on one line.
    if (next !== undefined && next.startsWith('</') && nameOf(next) === name) { lines.push(pad + token + next); index += 1; continue; }
    if (next !== undefined && !next.startsWith('<') && after !== undefined && after.startsWith('</') && nameOf(after) === name) { lines.push(pad + token + next + after); index += 2; continue; }
    open.push(name);
    lines.push(pad + token);
  }
  return open.length === 0 ? lines.join('\n') : undefined;
}

/** The first bytes as a hex dump: sixteen to a line, with the text they spell on the right. */
export function hexDump(bytes: Uint8Array, limit = HEX_BYTES): string {
  const lines: string[] = [];
  const end = Math.min(bytes.length, limit);
  for (let offset = 0; offset < end; offset += 16) {
    const chunk = bytes.subarray(offset, Math.min(offset + 16, end));
    let hex = '';
    let text = '';
    for (let index = 0; index < 16; index++) {
      const byte = chunk[index];
      hex += byte === undefined ? '   ' : `${byte.toString(16).padStart(2, '0')} `;
      if (index === 7) hex += ' ';
      if (byte !== undefined) text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
    }
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex} |${text}|`);
  }
  return lines.join('\n');
}

/** "1.5 KB", "12 B": binary multiples, one decimal when it helps. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** "340 ms", "1.2 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}

// ---- the body ----

const IMAGES: Readonly<Record<string, string>> = {
  'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/gif': 'image/gif', 'image/webp': 'image/webp', 'image/bmp': 'image/bmp',
  'image/x-icon': 'image/x-icon', 'image/vnd.microsoft.icon': 'image/x-icon', 'image/avif': 'image/avif'
};
const BINARY_TYPES = /^(?:audio|video|font)\/|^application\/(?:pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|wasm|x-protobuf|protobuf|msgpack|x-msgpack|vnd\.ms-excel|vnd\.openxmlformats-officedocument\..*|java-archive)$/;

export function mediaTypeOf(contentType: string): { mediaType: string; charset: string } {
  const [head = '', ...parameters] = contentType.split(';');
  let charset = '';
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(parameter);
    if (match !== null) charset = (match[1] as string).toLowerCase();
  }
  return { mediaType: head.trim().toLowerCase(), charset };
}

function languageOf(mediaType: string): Language | undefined {
  if (mediaType === 'application/json' || mediaType === 'text/json' || mediaType.endsWith('+json') || mediaType === 'application/x-ndjson' || mediaType === 'application/ld+json') return 'json';
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html';
  if (mediaType === 'application/xml' || mediaType === 'text/xml' || mediaType.endsWith('+xml')) return 'xml';
  if (mediaType === 'application/javascript' || mediaType === 'text/javascript' || mediaType === 'application/x-javascript') return 'javascript';
  if (mediaType.startsWith('text/') || mediaType === 'application/x-www-form-urlencoded' || mediaType === 'application/graphql') return 'text';
  return undefined;
}

/** For a response that did not say what it is: what the text looks like. */
function sniffLanguage(text: string): Language {
  const head = text.slice(0, 256).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return formatJson(text) !== undefined ? 'json' : 'text';
  if (/^<!doctype\s+html|^<html[\s>]/i.test(head)) return 'html';
  if (head.startsWith('<?xml') || /^<[A-Za-z_]/.test(head)) return 'xml';
  return 'text';
}

/** The bytes as text in the character set the response declared (a mark at the start of UTF-16 wins); one that is not known is read as UTF-8, and the warning says so. */
export function decodeBodyText(bytes: Uint8Array, declared: string): { text: string; charset: string; warning: string | undefined } {
  let label = declared;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  if (label !== '') {
    try {
      const decoder = new TextDecoder(label);
      return { text: decoder.decode(bytes), charset: decoder.encoding, warning: undefined };
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8', warning: `The response names the character set "${printable(label).slice(0, 40)}", which is not known here, so it is shown as UTF-8.` };
    }
  }
  return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8', warning: undefined };
}

const looksBinary = (bytes: Uint8Array): boolean => {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let index = 0; index < end; index++) if (bytes[index] === 0) return true;
  return false;
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** The text cut at `limit` characters without leaving half of a character at the end. */
function cutText(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end), cut: true };
}

export function describeBody(bytes: Uint8Array, size: number, contentType: string, warnings: string[]): BodyView {
  const { mediaType, charset: declared } = mediaTypeOf(contentType);
  const base = { mediaType, size, raw: '', pretty: undefined, cut: false, image: undefined, hex: undefined };
  if (size === 0) return { ...base, kind: 'empty', language: 'text', charset: '' };
  const mime = IMAGES[mediaType];
  if (mime !== undefined) {
    if (bytes.length === size && size <= IMAGE_LIMIT_BYTES) return { ...base, kind: 'image', language: 'text', charset: '', image: `data:${mime};base64,${toBase64(bytes)}` };
    return { ...base, kind: 'binary', language: 'text', charset: '', hex: hexDump(bytes), cut: size > HEX_BYTES };
  }
  const known = languageOf(mediaType);
  if ((BINARY_TYPES.test(mediaType) && known === undefined) || looksBinary(bytes)) return { ...base, kind: 'binary', language: 'text', charset: '', hex: hexDump(bytes), cut: size > HEX_BYTES };
  const decoded = decodeBodyText(bytes, declared);
  if (decoded.warning !== undefined) warnings.push(decoded.warning);
  const shown = cutText(decoded.text, VIEW_TEXT_LIMIT);
  const cut = shown.cut || bytes.length < size;
  const language = known ?? sniffLanguage(shown.text);
  let pretty: string | undefined;
  if (!cut) {
    if (language === 'json') pretty = formatJson(shown.text);
    else if (language === 'xml') pretty = formatXml(shown.text);
    if (pretty === shown.text) pretty = undefined;
  }
  return { ...base, kind: 'text', language, charset: decoded.charset, raw: shown.text, pretty, cut };
}

// ---- the request as it went out ----

const textDecoderFatal = new TextDecoder('utf-8', { fatal: true });

function describeSentBody(wire: WireRequest, redactions: readonly string[]): string {
  const body = wire.body;
  if (body === undefined) return '';
  if (body.kind === 'file') return `(the file ${printable(body.path.split(/[\\/]/).pop() ?? 'file')} is sent as it is)`;
  if (body.kind === 'multipart') {
    const lines = body.parts.map(part => {
      const name = printable(part.name);
      return part.filePath !== undefined ? `${name}: (file ${printable(part.filename ?? 'file')})` : `${name}: ${redactedValue(part.name, part.value ?? '', redactions)}`;
    });
    return lines.join('\n');
  }
  let text: string;
  try { text = textDecoderFatal.decode(body.bytes.subarray(0, SENT_BODY_LIMIT + 4)); } catch { return `(binary data, ${formatSize(body.bytes.length)})`; }
  const more = body.bytes.length > SENT_BODY_LIMIT;
  const shown = cutText(text, SENT_BODY_LIMIT).text;
  return redactValues(shown, redactions) + (more ? `\n... (${formatSize(body.bytes.length - SENT_BODY_LIMIT)} more not shown)` : '');
}

export function describeSent(wire: WireRequest, redactions: readonly string[]): SentView {
  return {
    method: wire.method,
    url: printable(redactValues(wire.url, redactions)),
    headers: wire.headers.map(([name, value]) => [printable(name), printable(redactedValue(name, value, redactions))]),
    body: describeSentBody(wire, redactions)
  };
}

// ---- the whole response ----

export interface ResponseViewInput {
  response: WireResponse;
  /** All of the body when it is small enough to show, else its beginning (at most VIEW_READ_BYTES). */
  bytes: Uint8Array;
  /** Values to hide in the request that is shown. */
  redactions: readonly string[];
  /** What was said before sending: variables with no value, and the like. */
  warnings: readonly string[];
}

const headerOf = (headers: readonly (readonly [string, string])[], name: string): string => headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? '';

export function buildResponseView(input: ResponseViewInput): ResponseView {
  const { response } = input;
  const warnings = [...input.warnings, ...response.warnings.map(printable)];
  const body = describeBody(input.bytes, response.size, headerOf(response.headers, 'content-type'), warnings);
  const cookies: CookieView[] = [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') continue;
    const cookie = parseSetCookie(value);
    if (cookie === undefined) continue;
    cookies.push({
      name: printable(cookie.name), value: printable(cookie.value), domain: printable(cookie.domain), path: printable(cookie.path),
      expires: cookie.maxAge !== undefined ? `Max-Age ${cookie.maxAge} s` : cookie.expires !== undefined ? isoTime(cookie.expires) : 'Session',
      secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: printable(cookie.sameSite)
    });
  }
  return {
    status: response.status, statusText: printable(response.statusText), httpVersion: printable(response.httpVersion),
    headers: response.headers.map(([name, value]) => [printable(name), printable(value)]),
    body, size: response.size, wireBytes: response.wireBytes, timings: response.timings, redirects: response.redirects,
    finalUrl: printable(redactValues(response.finalUrl, input.redactions)), tls: response.tls, warnings, cookies,
    sent: describeSent(response.sent, input.redactions), truncated: response.truncated, onDisk: response.body.kind === 'file'
  };
}
