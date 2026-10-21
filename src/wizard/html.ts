/**
 * The page of the importer panel. It has no inline script, no inline style and no event attribute: the one script and the
 * one stylesheet are files of the extension, and the Content-Security-Policy lets nothing else run or load. Pure text, so that
 * a test can check it without VS Code.
 */
export interface WizardHtmlOptions {
  /** The origin the webview serves the extension's files from (`webview.cspSource`). */
  cspSource: string;
  /** A fresh random value for each page; only the script that carries it may run. */
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

const escapeAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`
  ].join('; ');
}

export function buildWizardHtml(options: WizardHtmlOptions): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(options.nonce)) throw new Error('The nonce must be at least 16 characters of base64 or hex.');
  // `cspSource` is a list of sources such as `https://*.vscode-cdn.net 'self'`; nothing in it may end the directive or the attribute.
  if (!/^[\w:/.*' -]+$/.test(options.cspSource)) throw new Error('The webview origin is not a plain source list.');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(contentSecurityPolicy(options.cspSource, options.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HTTP Files Importer</title>
<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
</head>
<body>
<div id="status" class="sr-only" role="status" aria-live="polite"></div>
<main id="app"><p class="loading">Loading...</p></main>
<script nonce="${options.nonce}" src="${escapeAttribute(options.scriptUri)}"></script>
</body>
</html>
`;
}
