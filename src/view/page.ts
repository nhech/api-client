/**
 * The page of an editor of the client (the request editor and the screens that follow it). It has no inline script and no
 * event attribute: the one script and the one stylesheet are files of the extension, and the policy lets nothing else run or
 * load, and no connection at all be made (the page never touches the network: the extension does). The editor component injects
 * `<style>` elements, which the policy allows only when they carry the nonce. Pure text, so that a test can check it.
 */
export interface AppHtmlOptions {
  /** The origin the webview serves the extension's files from (`webview.cspSource`). */
  cspSource: string;
  /** A fresh random value for each page; only the script that carries it may run, and only styles that carry it are added. */
  nonce: string;
  scriptUri: string;
  styleUri: string;
  /** The screen the script draws: `request`. Written to a data attribute of the body. */
  screen: 'request';
}

const escapeAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function appContentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`
  ].join('; ');
}

export function buildAppHtml(options: AppHtmlOptions): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(options.nonce)) throw new Error('The nonce must be at least 16 characters of base64 or hex.');
  // `cspSource` is a list of sources such as `https://*.vscode-cdn.net 'self'`; nothing in it may end the directive or the attribute.
  if (!/^[\w:/.*' -]+$/.test(options.cspSource)) throw new Error('The webview origin is not a plain source list.');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(appContentSecurityPolicy(options.cspSource, options.nonce))}">
<meta name="csp-nonce" content="${options.nonce}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API Client</title>
<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
</head>
<body data-screen="${options.screen}">
<div id="status" class="sr-only" role="status" aria-live="polite"></div>
<main id="app"><p class="loading">Loading...</p></main>
<script nonce="${options.nonce}" src="${escapeAttribute(options.scriptUri)}"></script>
</body>
</html>
`;
}
