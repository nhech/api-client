import { render } from 'preact';
import type { ToHost, ToView } from '../../../../src/view/request-protocol';
import type { RunnerToHost, RunnerToView } from '../../../../src/view/runner-protocol';
import { App } from './App';
import { RunnerApp } from './RunnerApp';
import { receive as receiveRunner } from './runnerStore';
import { connect, receive, screen, sendNow } from './store';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

/**
 * The entry of the page: it reports what the Content-Security-Policy refused, passes the messages of the extension to the store, and draws
 * the screen that the extension chose (the request editor, the editor of an environment or of a collection, or the collection runner).
 * Nothing here touches the network, the page's address or any storage.
 */
const vscode = acquireVsCodeApi();
const violations: string[] = [];
let ready = false;
const container = document.getElementById('app') as HTMLElement;

if (screen === 'runner') {
  const runnerPort = { post: (message: RunnerToHost): void => vscode.postMessage(message) };
  document.addEventListener('securitypolicyviolation', event => {
    const text = `${event.violatedDirective} ${event.blockedURI}`;
    violations.push(text);
    if (ready) runnerPort.post({ type: 'violation', text });
  });
  window.addEventListener('message', event => { receiveRunner(event.data as RunnerToView); });
  render(<RunnerApp port={runnerPort} />, container);
  requestAnimationFrame(() => { runnerPort.post({ type: 'ready', violations }); ready = true; });
} else {
  const port = { post: (message: ToHost): void => vscode.postMessage(message) };
  document.addEventListener('securitypolicyviolation', event => {
    const text = `${event.violatedDirective} ${event.blockedURI}`;
    violations.push(text);
    // One that comes after the first drawing (a response with a picture, a style) is reported as it happens.
    if (ready) port.post({ type: 'violation', text });
  });
  connect({ postMessage: message => vscode.postMessage(message) });
  window.addEventListener('message', event => { receive(event.data as ToView); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') port.post({ type: 'cancel' });
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendNow(); }
  });
  render(<App port={port} />, container);
  // Once the first drawing is done, the extension is told the page is alive and what was refused.
  requestAnimationFrame(() => { port.post({ type: 'ready', violations }); ready = true; });
}
