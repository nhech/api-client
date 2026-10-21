import { signal } from '@preact/signals';
import type { Container, Environment, Request } from '../../../../src/core/model';
import type { VariableInfo } from '../../../../src/core/vars';
import { applyEditOps, applyOps, containerCodec, ENVIRONMENT_CODEC } from '../../../../src/view/edit';
import type { AppScreen, DocumentState, EditOp, OAuthStatusView, RequestState, ToHost, ToView } from '../../../../src/view/request-protocol';
import type { ResponseView } from '../../../../src/view/response';
import type { ScriptReport } from '../../../../src/view/scripts';

/**
 * The state of the page. The extension owns the file; the page keeps a copy that it changes at once when the person types (so
 * that nothing waits for a round trip) and sends the same edits to the extension, one message at a time. When the extension
 * answers, the page adopts its version unless the person has typed more since. The same page draws the request editor, the
 * editor of an environment and the editor of a collection or folder; which one is in the data attribute of its body.
 */
export interface Host {
  postMessage(message: ToHost): void;
}

/** How the page talks to the extension. */
export interface HostPort {
  post(message: ToHost): void;
}

const readScreen = (): AppScreen => {
  const given = document.body.dataset['screen'];
  return given === 'environment' || given === 'container' ? given : 'request';
};
export const screen: AppScreen = readScreen();

/** What the extension last said about the file of a request. */
export const confirmed = signal<RequestState | undefined>(undefined);
/** The request as the person sees it: the confirmed one with the edits that have not been answered yet. */
export const request = signal<Request | undefined>(undefined);

/** The same for an environment and for a collection or folder. */
export const documentState = signal<DocumentState | undefined>(undefined);
export const working = signal<Environment | Container | undefined>(undefined);

/** Something the person should be told: an edit that was refused, a file that changed under their hands. */
export const notice = signal<string | undefined>(undefined);

/** The variables the request can use, and whether that list is the whole truth (it is not for a file outside a collection). */
export const variables = signal<{ vars: VariableInfo[]; complete: boolean }>({ vars: [], complete: false });

/** Whether a request is on its way, and since when (to show how long it has taken). */
export const sending = signal<{ id: number; since: number } | undefined>(undefined);
/** The last answer, or why there is none. Both are cleared when the next send begins. */
export const response = signal<ResponseView | undefined>(undefined);
/** Whether the request has an access token (OAuth 2.0), as the extension last said. */
export const oauthStatus = signal<OAuthStatusView | undefined>(undefined);
export const failure = signal<{ code: string; message: string; hint: string; warnings: string[]; scripts?: ScriptReport } | undefined>(undefined);

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

/** The version of the file the extension last confirmed, and whether it can be edited at all. */
const confirmedRev = (): number | undefined => (screen === 'request' ? confirmed.value?.rev : documentState.value?.rev);
const readOnly = (): boolean => (screen === 'request' ? confirmed.value?.readOnly !== undefined : documentState.value?.readOnly !== undefined);

function flush(): void {
  if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  const rev = confirmedRev();
  if (inFlight || queue.length === 0 || host === undefined || rev === undefined) return;
  host.postMessage({ type: 'edit', rev, ops: queue });
  queue = [];
  inFlight = true;
}

/** Changes the copy on screen; the reason when the edits are refused. */
function applyHere(ops: EditOp[]): string | undefined {
  if (screen === 'request') {
    const current = request.value;
    if (current === undefined) return '';
    const result = applyEditOps(current, ops);
    if (result.ok) request.value = result.request;
    return result.ok ? undefined : result.reason;
  }
  const state = documentState.value;
  const current = working.value;
  if (state === undefined || current === undefined) return '';
  const result = state.screen === 'environment' ? applyOps(current as Environment, ops, ENVIRONMENT_CODEC) : applyOps(current as Container, ops, containerCodec(state.screen === 'container' ? state.kind : 'collection'));
  if (result.ok) working.value = result.value;
  return result.ok ? undefined : result.reason;
}

/** Applies the edits to the copy on screen and sends them; typing is sent after a short pause. */
export function edit(...ops: EditOp[]): void {
  if (readOnly()) return;
  const refused = applyHere(ops);
  if (refused === '') return;
  if (refused !== undefined) {
    notice.value = `That change was not made: ${refused}.`;
    return;
  }
  notice.value = undefined;
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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const modelOf = (state: DocumentState | undefined): Environment | Container | undefined =>
  state === undefined ? undefined : state.screen === 'environment' ? state.environment : state.container;

export function receive(message: ToView): void {
  if (message.type === 'init') {
    confirmed.value = message;
    request.value = message.request;
    queue = [];
    inFlight = false;
    sendWhenSettled = false;
    return;
  }
  if (message.type === 'document') {
    const { type: _type, cause, ...state } = message;
    void _type;
    documentState.value = state;
    if (cause === 'meta') return;
    const model = modelOf(state);
    if (cause === 'init') {
      working.value = model;
      queue = [];
      inFlight = false;
      return;
    }
    if (cause === 'self') {
      inFlight = false;
      if (queue.length > 0) { flush(); return; }
      if (!same(working.value, model)) working.value = model;
      return;
    }
    if (inFlight || queue.length > 0) notice.value = 'The file changed while you were editing, so your last change was not applied.';
    inFlight = false;
    queue = [];
    working.value = model;
    return;
  }
  if (message.type === 'vars') {
    variables.value = { vars: message.vars, complete: message.complete };
    return;
  }
  if (message.type === 'oauth') {
    oauthStatus.value = message.status;
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
    failure.value = { code: message.code, message: message.message, hint: message.hint, warnings: message.warnings, ...(message.scripts === undefined ? {} : { scripts: message.scripts }) };
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
    if (screen === 'request') request.value = confirmed.value?.request;
    else working.value = modelOf(documentState.value);
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
