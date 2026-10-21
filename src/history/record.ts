import { isSecretName, REDACTED, redactedValue, redactValues } from '../core/redact';
import { printable } from '../util/chars';
import { HISTORY_LIMITS, type HistoryDetail, type HistoryEntry } from './entries';

/**
 * What is written down about a send. The mode of the setting says how much: "off" keeps nothing, "metadata" keeps the line (method, address, status,
 * time, size) and "full" keeps the headers and the beginning of the two bodies as well. Whatever is kept has been made safe first: the values that
 * the request was built from as secrets are covered, a header or a query parameter or a field of a body whose name says it is secret is covered, and
 * the user name and password of an address are covered. That is the best that can be done with text; it cannot know a token that a server invented,
 * which is why "full" is a choice of the person and "metadata" is what is on by default.
 */
export type HistoryMode = 'off' | 'metadata' | 'full';

export const readMode = (value: unknown): HistoryMode => (value === 'off' || value === 'full' ? value : 'metadata');

/** How far past the limit a body is read before the secrets are covered, so that a secret that straddles the limit is covered whole. */
const SLACK_CHARS = 1024;

/** A name written in camel case ("accessToken") as the words that the rule for secret names knows ("access_token"). */
const words = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
const secretField = (name: string): boolean => isSecretName(words(name));

function decoded(text: string): string {
  try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; }
}

/** The address without what is secret in it: the user and password, the secret values, and the value of a parameter whose name is secret. */
export function hideUrl(url: string, redactions: readonly string[]): string {
  let out = redactValues(url, redactions);
  out = out.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, (_match, scheme: string) => `${scheme}${REDACTED}@`);
  const hash = out.indexOf('#');
  const fragment = hash < 0 ? '' : '#';
  if (hash >= 0) out = out.slice(0, hash);
  const question = out.indexOf('?');
  if (question >= 0) {
    const query = out.slice(question + 1).split('&').map(piece => {
      const equals = piece.indexOf('=');
      return equals < 0 || !secretField(decoded(piece.slice(0, equals))) ? piece : `${piece.slice(0, equals + 1)}${REDACTED}`;
    });
    out = `${out.slice(0, question + 1)}${query.join('&')}`;
  }
  return printable(out + fragment);
}

/** A string value of a JSON text whose key says it is secret: `"access_token": "..."`. */
const JSON_FIELD = /"((?:[^"\\\r\n]|\\.){1,100})"(\s*:\s*)"(?:[^"\\\r\n]|\\.)*"/g;

/** The text of a body with the secrets covered: the values that are known, and the fields (of JSON or of a form) whose names say they are secret. */
export function hideSecrets(text: string, redactions: readonly string[]): string {
  const covered = redactValues(text, redactions);
  const json = covered.replace(JSON_FIELD, (match, key: string, separator: string) => (secretField(key) ? `"${key}"${separator}"${REDACTED}"` : match));
  const pieces = json.trim().split('&');
  if (json.length > 0 && pieces.every(piece => /^[^\s=]{1,100}=\S*$/.test(piece))) {
    return pieces.map(piece => {
      const equals = piece.indexOf('=');
      return secretField(decoded(piece.slice(0, equals))) ? `${piece.slice(0, equals + 1)}${REDACTED}` : piece;
    }).join('&');
  }
  return json;
}

/** The first characters of a body, with the secrets covered; `cut` says that there was more. A body is never cut in the middle of a character. */
function bodyOf(text: string, redactions: readonly string[]): { text: string; cut: boolean } {
  const limit = HISTORY_LIMITS.bodyChars;
  const hidden = hideSecrets(text.length > limit + SLACK_CHARS ? text.slice(0, limit + SLACK_CHARS) : text, redactions);
  if (hidden.length <= limit) return { text: printable(hidden), cut: text.length > limit + SLACK_CHARS };
  let end = limit;
  const last = hidden.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: printable(hidden.slice(0, end)), cut: true };
}

type Pairs = readonly (readonly [string, string])[];

function headersOf(headers: Pairs, redactions: readonly string[]): [string, string][] {
  return headers.slice(0, HISTORY_LIMITS.headers).map(([name, value]): [string, string] => [
    printable(name.slice(0, 200)), printable(redactedValue(name, value.length > HISTORY_LIMITS.textChars ? value.slice(0, HISTORY_LIMITS.textChars) : value, redactions))
  ]);
}

export interface HistoryInput {
  id: string;
  /** When it was sent, in milliseconds since 1970. */
  at: number;
  /** How long it took, in milliseconds. */
  ms: number;
  name: string;
  path: string;
  environment: string;
  method: string;
  url: string;
  /** Values to cover wherever they appear. */
  redactions: readonly string[];
  /** The request as it went out, for the mode "full". */
  sent?: { headers: Pairs; body: string };
  /** What came back; absent when nothing did. */
  answer?: { status: number; statusText: string; size: number; headers: Pairs; body: string };
  /** Why nothing came back. */
  error?: string;
}

/** The entry to keep for a send, or nothing when the mode is "off". */
export function buildEntry(input: HistoryInput, mode: HistoryMode): HistoryEntry | undefined {
  if (mode === 'off') return undefined;
  const entry: HistoryEntry = {
    id: input.id, at: input.at, name: printable(input.name.slice(0, 200)), path: printable(input.path.slice(0, 500)), environment: printable(input.environment.slice(0, 100)),
    method: printable(input.method.slice(0, 20)), url: hideUrl(input.url, input.redactions).slice(0, 4000), ms: Math.max(0, Math.round(input.ms))
  };
  const answer = input.answer;
  if (answer !== undefined) {
    entry.status = answer.status;
    entry.statusText = printable(answer.statusText.slice(0, 100));
    entry.size = answer.size;
  }
  if (input.error !== undefined) entry.error = redactValues(printable(input.error.slice(0, 500)), input.redactions);
  if (mode === 'full') {
    const request = bodyOf(input.sent?.body ?? '', input.redactions);
    const response = bodyOf(answer?.body ?? '', input.redactions);
    const detail: HistoryDetail = {
      requestHeaders: headersOf(input.sent?.headers ?? [], input.redactions), requestBody: request.text,
      responseHeaders: headersOf(answer?.headers ?? [], input.redactions), responseBody: response.text, cut: request.cut || response.cut
    };
    entry.detail = detail;
  }
  return entry;
}
