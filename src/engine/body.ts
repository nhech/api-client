import { createReadStream, promises as disk } from 'node:fs';
import { Readable } from 'node:stream';
import { EngineError, type MultipartPart, type WireBody } from './types';

/**
 * The body of a request as bytes to send and, when it is known, how many. A file is streamed from disk and never read whole;
 * a multipart body is built part by part, so that a large upload takes no more memory than a small one.
 */
export interface PreparedBody {
  /** The length that goes into Content-Length. */
  length: number;
  /** A fresh stream or buffer each time it is called, so that a 307 or 308 can send the same body again. */
  open(): Buffer | Readable;
}

const encoder = new TextEncoder();

/** A name or file name in a Content-Disposition header: the quote and the line breaks are written as the form-data standard says, so that a name can never end the header. */
export const escapeFormName = (value: string): string => value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');

function partHead(boundary: string, part: MultipartPart): Buffer {
  const lines = [`--${boundary}`, `Content-Disposition: form-data; name="${escapeFormName(part.name)}"${part.filePath !== undefined ? `; filename="${escapeFormName(part.filename ?? 'file')}"` : ''}`];
  if (part.contentType !== undefined && part.contentType !== '') lines.push(`Content-Type: ${part.contentType.replace(/[\r\n]/g, ' ')}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
}

async function fileSize(path: string): Promise<number> {
  try {
    const stats = await disk.stat(path);
    if (!stats.isFile()) throw new Error('not a file');
    return stats.size;
  } catch (error) {
    throw new EngineError('file', `The file ${path} cannot be sent: ${error instanceof Error ? error.message : 'unreadable'}.`, 'Check the path of the file in the request.');
  }
}

const CRLF = Buffer.from('\r\n');

export async function prepareBody(body: WireBody | undefined): Promise<PreparedBody | undefined> {
  if (body === undefined) return undefined;
  if (body.kind === 'bytes') {
    const bytes = Buffer.from(body.bytes);
    return { length: bytes.length, open: () => bytes };
  }
  if (body.kind === 'file') {
    const length = await fileSize(body.path);
    return { length, open: () => createReadStream(body.path) };
  }
  // multipart
  const closing = Buffer.from(`--${body.boundary}--\r\n`, 'utf8');
  const sizes = await Promise.all(body.parts.map(part => (part.filePath !== undefined ? fileSize(part.filePath) : Promise.resolve(encoder.encode(part.value ?? '').length))));
  const heads = body.parts.map(part => partHead(body.boundary, part));
  const length = heads.reduce((total, head, index) => total + head.length + (sizes[index] ?? 0) + CRLF.length, 0) + closing.length;
  const open = (): Readable => Readable.from((async function* chunks() {
    for (let index = 0; index < body.parts.length; index++) {
      const part = body.parts[index] as MultipartPart;
      yield heads[index] as Buffer;
      if (part.filePath !== undefined) yield* createReadStream(part.filePath);
      else yield Buffer.from(part.value ?? '', 'utf8');
      yield CRLF;
    }
    yield closing;
  })());
  return { length, open };
}
