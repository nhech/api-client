import { hideSecrets, hideUrl, isSecretName, REDACTED, redactedValue, redactValues } from '../core/redact';
import type { CodeBody, CodeRequest } from '../codegen';
import type { WireRequest } from '../engine/types';
import { printable } from '../util/chars';

/**
 * The request as the Code tab shows it: the request that would be sent, with the variables replaced and every secret value (the ones the request
 * was built from) written as `[redacted]`, so that a snippet that is pasted into a chat or a ticket does not carry a token. What the person
 * has to put back is said above the code.
 */
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const baseName = (path: string): string => path.split(/[\\/]/).filter(part => part !== '').pop() ?? 'file';

function decodeForm(text: string): [string, string][] | undefined {
  if (text === '') return undefined;
  const pairs: [string, string][] = [];
  for (const piece of text.split('&')) {
    if (piece === '') continue;
    const at = piece.indexOf('=');
    try { pairs.push([decodeURIComponent((at < 0 ? piece : piece.slice(0, at)).replace(/\+/g, ' ')), decodeURIComponent((at < 0 ? '' : piece.slice(at + 1)).replace(/\+/g, ' '))]); } catch { return undefined; }
  }
  return pairs;
}

/** The value of a header for the code: a credential keeps its scheme (`Bearer [redacted]`), so that the person knows what to put back. */
function headerForCode(name: string, value: string, redactions: readonly string[]): string {
  if (!isSecretName(name)) return redactedValue(name, value, redactions);
  const scheme = /^(?:Bearer|Basic|Digest|Token|OAuth|Negotiate|NTLM)\s+/i.exec(value);
  return `${scheme === null ? '' : scheme[0]}${REDACTED}`;
}

export function codeRequestFrom(wire: WireRequest, redactions: readonly string[]): CodeRequest {
  const hide = (text: string): string => printable(redactValues(text, redactions));
  // A secret is covered by what it is (a value the request was built from) and by what it is called (a header, a field, a parameter): a token that was typed straight into a header is no variable.
  const headers = wire.headers.map(([name, value]): [string, string] => [printable(name), printable(headerForCode(name, value, redactions))]);
  const type = wire.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const request: CodeRequest = { method: printable(wire.method), url: printable(hideUrl(wire.url, redactions)), headers };
  const body = wire.body;
  if (body === undefined) return request;
  let shown: CodeBody;
  if (body.kind === 'file') shown = { kind: 'file', path: `./${printable(baseName(body.path))}` };
  else if (body.kind === 'multipart') {
    shown = { kind: 'multipart', parts: body.parts.map(part => (part.filePath !== undefined
      ? { name: printable(part.name), file: `./${printable(baseName(part.filePath))}`, ...(part.filename === undefined ? {} : { filename: printable(part.filename) }), ...(part.contentType === undefined ? {} : { contentType: printable(part.contentType) }) }
      : { name: printable(part.name), value: printable(redactedValue(part.name, part.value ?? '', redactions)), ...(part.contentType === undefined ? {} : { contentType: printable(part.contentType) }) })) };
  } else {
    let text: string | undefined;
    try { text = textDecoder.decode(body.bytes); } catch { text = undefined; }
    if (text === undefined) shown = { kind: 'binary', size: body.bytes.length };
    else {
      const fields = type.toLowerCase().startsWith('application/x-www-form-urlencoded') ? decodeForm(text) : undefined;
      shown = fields === undefined ? { kind: 'text', text: printable(hideSecrets(text, redactions)) } : { kind: 'form', fields: fields.map(([name, value]): [string, string] => [hide(name), printable(redactedValue(name, value, redactions))]) };
    }
  }
  request.body = shown;
  return request;
}

/** What to tell the person about the code, in a line each. */
export function codeNotes(warnings: readonly string[], redacted: boolean): string[] {
  const notes = warnings.map(printable);
  if (redacted) notes.push(`Secret values are written as ${REDACTED}: put them back before running the code.`);
  return notes;
}
