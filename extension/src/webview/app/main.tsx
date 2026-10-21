import { render } from 'preact';
import type { ToHost, ToView } from '../../../../src/view/request-protocol';
import { App } from './App';
import { connect, receive } from './store';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

/**
 * The entry of the request editor page: it reports what the Content-Security-Policy refused, passes the messages of the
 * extension to the store, and draws the editor. Nothing here touches the network, the page's address or any storage.
 */
const vscode = acquireVsCodeApi();
const violations: string[] = [];
document.addEventListener('securitypolicyviolation', event => { violations.push(`${event.violatedDirective} ${event.blockedURI}`); });

const port = { post: (message: ToHost): void => vscode.postMessage(message) };
connect({ postMessage: message => vscode.postMessage(message) });
window.addEventListener('message', event => { receive(event.data as ToView); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') port.post({ type: 'cancel' });
});

render(<App port={port} />, document.getElementById('app') as HTMLElement);
// Once the first drawing is done, the extension is told the page is alive and what was refused.
requestAnimationFrame(() => { port.post({ type: 'ready', violations }); });
