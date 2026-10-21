import type { CookieJar } from '../../src/core/cookies';
import { send } from '../../src/engine/send';
import type { SendOptions } from '../../src/engine/send';
import type { ProxyConfig } from '../../src/engine/proxy';
import type { WireRequest } from '../../src/engine/types';
import { HTTP_PER_RUN, parseHttpArgument } from '../../src/script/outcome';
import type { HostOps } from '../../src/script/protocol';
import { responseForScripts, SCRIPT_BODY_LIMIT } from '../../src/view/scripts';

/**
 * What the extension does for a script when it asks: wait a while, and send a request (`pm.sendRequest`). Both are looked up by name in
 * the list below and nowhere else; the argument comes from the engine of the script and is checked before anything is done with it.
 */

/** The longest a script may make the run wait in one call. */
export const MAX_SLEEP_MS = 5000;
/** The longest a request of a script may take. */
export const MAX_REQUEST_MS = 30_000;

export interface OperationContext {
  /** The options the settings of the request decide: the timeout, the redirects, the certificate check. */
  options: Pick<SendOptions, 'timeoutMs' | 'followRedirects' | 'maxRedirects' | 'tls'>;
  signal: AbortSignal;
  proxy: ProxyConfig;
  /** The cookie jar, when the request keeps cookies. */
  jar: CookieJar | undefined;
}

const encoder = new TextEncoder();

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(new Error('cancelled')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The operations for one run of scripts. The count of requests is the run's own: the next run starts again from none. */
export function scriptOperations(context: OperationContext): HostOps {
  let requests = 0;
  return {
    sleep: async argument => {
      const asked = Number(argument);
      await wait(Number.isFinite(asked) ? Math.min(Math.max(asked, 0), MAX_SLEEP_MS) : 0, context.signal);
      return '';
    },
    http: async argument => {
      if (++requests > HTTP_PER_RUN) throw new Error(`a script may send at most ${HTTP_PER_RUN} requests`);
      const parsed = parseHttpArgument(argument);
      if (!parsed.ok) throw new Error(parsed.error);
      const { method, url, headers, body } = parsed.value;
      const wire: WireRequest = { method, url, headers, ...(body === undefined ? {} : { body: { kind: 'bytes' as const, bytes: encoder.encode(body) } }) };
      const response = await send(wire, {
        ...context.options, timeoutMs: Math.min(context.options.timeoutMs, MAX_REQUEST_MS), responseLimitBytes: SCRIPT_BODY_LIMIT,
        signal: context.signal, proxy: context.proxy, ...(context.jar === undefined ? {} : { cookies: context.jar })
      });
      const bytes = response.body.kind === 'memory' ? response.body.bytes : new Uint8Array(0);
      return JSON.stringify(responseForScripts(response, bytes));
    }
  };
}
