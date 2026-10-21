import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { printable } from '../util/chars';

/**
 * The place the provider sends the person back to after they signed in, for the authorization code grant: a server on this computer, on
 * 127.0.0.1 only (and ::1 too when the registered address says `localhost`, which a browser may resolve to either), that waits for one answer and closes. What it accepts is narrow so that nothing else on the machine or the network can
 * steer it: a request for the one path that was agreed, with the `Host` header of the address that was agreed (a page of the web cannot
 * reach it through a name that points here), and the `state` that was made for this attempt (a request without it, or with another, is
 * answered and ignored: it does not end the wait). It reads no body, answers with a fixed page that repeats nothing of the request, and
 * gives up after a time.
 */
export interface LoopbackOptions {
  /** The address that is registered with the provider, such as `http://127.0.0.1:8765/callback`; with none, a free port and `/callback` are used. */
  redirectUrl?: string;
  /** The value of `state` that comes back with the answer. */
  state: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type LoopbackResult = { ok: true; code: string } | { ok: false; error: string };

export interface Loopback {
  /** What to give the provider as the place to send the person back to. */
  redirectUri: string;
  /** The address the server listens on: only this computer. */
  listeningOn: string;
  result: Promise<LoopbackResult>;
  close(): void;
}

export const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CODE_CHARS = 4096;
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signed in</title></head><body><p>You can close this tab and go back to VS Code.</p></body></html>';
const REFUSED = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not accepted</title></head><body><p>This request was not accepted.</p></body></html>';

function same(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(res: ServerResponse, status: number, page: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
  res.end(page);
}

/** Starts listening; resolves when the server is up, so that the address is known before the person is sent anywhere. */
export async function startLoopback(options: LoopbackOptions): Promise<Loopback> {
  let host = '127.0.0.1';
  let port = 0;
  let path = '/callback';
  if (options.redirectUrl !== undefined && options.redirectUrl.trim() !== '') {
    let url: URL;
    try { url = new URL(options.redirectUrl); } catch { throw new Error('The redirect address is not a whole address.'); }
    if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') || url.port === '' || Number(url.port) < 1 || url.search !== '' || url.hash !== '') {
      throw new Error('The redirect address has to be http://127.0.0.1:PORT/PATH or http://localhost:PORT/PATH, on this computer, with a port.');
    }
    host = url.hostname;
    port = Number(url.port);
    path = url.pathname;
  }

  let finish: (result: LoopbackResult) => void = () => undefined;
  const result = new Promise<LoopbackResult>(resolve => { finish = resolve; });
  const make = (): Server => {
    const created = createServer({ maxHeaderSize: 8 * 1024 });
    created.headersTimeout = 10_000;
    created.requestTimeout = 10_000;
    return created;
  };
  const server = make();
  /** The same server on ::1, for an address with the name `localhost`: a process of someone else must not be able to take the answer by listening there. */
  const others: Server[] = [];
  let done = false;
  const waiting: { timer?: NodeJS.Timeout } = {};
  const end = (outcome: LoopbackResult): void => {
    if (done) return;
    done = true;
    if (waiting.timer !== undefined) clearTimeout(waiting.timer);
    options.signal?.removeEventListener('abort', onAbort);
    // The page that tells the person to go back is sent first; then the server is closed, which ends the waiting connection too.
    setImmediate(() => { for (const each of [server, ...others]) { each.close(); each.closeAllConnections(); } });
    finish(outcome);
  };
  const onAbort = (): void => end({ ok: false, error: 'cancelled' });

  let expectedHost = '';
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (done) { reply(res, 410, REFUSED); return; }
    if (req.headers.host !== expectedHost) { reply(res, 400, REFUSED); return; }
    if (req.method !== 'GET') { reply(res, 405, REFUSED); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${expectedHost}`); } catch { reply(res, 400, REFUSED); return; }
    if (url.pathname !== path) { reply(res, 404, REFUSED); return; }
    if (!same(url.searchParams.get('state') ?? '', options.state)) { reply(res, 400, REFUSED); return; }
    const error = url.searchParams.get('error');
    if (error !== null) {
      const why = url.searchParams.get('error_description');
      reply(res, 200, PAGE);
      end({ ok: false, error: `The provider refused: ${printable(error).slice(0, 100)}${why === null ? '' : ` (${printable(why).slice(0, 200)})`}.` });
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '' || code.length > MAX_CODE_CHARS) { reply(res, 400, REFUSED); end({ ok: false, error: 'The provider sent no code back.' }); return; }
    reply(res, 200, PAGE);
    end({ ok: true, code });
  };
  server.on('request', onRequest);

  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException): void => { reject(new Error(error.code === 'EADDRINUSE' ? `The port ${port} is already in use, so the redirect address cannot be listened on.` : `Could not listen on this computer: ${error.message}`)); };
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(); });
  });
  if (host === 'localhost') {
    const second = make();
    second.on('request', onRequest);
    try {
      await new Promise<void>((resolve, reject) => { second.once('error', reject); second.listen(port, '::1', () => { second.off('error', reject); resolve(); }); });
      others.push(second);
    } catch (error) {
      // Another process holds the port on ::1: the answer could go to it, so there is no safe place to wait. No IPv6 on this machine is no problem: nothing can reach it there.
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') { server.close(); throw new Error(`The port ${port} is already in use on ::1, which localhost can also mean, so the redirect address cannot be listened on safely. Use 127.0.0.1 in the address, or another port.`); }
    }
  }
  const address = server.address();
  const actual = typeof address === 'object' && address !== null ? address.port : port;
  expectedHost = `${host}:${actual}`;
  waiting.timer = setTimeout(() => { end({ ok: false, error: 'No answer came back in time.' }); }, options.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
  if (options.signal?.aborted === true) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
  return {
    redirectUri: options.redirectUrl !== undefined && options.redirectUrl.trim() !== '' ? options.redirectUrl : `http://127.0.0.1:${actual}${path}`,
    result,
    listeningOn: typeof address === 'object' && address !== null ? address.address : '',
    close: () => { end({ ok: false, error: 'cancelled' }); }
  };
}
