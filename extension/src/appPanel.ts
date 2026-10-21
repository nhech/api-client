import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { buildAppHtml } from '../../src/view/page';
import type { AppScreen } from '../../src/view/request-protocol';

/** Gives a panel the page of the app for one screen: scripts on, only the folders of the extension readable, and a policy with a nonce of its own. */
export function configureAppPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, screen: AppScreen): void {
  const root = context.extensionUri;
  const dist = vscode.Uri.joinPath(root, 'dist');
  const media = vscode.Uri.joinPath(root, 'media');
  panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
  panel.webview.html = buildAppHtml({
    cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64'), screen,
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'app.js')).toString(), styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.css')).toString()
  });
}
