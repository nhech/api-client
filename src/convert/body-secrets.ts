import { SECRET_VARIABLE } from './secrets';
import { hasLiteral } from './text';

/**
 * Secrets inside a body (spec 8.3). A form field is a name and a value, so it is protected by its name. A raw body (JSON, XML, a
 * query string, GraphQL) holds the same pairs inside text, so they are found the same way, by name: `"apiKey": "..."`,
 * `<Password>...</Password>`, `client_secret=...`, `login(password: "...")`. What is found is a literal under a name that says "secret";
 * the text around it is not touched, so the body keeps its shape and the variable stands where the value was.
 *
 * Free text with no names in it cannot be read this way; it is the one place a secret can still stay, and SECURITY.md says so.
 * Every scanner makes one pass over the text (a test feeds each a megabyte of hostile input).
 */

/** What stands in the file for a value found under a name: the value itself, or `{{variable}}` (the value goes to the private file). */
export type NamedProtect = (name: string, value: string) => string;

const isSecretName = (name: string): boolean => SECRET_VARIABLE.test(name);
const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/** The index just after the closing quote of the string that starts at `start` (a quote), or -1 when it never closes. */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) i++;
    else if (code === 0x22) return i + 1;
  }
  return -1;
}

const unescapeKey = (raw: string): string => {
  if (!raw.includes('\\')) return raw;
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
};

/** Replaces the pieces `[from, to)` of `text` by new text, in order. */
function splice(text: string, edits: ReadonlyArray<readonly [number, number, string]>): string {
  if (edits.length === 0) return text;
  let out = '';
  let at = 0;
  for (const [from, to, replacement] of edits) { out += text.slice(at, from) + replacement; at = to; }
  return out + text.slice(at);
}

/**
 * JSON, or text that is almost JSON (it may hold `{{variables}}` where a value goes): every `"name": "string"` whose name says
 * "secret". The value is protected as it is written, escapes included, because a variable stands in the text where the written value was.
 */
export function protectJson(text: string, protect: NamedProtect): string {
  if (!text.includes('"')) return text;
  const edits: [number, number, string][] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x22) { i++; continue; }
    const end = endOfString(text, i);
    if (end < 0) break;
    let colon = end;
    while (colon < text.length && isSpace(text.charCodeAt(colon))) colon++;
    if (text.charCodeAt(colon) !== 0x3a) { i = end; continue; }
    let valueStart = colon + 1;
    while (valueStart < text.length && isSpace(text.charCodeAt(valueStart))) valueStart++;
    if (text.charCodeAt(valueStart) !== 0x22) { i = end; continue; }
    const valueEnd = endOfString(text, valueStart);
    if (valueEnd < 0) break;
    const name = unescapeKey(text.slice(i + 1, end - 1));
    const value = text.slice(valueStart + 1, valueEnd - 1);
    if (isSecretName(name) && hasLiteral(value)) {
      const safe = protect(name, value);
      if (safe !== value) edits.push([valueStart + 1, valueEnd - 1, safe]);
    }
    i = valueEnd;
  }
  return splice(text, edits);
}

const isIdentifierStart = (code: number): boolean => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
const isIdentifierPart = (code: number): boolean => isIdentifierStart(code) || (code >= 0x30 && code <= 0x39);

/**
 * A GraphQL query: every `name: "string"` (an argument) whose name says "secret". Block strings and comments are skipped over.
 * The query goes into a JSON body as one string, so a variable inside it is replaced by its value in that string: the value is
 * protected the way JSON writes it (a quote or a backslash escaped), and then the body is the same as the original once filled in.
 */
export function protectGraphqlQuery(text: string, protect: NamedProtect): string {
  if (!text.includes('"')) return text;
  const edits: [number, number, string][] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x23) { while (i < text.length && text.charCodeAt(i) !== 0x0a) i++; continue; }
    if (code === 0x22) {
      if (text.startsWith('"""', i)) { const close = text.indexOf('"""', i + 3); if (close < 0) break; i = close + 3; continue; }
      const end = endOfString(text, i);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (!isIdentifierStart(code)) { i++; continue; }
    let nameEnd = i + 1;
    while (nameEnd < text.length && isIdentifierPart(text.charCodeAt(nameEnd))) nameEnd++;
    let at = nameEnd;
    while (at < text.length && (isSpace(text.charCodeAt(at)) || text.charCodeAt(at) === 0x2c)) at++;
    if (text.charCodeAt(at) !== 0x3a) { i = nameEnd; continue; }
    at++;
    while (at < text.length && (isSpace(text.charCodeAt(at)) || text.charCodeAt(at) === 0x2c)) at++;
    if (text.charCodeAt(at) !== 0x22 || text.startsWith('"""', at)) { i = nameEnd; continue; }
    const valueEnd = endOfString(text, at);
    if (valueEnd < 0) break;
    const name = text.slice(i, nameEnd);
    const value = text.slice(at + 1, valueEnd - 1);
    if (isSecretName(name) && hasLiteral(value)) {
      const asJson = JSON.stringify(value).slice(1, -1);
      const safe = protect(name, asJson);
      if (safe !== asJson) edits.push([at + 1, valueEnd - 1, safe]);
    }
    i = valueEnd;
  }
  return splice(text, edits);
}

const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);
const isNameEnd = (code: number): boolean => isSpace(code) || code === 0x2f || code === 0x3e || code === 0x3d;

/**
 * XML: the text of an element and the value of an attribute whose name says "secret" (`<wsse:Password>`, `<Token value="...">`). The
 * prefix of a name is left out of the test, and namespace declarations are not attributes of this kind.
 */
export function protectXml(text: string, protect: NamedProtect): string {
  if (!text.includes('<')) return text;
  const edits: [number, number, string][] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open < 0) break;
    const next = text.charCodeAt(open + 1);
    if (text.startsWith('<!--', open)) { const close = text.indexOf('-->', open + 4); if (close < 0) break; i = close + 3; continue; }
    if (text.startsWith('<![CDATA[', open)) { const close = text.indexOf(']]>', open + 9); if (close < 0) break; i = close + 3; continue; }
    if (next === 0x2f || next === 0x21 || next === 0x3f || !isIdentifierStart(next) && next !== 0x3a) {
      const close = text.indexOf('>', open + 1);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    let at = open + 1;
    while (at < text.length && !isNameEnd(text.charCodeAt(at))) at++;
    const tag = localName(text.slice(open + 1, at));
    let selfClosing = false;
    let closed = false;
    while (at < text.length) {
      while (at < text.length && isSpace(text.charCodeAt(at))) at++;
      const code = text.charCodeAt(at);
      if (code === 0x3e) { at++; closed = true; break; }
      if (code === 0x2f) { selfClosing = text.charCodeAt(at + 1) === 0x3e; at += selfClosing ? 2 : 1; if (selfClosing) { closed = true; break; } continue; }
      const nameStart = at;
      while (at < text.length && !isNameEnd(text.charCodeAt(at))) at++;
      const attribute = text.slice(nameStart, at);
      while (at < text.length && isSpace(text.charCodeAt(at))) at++;
      if (text.charCodeAt(at) !== 0x3d) { if (at === nameStart) at++; continue; }
      at++;
      while (at < text.length && isSpace(text.charCodeAt(at))) at++;
      const quote = text.charCodeAt(at);
      if (quote !== 0x22 && quote !== 0x27) continue;
      const valueEnd = text.indexOf(quote === 0x22 ? '"' : "'", at + 1);
      if (valueEnd < 0) { at = text.length; break; }
      const value = text.slice(at + 1, valueEnd);
      if (!attribute.startsWith('xmlns') && isSecretName(localName(attribute)) && hasLiteral(value)) {
        const safe = protect(localName(attribute), value);
        if (safe !== value) edits.push([at + 1, valueEnd, safe]);
      }
      at = valueEnd + 1;
    }
    if (!closed) break;
    i = at;
    if (selfClosing || !isSecretName(tag)) continue;
    // The text of a leaf element: up to the next tag, when that tag closes this one.
    const stop = text.indexOf('<', at);
    if (stop < 0 || text.charCodeAt(stop + 1) !== 0x2f) continue;
    const inner = text.slice(at, stop);
    const trimmed = inner.trim();
    if (trimmed === '' || !hasLiteral(trimmed)) continue;
    const safe = protect(tag, trimmed);
    if (safe !== trimmed) {
      const lead = inner.length - inner.trimStart().length;
      edits.push([at + lead, at + lead + trimmed.length, safe]);
    }
    i = stop;
  }
  return splice(text, edits);
}

/** A query string written as a body (`grant_type=password&client_secret=...`): every pair whose name says "secret". */
export function protectPairs(text: string, protect: NamedProtect): string {
  const trimmed = text.trim();
  if (trimmed === '' || !trimmed.includes('=')) return text;
  const segments = trimmed.split('&');
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq < 1 || /\s/.test(segment)) return text;
  }
  let changed = false;
  const protectedSegments = segments.map(segment => {
    const eq = segment.indexOf('=');
    const name = segment.slice(0, eq);
    const value = segment.slice(eq + 1);
    let readable = name;
    try { readable = decodeURIComponent(name.replaceAll('+', ' ')); } catch { /* keep the name as written */ }
    if (!isSecretName(readable) || !hasLiteral(value)) return segment;
    const safe = protect(readable, value);
    if (safe === value) return segment;
    changed = true;
    return `${name}=${safe}`;
  });
  if (!changed) return text;
  const lead = text.length - text.trimStart().length;
  return text.slice(0, lead) + protectedSegments.join('&') + text.slice(lead + trimmed.length);
}

/** A raw body of any kind: what it looks like decides how it is read (a body of type "text" is often JSON, and the reverse). */
export function protectBodyText(text: string, protect: NamedProtect): string {
  const first = text.trimStart().charAt(0);
  if (first === '{' || first === '[') return protectJson(text, protect);
  if (first === '<') return protectXml(text, protect);
  return protectPairs(text, protect);
}
