/**
 * What goes over the wire and what comes back. Everything here is plain data: the request has already had its variables
 * replaced and its authentication applied, and the response keeps the headers in the order and the spelling they arrived in.
 */
export type HeaderList = [name: string, value: string][];

export interface MultipartPart {
  name: string;
  /** A text field. */
  value?: string;
  /** A file part: an absolute path the caller has already confined to the workspace. */
  filePath?: string;
  filename?: string;
  contentType?: string;
}

export type WireBody =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'file'; path: string }
  | { kind: 'multipart'; boundary: string; parts: MultipartPart[] };

export interface WireRequest {
  method: string;
  /** Absolute, with the variables replaced. */
  url: string;
  headers: HeaderList;
  body?: WireBody;
}

export interface Timings {
  /** Each is 0 when it does not apply (no lookup for an address, no handshake for plain http). */
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  /** From the end of the request to the first byte of the response. */
  ttfbMs: number;
  downloadMs: number;
  totalMs: number;
}

export interface TlsInfo {
  protocol: string;
  cipher: string;
  /** False when the certificate was not accepted but the request went on because verification is off. */
  authorized: boolean;
  authorizationError?: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
}

export type ResponseBody =
  | { kind: 'memory'; bytes: Uint8Array }
  | { kind: 'file'; path: string };

export interface RedirectHop {
  url: string;
  status: number;
}

export interface WireResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HeaderList;
  body: ResponseBody;
  /** Bytes as they came over the wire, and after the content encoding was undone. */
  wireBytes: number;
  size: number;
  /** The body was cut at a limit; `size` is what was kept. */
  truncated: boolean;
  timings: Timings;
  redirects: RedirectHop[];
  finalUrl: string;
  /** The request as it went over the wire the last time: with the headers the engine added (User-Agent, Accept, Cookie) and the method and body after any redirect. */
  sent: WireRequest;
  tls?: TlsInfo;
  /** Things the person should know: a certificate that was not checked, a redirect that was not followed, an encoding that was not undone. */
  warnings: string[];
}

/** How a secure connection is made. Verification is on unless the request says otherwise. */
export interface TlsOptions {
  rejectUnauthorized: boolean;
  /** Certificate authorities to trust in addition to the system's, as PEM text. */
  ca?: string[];
  /** A client certificate and its key as PEM text, or a PKCS#12 bundle, and the passphrase for the key. */
  cert?: string;
  key?: string;
  pfx?: Uint8Array;
  passphrase?: string;
}

export type EngineErrorCode =
  | 'invalid-url'
  | 'invalid-request'
  | 'timeout'
  | 'aborted'
  | 'dns'
  | 'refused'
  | 'reset'
  | 'tls'
  | 'proxy'
  | 'too-large'
  | 'too-many-redirects'
  | 'bad-response'
  | 'file'
  | 'network';

/** A request that could not be completed, with a code the interface can act on and a sentence that says what to try. */
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string, readonly hint = '') {
    super(message);
    this.name = 'EngineError';
  }
}
