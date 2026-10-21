import { hideSecrets, hideUrl, redactedValue, redactValues } from '../core/redact';
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

// The rules that cover the secrets of an address and of a body are in core/redact.ts, where the Code tab uses them too.
export { hideSecrets, hideUrl };

export const readMode = (value: unknown): HistoryMode => (value === 'off' || value === 'full' ? value : 'metadata');

/** How far past the limit a body is read before the secrets are covered, so that a secret that straddles the limit is covered whole. */
const SLACK_CHARS = 1024;

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
