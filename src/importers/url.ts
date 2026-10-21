import { indexOutsideVariables, splitOutsideVariables } from '../convert/text';
import type { KV } from '../core/model';

/**
 * The address of an imported request and its query. In the client the query is a list of rows that are added to the address when the request is
 * sent, so an address that arrives with its query written in it (`https://host/x?a=1&b=2`) is split: the address keeps what comes before the
 * `?`, and each pair becomes a row, which can be switched off or edited on its own. A `{{variable}}` is never split, and a fragment stays with
 * the address.
 */
const decoded = (text: string): string => {
  try { return decodeURIComponent(text); } catch { return text; }
};

export function splitUrl(raw: string): { url: string; query: KV[] } {
  let rest = raw;
  let fragment = '';
  const hash = indexOutsideVariables(rest, '#');
  if (hash >= 0) { fragment = rest.slice(hash); rest = rest.slice(0, hash); }
  const mark = indexOutsideVariables(rest, '?');
  if (mark < 0) return { url: raw, query: [] };
  const text = rest.slice(mark + 1);
  const query: KV[] = [];
  for (const piece of text === '' ? [] : splitOutsideVariables(text, '&')) {
    if (piece === '') continue;
    const equals = indexOutsideVariables(piece, '=');
    query.push({ name: decoded(equals < 0 ? piece : piece.slice(0, equals)), value: decoded(equals < 0 ? '' : piece.slice(equals + 1)), enabled: true, description: '' });
  }
  return { url: rest.slice(0, mark) + fragment, query };
}

/** A row of headers, query parameters or form fields. */
export const row = (name: string, value: string, enabled = true, description = ''): KV => ({ name, value, enabled, description });
