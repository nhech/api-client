import { REDACTED, redactValues } from '../core/redact';
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

export function codeRequestFrom(wire: WireRequest, redactions: readonly string[]): CodeRequest {
  const hide = (text: string): string => printable(redactValues(text, redactions));
  const headers = wire.headers.map(([name, value]): [string, string] => [printable(name), hide(value)]);
  const type = wire.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const request: CodeRequest = { method: printable(wire.method), url: hide(wire.url), headers };
  const body = wire.body;
  if (body === undefined) return request;
  let shown: CodeBody;
  if (body.kind === 'file') shown = { kind: 'file', path: `./${printable(baseName(body.path))}` };
  else if (body.kind === 'multipart') {
    shown = { kind: 'multipart', parts: body.parts.map(part => (part.filePath !== undefined
      ? { name: printable(part.name), file: `./${printable(baseName(part.filePath))}`, ...(part.filename === undefined ? {} : { filename: printable(part.filename) }), ...(part.contentType === undefined ? {} : { contentType: printable(part.contentType) }) }
      : { name: printable(part.name), value: hide(part.value ?? ''), ...(part.contentType === undefined ? {} : { contentType: printable(part.contentType) }) })) };
  } else {
    let text: string | undefined;
    try { text = textDecoder.decode(body.bytes); } catch { text = undefined; }
    if (text === undefined) shown = { kind: 'binary', size: body.bytes.length };
    else {
      const fields = type.toLowerCase().startsWith('application/x-www-form-urlencoded') ? decodeForm(text) : undefined;
      shown = fields === undefined ? { kind: 'text', text: hide(text) } : { kind: 'form', fields: fields.map(([name, value]): [string, string] => [hide(name), hide(value)]) };
    }
  }
  request.body = shown;
  return request;
}

/** What to tell the person about the code, in a line each. */
export function codeNotes(warnings: readonly string[], redactions: readonly string[]): string[] {
  const notes = warnings.map(printable);
  if (redactions.length > 0) notes.push(`Secret values are written as ${REDACTED}: put them back before running the code.`);
  return notes;
}
