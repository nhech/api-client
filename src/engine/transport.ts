import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as disk } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { prepareBody } from './body';
import { refuseLocalAddresses } from './lookup';
import { openTunnel, proxyAuthorization, type ResolvedProxy } from './proxy';
import { Counter, DecodedGuard, decodersFor, type DecodeLimits } from './decode';
import { EngineError, type HeaderList, type ResponseBody, type TlsInfo, type TlsOptions, type Timings, type WireRequest, type WireResponse } from './types';

/**
 * One request and one response over one connection, with no redirects and no cookies (src/engine/send.ts does those). A new
 * connection is made each time, so every phase of the timing is measured and no state is shared between requests.
 */
export interface ExchangeOptions {
  /** Ends the exchange when it aborts; its reason (an EngineError for a timeout) is what the caller sees. */
  signal: AbortSignal;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  tls: TlsOptions;
  /** The body stays in memory up to this many bytes. */
  responseLimitBytes: number;
  /** Past the limit the body goes to a file in `dir`, up to `maxBytes`; without it the body is cut at the limit. */
  spill?: { dir: string; maxBytes: number };
  decode: DecodeLimits;
  /** Decides, from the status line and headers, whether the body is read or thrown away (a redirect that will be followed). */
  body: (status: number, headers: HeaderList) => 'read' | 'discard';
  /** Makes the connection itself; the default connects directly. */
  createConnection?: http.RequestOptions['createConnection'];
  /** Sends the request through this proxy: an http address with its whole address as the path, an https address through a tunnel. */
  proxy?: ResolvedProxy;
  /** The address that the name resolves to must not be on this machine or a link-local one (the request is the hop of a redirect from a public address). Without a proxy only: a proxy resolves the name itself. */
  refuseLocalAddresses?: boolean;
}

/** `remoteAddress` is the address that the connection was really made to (the proxy's, behind a proxy). */
export type ExchangeResult = Omit<WireResponse, 'redirects' | 'finalUrl' | 'sent'> & { remoteAddress?: string };

const now = (): number => performance.now();

/** Names with several values go out as several header lines, in the order of their first appearance, with the spelling the person wrote. */
function headerObject(headers: HeaderList, contentLength: number | undefined, method: string): http.OutgoingHttpHeaders {
  const grouped = new Map<string, { name: string; values: string[] }>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (key === 'content-length' || key === 'transfer-encoding') continue;
    const entry = grouped.get(key);
    if (entry === undefined) grouped.set(key, { name, values: [value] });
    else entry.values.push(value);
  }
  const out: http.OutgoingHttpHeaders = {};
  for (const { name, values } of grouped.values()) out[name] = values.length === 1 ? (values[0] as string) : values;
  if (contentLength !== undefined) out['Content-Length'] = String(contentLength);
  else if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) out['Content-Length'] = '0';
  return out;
}

/** What an aborted request reports: the timeout that ended it, or a plain cancellation. */
export function abortReason(signal: AbortSignal): EngineError {
  const reason: unknown = signal.reason;
  return reason instanceof EngineError ? reason : new EngineError('aborted', 'The request was cancelled.');
}

export function describeNetworkError(error: unknown, url: URL, proxy?: ResolvedProxy): EngineError {
  if (error instanceof EngineError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  // A connection that failed on its way to a proxy is the proxy's failure, not the server's.
  if (proxy !== undefined && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return new EngineError('proxy', `Could not reach the proxy ${proxy.host}:${proxy.port} (${code}).`, 'Check the proxy address, your network and the proxy settings.');
  }
  const message = error instanceof Error ? error.message : String(error);
  const host = url.host;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new EngineError('dns', `The name ${url.hostname} could not be found.`, 'Check the address, your network and your DNS.');
  if (code === 'ECONNREFUSED') return new EngineError('refused', `${host} refused the connection.`, 'Check that the server is running and the port is right.');
  if (code === 'ECONNRESET' || code === 'EPIPE') return new EngineError('reset', `The connection to ${host} was closed before the response was complete.`, 'Try again; if it keeps happening the server or a proxy is dropping the request.');
  if (code === 'ETIMEDOUT') return new EngineError('timeout', `${host} did not answer.`, 'Check the address and your network.');
  // The words of OpenSSL for a certificate bundle that cannot be opened: older versions say "mac verify failure" or "bad decrypt", newer ones "INCORRECT_PASSWORD".
  if (/mac verify failure|bad decrypt|PKCS12|passphrase|bad password|incorrect.?password/i.test(message)) return new EngineError('tls', `The client certificate could not be read: ${message}`, 'Check the file of the certificate and its passphrase.');
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new EngineError('network', `${host} cannot be reached from this machine.`, 'Check your network, VPN and proxy.');
  if (/^(?:CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_TLS_CERT|ERR_SSL|HOSTNAME_MISMATCH|EPROTO)/.test(code) || /certificate|self.signed|SSL|TLS/i.test(message)) {
    return new EngineError('tls', `The secure connection to ${host} failed: ${message}`, 'If the server uses its own certificate authority, add it in the settings; checking can be switched off for a request, but then nothing proves who answered.');
  }
  if (code.startsWith('HPE_')) return new EngineError('bad-response', `${host} sent something that is not a valid HTTP response (${code}).`);
  if (code === 'ERR_INVALID_CHAR' || code === 'ERR_INVALID_HTTP_TOKEN' || code === 'ERR_HTTP_INVALID_HEADER_VALUE') return new EngineError('invalid-request', `The request has a header that cannot be sent: ${message}`);
  return new EngineError('network', message);
}

function tlsInfoOf(socket: unknown): TlsInfo | undefined {
  const tls = socket as TLSSocket | undefined;
  if (tls === undefined || typeof tls.getProtocol !== 'function') return undefined;
  const certificate = tls.getPeerCertificate();
  const info: TlsInfo = { protocol: tls.getProtocol() ?? '', cipher: tls.getCipher()?.name ?? '', authorized: tls.authorized };
  if (tls.authorizationError !== undefined && tls.authorizationError !== null) info.authorizationError = String(tls.authorizationError);
  if (certificate !== undefined && certificate !== null && Object.keys(certificate).length > 0) {
    const name = (value: Record<string, unknown> | undefined): string | undefined => (value?.['CN'] as string | undefined) ?? (value?.['O'] as string | undefined);
    const subject = name(certificate.subject as unknown as Record<string, unknown>);
    const issuer = name(certificate.issuer as unknown as Record<string, unknown>);
    if (subject !== undefined) info.subject = subject;
    if (issuer !== undefined) info.issuer = issuer;
    if (certificate.valid_to !== undefined) info.validTo = certificate.valid_to;
  }
  return info;
}

/** Collects a body in memory, spilling to a file past the limit, or cutting it. */
class Collector extends Writable {
  readonly chunks: Buffer[] = [];
  size = 0;
  truncated = false;
  spillPath: string | undefined;
  private file: ReturnType<typeof createWriteStream> | undefined;
  private fileEnded = false;

  constructor(private readonly limit: number, private readonly spill: ExchangeOptions['spill'], private readonly stop: () => void) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.file === undefined && this.size + chunk.length <= this.limit) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      done();
      return;
    }
    if (this.spill === undefined) {
      const room = this.limit - this.size;
      if (room > 0) { this.chunks.push(chunk.subarray(0, room)); this.size += room; }
      this.truncated = true;
      this.stop();
      done();
      return;
    }
    const spill = this.spill;
    const open = async (): Promise<void> => {
      if (this.file === undefined) {
        await disk.mkdir(spill.dir, { recursive: true });
        this.spillPath = join(spill.dir, `response-${randomBytes(8).toString('hex')}.body`);
        this.file = createWriteStream(this.spillPath, { flags: 'wx', mode: 0o600 });
        this.file.on('error', error => this.destroy(error));
        for (const held of this.chunks) this.file.write(held);
        this.chunks.length = 0;
      }
    };
    open().then(() => {
      if (this.destroyed) { done(); return; }
      const file = this.file as ReturnType<typeof createWriteStream>;
      const room = spill.maxBytes - this.size;
      const piece = chunk.length <= room ? chunk : chunk.subarray(0, Math.max(0, room));
      const cut = piece.length < chunk.length;
      this.size += piece.length;
      if (cut) {
        // The file is closed, with everything written, before the response is dropped: nothing is left half flushed.
        this.truncated = true;
        file.write(piece);
        this.closeFile(() => { this.stop(); done(); });
        return;
      }
      if (!file.write(piece)) file.once('drain', () => done()); else done();
    }, error => done(error as Error));
  }

  /** Ends the file once and waits until it is on disk. */
  private closeFile(done: () => void): void {
    if (this.file === undefined || this.fileEnded) { done(); return; }
    this.fileEnded = true;
    this.file.end(() => done());
  }

  override _final(done: (error?: Error | null) => void): void {
    this.closeFile(() => done());
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.fileEnded) this.file?.destroy();
    callback(error);
  }
}

export async function exchange(request: WireRequest, options: ExchangeOptions): Promise<ExchangeResult> {
  let url: URL;
  try { url = new URL(request.url); } catch { throw new EngineError('invalid-url', `${request.url} is not a valid address.`, 'An address starts with http:// or https://.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EngineError('invalid-url', `Only http and https addresses can be requested, not ${url.protocol}`);
  if (url.hostname === '') throw new EngineError('invalid-url', `${request.url} has no host.`);
  const secure = url.protocol === 'https:';
  const prepared = await prepareBody(request.body);
  const method = request.method.toUpperCase();
  const started = now();
  const marks: { lookup?: number; connect?: number; secure?: number; sent?: number; response?: number } = {};
  if (options.signal.aborted) throw abortReason(options.signal);

  return new Promise<ExchangeResult>((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const headers = headerObject(request.headers, prepared?.length, method);
    const proxy = options.proxy;
    const requestOptions: https.RequestOptions = {
      method, hostname, port: url.port === '' ? undefined : Number(url.port), path: `${url.pathname}${url.search}`, agent: false, headers, signal: options.signal,
      ...(options.createConnection === undefined ? {} : { createConnection: options.createConnection }),
      ...(options.refuseLocalAddresses === true && proxy === undefined ? { lookup: refuseLocalAddresses() as unknown as https.RequestOptions['lookup'] } : {})
    };
    if (proxy !== undefined && !secure) {
      // A plain request through a proxy names the whole address, and the proxy gets its own credentials.
      requestOptions.hostname = proxy.host;
      requestOptions.port = proxy.port;
      requestOptions.path = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
      if (!Object.keys(headers).some(name => name.toLowerCase() === 'host')) headers['Host'] = url.host;
      const credential = proxyAuthorization(proxy);
      if (credential !== undefined) headers['Proxy-Authorization'] = credential;
    }
    if (secure) {
      requestOptions.rejectUnauthorized = options.tls.rejectUnauthorized;
      requestOptions.minVersion = 'TLSv1.2';
      if (options.tls.ca !== undefined && options.tls.ca.length > 0) requestOptions.ca = options.tls.ca;
      if (options.tls.cert !== undefined) requestOptions.cert = options.tls.cert;
      if (options.tls.key !== undefined) requestOptions.key = options.tls.key;
      if (options.tls.pfx !== undefined) requestOptions.pfx = Buffer.from(options.tls.pfx);
      if (options.tls.passphrase !== undefined) requestOptions.passphrase = options.tls.passphrase;
      if (!/^[\d.]+$/.test(hostname) && !hostname.includes(':')) requestOptions.servername = hostname;
      if (proxy !== undefined) {
        // A tunnel to the server, and the handshake inside it: the proxy sees only the name and port it is asked to reach.
        const port = url.port === '' ? 443 : Number(url.port);
        delete requestOptions.agent;
        requestOptions.createConnection = (_options, callback) => {
          openTunnel(proxy, { host: hostname, port }, { signal: options.signal, timeoutMs: options.connectTimeoutMs }).then(raw => {
            const secureSocket = tlsConnect({
              socket: raw, ...(requestOptions.servername === undefined ? {} : { servername: requestOptions.servername }), rejectUnauthorized: options.tls.rejectUnauthorized, minVersion: 'TLSv1.2',
              ...(requestOptions.ca === undefined ? {} : { ca: requestOptions.ca }), ...(requestOptions.cert === undefined ? {} : { cert: requestOptions.cert }), ...(requestOptions.key === undefined ? {} : { key: requestOptions.key }),
              ...(requestOptions.pfx === undefined ? {} : { pfx: requestOptions.pfx }), ...(requestOptions.passphrase === undefined ? {} : { passphrase: requestOptions.passphrase })
            });
            secureSocket.once('secureConnect', () => callback(null, secureSocket));
            secureSocket.once('error', error => callback(error, secureSocket));
          }, (error: unknown) => callback(error as Error, undefined as never));
          return undefined;
        };
      }
    }
    let connectTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      reject(options.signal.aborted ? abortReason(options.signal) : describeNetworkError(error, url, secure ? undefined : options.proxy));
    };

    let req: http.ClientRequest;
    try {
      req = (secure ? https : http).request(requestOptions);
    } catch (error) {
      fail(error);
      return;
    }
    req.on('error', fail);
    req.on('socket', socket => {
      if (socket.connecting) {
        connectTimer = setTimeout(() => req.destroy(new EngineError('timeout', `Could not connect to ${url.host} within ${Math.round(options.connectTimeoutMs / 1000)} s.`, 'Check the address, your network and any proxy.')), options.connectTimeoutMs);
        socket.once('lookup', () => { marks.lookup = now(); });
        socket.once('connect', () => { marks.connect = now(); if (!secure && connectTimer !== undefined) clearTimeout(connectTimer); });
        socket.once('secureConnect', () => { marks.secure = now(); if (connectTimer !== undefined) clearTimeout(connectTimer); });
      }
    });
    req.setTimeout(options.idleTimeoutMs, () => req.destroy(new EngineError('timeout', `${url.host} sent nothing for ${Math.round(options.idleTimeoutMs / 1000)} s.`, 'Raise the timeout in the settings if the server is slow.')));
    req.on('finish', () => { marks.sent = now(); });

    req.on('response', res => {
      marks.response = now();
      const remoteAddress = res.socket?.remoteAddress;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      const headers: HeaderList = [];
      for (let index = 0; index + 1 < res.rawHeaders.length; index += 2) headers.push([res.rawHeaders[index] as string, res.rawHeaders[index + 1] as string]);
      const status = res.statusCode ?? 0;
      const base = { status, statusText: res.statusMessage ?? '', httpVersion: res.httpVersion, headers };
      const tlsInfo = secure ? tlsInfoOf(res.socket) : undefined;
      const timings = (finished: number): Timings => {
        const lookup = marks.lookup !== undefined ? marks.lookup - started : 0;
        const connectFrom = marks.lookup ?? started;
        const connect = marks.connect !== undefined ? marks.connect - connectFrom : 0;
        const tls = marks.secure !== undefined && marks.connect !== undefined ? marks.secure - marks.connect : 0;
        return {
          dnsMs: lookup, connectMs: connect, tlsMs: tls, ttfbMs: Math.max(0, (marks.response ?? finished) - (marks.sent ?? marks.response ?? finished)),
          downloadMs: Math.max(0, finished - (marks.response ?? finished)), totalMs: finished - started
        };
      };
      const warnings: string[] = [];
      if (tlsInfo !== undefined && !tlsInfo.authorized) warnings.push(`The certificate of ${url.host} was not checked${tlsInfo.authorizationError !== undefined ? ` (${tlsInfo.authorizationError})` : ''}.`);
      const done = (body: ResponseBody, wireBytes: number, size: number, truncated: boolean): void => {
        if (settled) return;
        settled = true;
        resolve({ ...base, body, wireBytes, size, truncated, timings: timings(now()), ...(tlsInfo === undefined ? {} : { tls: tlsInfo }), warnings, ...(remoteAddress === undefined ? {} : { remoteAddress }) });
      };

      const noBody = method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200);
      // Always asked, even when there is no body: the caller decides about a redirect from the same call.
      const policy = options.body(status, headers);
      if (noBody || policy === 'discard') {
        res.destroy();
        done({ kind: 'memory', bytes: new Uint8Array(0) }, 0, 0, false);
        return;
      }

      const encodingHeader = headers.filter(([name]) => name.toLowerCase() === 'content-encoding').map(([, value]) => value).join(',');
      const { decoders, unsupported } = decodersFor(encodingHeader);
      if (unsupported.length > 0) warnings.push(`The body uses ${unsupported.join(', ')} encoding, which is not undone.`);
      const wire = new Counter();
      const guard = new DecodedGuard(wire, options.decode, decoders.length > 0);
      let stopped = false;
      const collector = new Collector(options.responseLimitBytes, options.spill, () => { stopped = true; res.destroy(); });
      const streams: (NodeJS.ReadableStream | NodeJS.WritableStream | NodeJS.ReadWriteStream)[] = [res, wire, ...decoders, guard, collector];
      pipeline(streams).then(() => undefined, (error: unknown) => {
        if (!stopped) throw error;
      }).then(() => {
        const body: ResponseBody = collector.spillPath !== undefined ? { kind: 'file', path: collector.spillPath } : { kind: 'memory', bytes: new Uint8Array(Buffer.concat(collector.chunks)) };
        done(body, wire.bytes, collector.size, collector.truncated);
      }, error => {
        if (collector.spillPath !== undefined) void disk.rm(collector.spillPath, { force: true });
        fail(error);
      });
    });

    if (prepared === undefined) req.end();
    else {
      const content = prepared.open();
      if (Buffer.isBuffer(content)) req.end(content);
      else {
        content.on('error', error => req.destroy(new EngineError('file', `The file could not be read while sending: ${error.message}`)));
        content.pipe(req);
      }
    }
  });
}
