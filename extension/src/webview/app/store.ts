import { signal } from '@preact/signals';
import type { Request } from '../../../../src/core/model';
import { applyEditOps } from '../../../../src/view/edit';
import type { EditOp, RequestState, ToHost, ToView } from '../../../../src/view/request-protocol';
import type { ResponseView } from '../../../../src/view/response';

/**
 * The state of the request editor page. The extension owns the file; the page keeps a copy that it changes at once when the
 * person types (so that nothing waits for a round trip) and sends the same edits to the extension, one message at a time. When
 * the extension answers, the page adopts its version unless the person has typed more since.
 */
export interface Host {
  postMessage(message: ToHost): void;
}

/** How the page talks to the extension. */
export interface HostPort {
  post(message: ToHost): void;
}

/** What the extension last said about the file. */
export const confirmed = signal<RequestState | undefined>(undefined);
/** The request as the person sees it: the confirmed one with the edits that have not been answered yet. */
export const request = signal<Request | undefined>(undefined);
/** Something the person should be told: an edit that was refused, a file that changed under their hands. */
export const notice = signal<string | undefined>(undefined);

/** Whether a request is on its way, and since when (to show how long it has taken). */
export const sending = signal<{ id: number; since: number } | undefined>(undefined);
/** The last answer, or why there is none. Both are cleared when the next send begins. */
export const response = signal<ResponseView | undefined>(undefined);
export const failure = signal<{ code: string; message: string; hint: string; warnings: string[] } | undefined>(undefined);

const FLUSH_DELAY_MS = 250;
let host: Host | undefined;
let queue: EditOp[] = [];
let inFlight = false;
/** Send was asked for while an edit was still on its way: it goes when the extension has answered, so that the request sent is the one on the screen. */
let sendWhenSettled = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export function connect(target: Host): void {
  host = target;
}

const samePath = (a: readonly (string | number)[], b: readonly (string | number)[]): boolean => a.length === b.length && a.every((part, index) => part === b[index]);

function flush(): void {
  if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  const current = confirmed.value;
  if (inFlight || queue.length === 0 || host === undefined || current === undefined) return;
  host.postMessage({ type: 'edit', rev: current.rev, ops: queue });
  queue = [];
  inFlight = true;
}

/** Applies the edits to the request on screen and sends them; typing is sent after a short pause. */
export function edit(...ops: EditOp[]): void {
  const current = request.value;
  if (current === undefined || confirmed.value?.readOnly !== undefined) return;
  const result = applyEditOps(current, ops);
  if (!result.ok) {
    notice.value = `That change was not made: ${result.reason}.`;
    return;
  }
  notice.value = undefined;
  request.value = result.request;
  for (const op of ops) {
    const last = queue[queue.length - 1];
    if (op.op === 'set' && last?.op === 'set' && samePath(last.path, op.path)) queue[queue.length - 1] = op;
    else queue.push(op);
  }
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(flush, FLUSH_DELAY_MS);
}

/** Sends what is waiting now (when a field loses focus). */
export function flushNow(): void {
  flush();
}

/** Sends the request, after the edits that came before it. */
export function sendNow(): void {
  if (sending.value !== undefined || host === undefined) return;
  flush();
  if (inFlight || queue.length > 0) { sendWhenSettled = true; return; }
  host.postMessage({ type: 'send' });
}

const same = (a: Request | undefined, b: Request | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

export function receive(message: ToView): void {
  if (message.type === 'init') {
    confirmed.value = message;
    request.value = message.request;
    queue = [];
    inFlight = false;
    sendWhenSettled = false;
    return;
  }
  if (message.type === 'sending') {
    sending.value = { id: message.id, since: Date.now() };
    response.value = undefined;
    failure.value = undefined;
    return;
  }
  if (message.type === 'response') {
    sending.value = undefined;
    response.value = message.response;
    return;
  }
  if (message.type === 'failed') {
    sending.value = undefined;
    failure.value = { code: message.code, message: message.message, hint: message.hint, warnings: message.warnings };
    return;
  }
  if (message.type === 'cancelled') {
    sending.value = undefined;
    return;
  }
  if (message.type === 'rejected') {
    inFlight = false;
    sendWhenSettled = false;
    queue = [];
    request.value = confirmed.value?.request;
    notice.value = `That change was not made: ${message.reason}.`;
    return;
  }
  const { type: _type, cause, ...state } = message;
  void _type;
  confirmed.value = state;
  if (cause === 'self') {
    inFlight = false;
    if (queue.length > 0) { flush(); return; }
    if (!same(request.value, state.request)) request.value = state.request;
    if (sendWhenSettled) { sendWhenSettled = false; sendNow(); }
    return;
  }
  // The file changed from outside: what was waiting to be sent is not applied, and the person is told.
  if (inFlight || queue.length > 0) notice.value = 'The file changed while you were editing, so your last change was not applied.';
  inFlight = false;
  sendWhenSettled = false;
  queue = [];
  request.value = state.request;
}
