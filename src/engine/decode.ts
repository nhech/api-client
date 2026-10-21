import { Transform, type TransformCallback } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate, createInflateRaw } from 'node:zlib';
import { EngineError } from './types';

/**
 * Undoing the content encoding of a response, and keeping a small response from turning into an enormous one. The limits are
 * on the decoded size and on the ratio between decoded and received bytes, checked while the data flows, so that a "bomb" is
 * stopped after a megabyte or two and never held in memory.
 */
export interface DecodeLimits {
  /** The most decoded bytes that are read at all. */
  maxBytes: number;
  /** Decoded bytes per received byte, checked once more than `ratioFloor` have been decoded. */
  maxRatio: number;
  ratioFloor: number;
}

export const DEFAULT_DECODE_LIMITS: DecodeLimits = { maxBytes: 1024 * 1024 * 1024, maxRatio: 100, ratioFloor: 4 * 1024 * 1024 };

/** A stream that counts the bytes that pass through it. */
export class Counter extends Transform {
  bytes = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    done(null, chunk);
  }
}

/** Counts decoded bytes and ends the stream with an error when a limit is passed. */
export class DecodedGuard extends Transform {
  bytes = 0;
  constructor(private readonly wire: Counter, private readonly limits: DecodeLimits, private readonly encoded: boolean) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limits.maxBytes) {
      done(new EngineError('too-large', `The response is larger than ${this.limits.maxBytes} bytes.`, 'Save it to a file with a smaller request, or raise the limit.'));
      return;
    }
    if (this.encoded && this.bytes > this.limits.ratioFloor && this.bytes > this.limits.maxRatio * Math.max(1, this.wire.bytes)) {
      done(new EngineError('too-large', `The response expands more than ${this.limits.maxRatio} times when decompressed, which is how a decompression bomb looks.`, 'It was not read any further.'));
      return;
    }
    done(null, chunk);
  }
}

/** `deflate` is a zlib stream by the standard and a raw deflate stream in practice; the first two bytes tell which. */
class InflateEither extends Transform {
  private inner: Transform | undefined;
  private head: Buffer = Buffer.alloc(0);

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.inner !== undefined) { this.inner.write(chunk, () => done()); return; }
    this.head = Buffer.concat([this.head, chunk]);
    if (this.head.length < 2) { done(); return; }
    const first = this.head[0] as number;
    const zlibHeader = (first & 0x0f) === 8 && ((first << 8) | (this.head[1] as number)) % 31 === 0;
    const inner = zlibHeader ? createInflate() : createInflateRaw();
    this.inner = inner;
    inner.on('data', data => { if (!this.push(data)) inner.pause(); });
    inner.on('error', error => this.destroy(error));
    inner.on('end', () => this.push(null));
    inner.write(this.head, () => done());
  }

  override _read(size: number): void {
    super._read(size);
    this.inner?.resume();
  }

  override _flush(done: TransformCallback): void {
    const inner = this.inner;
    if (inner === undefined) { done(); return; }
    inner.once('end', () => done());
    inner.end();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inner?.destroy();
    callback(error);
  }
}

const inflateEither = (): Transform => new InflateEither();

export interface Decoders {
  /** In the order the data must pass through them. */
  decoders: Transform[];
  /** Encodings that were not undone. */
  unsupported: string[];
}

/** The decoders for a `Content-Encoding` header: the codings were applied in the order listed, so they are undone in reverse. */
export function decodersFor(header: string | undefined): Decoders {
  const names = (header ?? '').split(',').map(part => part.trim().toLowerCase()).filter(part => part !== '' && part !== 'identity');
  const decoders: Transform[] = [];
  const unsupported: string[] = [];
  for (const name of names.reverse()) {
    if (name === 'gzip' || name === 'x-gzip') decoders.push(createGunzip());
    else if (name === 'deflate') decoders.push(inflateEither());
    else if (name === 'br') decoders.push(createBrotliDecompress());
    else unsupported.push(name);
  }
  return { decoders, unsupported };
}
