import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWizardHtml, contentSecurityPolicy } from '../../src/wizard/html';

const root = join(__dirname, '..', '..', '..');
const read = (relative: string): string => readFileSync(join(root, ...relative.split('/')), 'utf8');
const NONCE = 'q3Vf8mZ0aG1xT9bL2cYh7w==';
const CSP_SOURCE = "https://*.vscode-cdn.net 'self'";

test('The page of the panel runs one script with a nonce and nothing inline, and its policy allows nothing else', () => {
  const html = buildWizardHtml({ cspSource: CSP_SOURCE, nonce: NONCE, scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/wizard.js', styleUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/media/wizard.css' });
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
  assert.ok(policy, 'the policy is in the page');
  assert.equal(policy, contentSecurityPolicy(CSP_SOURCE, NONCE));
  assert.match(policy, /^default-src 'none';/, 'everything is refused unless allowed');
  assert.ok(policy.includes(`script-src 'nonce-${NONCE}'`), 'only the script with the nonce runs');
  assert.ok(!/unsafe-inline|unsafe-eval|\*;|\* /.test(policy.replace('https://*.vscode-cdn.net', '')), 'no unsafe source');
  assert.ok(!/connect-src|frame-src|object-src/.test(policy), 'no network, frame or plugin source is allowed');
  assert.ok(policy.includes("base-uri 'none'") && policy.includes("form-action 'none'"), 'no base address and no form can change where the page goes');
  assert.equal((html.match(/<script\b/g) ?? []).length, 1, 'one script');
  assert.match(html, new RegExp(`<script nonce="${NONCE.replace(/[+/=]/g, '\\$&')}" src="[^"]+wizard\\.js"></script>`));
  assert.ok(!/<script\b(?![^>]*\bsrc=)/.test(html), 'no inline script');
  assert.ok(!/\sstyle\s*=/.test(html) && !/<style\b/.test(html), 'no inline style');
  assert.ok(!/\son[a-z]+\s*=/.test(html), 'no event attribute');
  assert.equal((html.match(/<link\b/g) ?? []).length, 1);
});

test('A nonce or a source list that could change the policy is refused, and the file addresses are escaped', () => {
  const good = { cspSource: CSP_SOURCE, nonce: NONCE, scriptUri: 'https://x/wizard.js', styleUri: 'https://x/wizard.css' };
  for (const nonce of ['', 'short', "abcdefghijklmnop'; script-src *", 'abcdefghijklmnop"><script>']) assert.throws(() => buildWizardHtml({ ...good, nonce }), /nonce/, nonce);
  for (const cspSource of ["'unsafe-inline'; script-src *", 'a; b', 'a, b', 'a"b', '', 'https://x\nscript-src *']) assert.throws(() => buildWizardHtml({ ...good, cspSource }), /source list/, JSON.stringify(cspSource));
  const html = buildWizardHtml({ ...good, scriptUri: 'https://x/a"><img src=x onerror=alert(1)>.js', styleUri: 'https://x/a&b.css' });
  assert.ok(!html.includes('<img'), 'a quote or a bracket in an address cannot open a tag');
  assert.ok(html.includes('a&amp;b.css'));
});

test('The script of the panel puts nothing in the page as HTML, loads nothing and runs no code from text', () => {
  const code = read('extension/src/webview/main.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'DOMParser', 'srcdoc'].filter(word => code.includes(word)), [], 'HTML from text');
  assert.deepEqual(['eval(', 'new Function', 'setTimeout("', "setTimeout('", 'importScripts', 'import(', 'javascript:'].filter(word => code.includes(word)), [], 'code from text');
  assert.deepEqual(['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'].filter(word => code.includes(word)), [], 'network or storage');
  assert.ok(!/setAttribute\(\s*['"`]on/i.test(code) && !/\bon[a-z]+\s*=\s*['"`]/i.test(code), 'no event attribute set from text');
  assert.ok(code.includes('textContent') || code.includes('.append(') || code.includes('createTextNode'), 'text goes in as text');
  // The only element attribute written from data is a value of the field for the folder; the links and images of the page are fixed.
  assert.ok(!/\bhref\b|\bsrc\s*:|\bsrc=/i.test(code), 'the script creates no link or image');
});

test('The manifest, the code and the package agree: two commands, one empty view, nothing that runs by itself, and the files the panel needs', () => {
  const manifest = JSON.parse(read('extension/package.json')) as {
    activationEvents: string[]; icon: string; contributes: { commands: { command: string }[]; views: Record<string, { id: string; visibility?: string }[]>; viewsWelcome: { view: string; contents: string }[] };
  };
  const source = read('extension/src/extension.ts');
  const constant = (name: string): string | undefined => new RegExp(`export const ${name} = '([^']+)'`).exec(source)?.[1];
  const commands = manifest.contributes.commands.map(entry => entry.command);
  assert.deepEqual(commands, [constant('IMPORT_COMMAND'), constant('STEPS_COMMAND')], 'the commands in the manifest are the ones the code registers');
  assert.equal(manifest.contributes.views['explorer']?.[0]?.id, /const START_VIEW = '([^']+)'/.exec(source)?.[1]);
  assert.equal(manifest.contributes.views['explorer']?.[0]?.visibility, 'collapsed', 'the view does not wake the extension up at start');
  assert.deepEqual(manifest.activationEvents, [], 'no activation event of its own');
  assert.ok(manifest.contributes.viewsWelcome[0]?.contents.includes(`(command:${commands[0]})`), 'the welcome button opens the panel');
  assert.ok(existsSync(join(root, 'extension', ...manifest.icon.split('/'))), 'the icon is there');
  assert.ok(existsSync(join(root, 'extension', 'media', 'wizard.css')));
  const ignore = read('extension/.vscodeignore').split('\n').map(line => line.trim());
  assert.ok(!ignore.some(line => /^(?:dist|media)(?:\/|$)/.test(line) || line === '**'), 'the built files and the media are packaged');
  const bundler = read('extension/esbuild.mjs');
  assert.ok(bundler.includes("outfile: 'dist/wizard.js'") && bundler.includes("platform: 'browser'"), 'the script of the panel is built for the browser');
  assert.ok(read('extension/src/wizardPanel.ts').includes("'dist', 'wizard.js'") === false && read('extension/src/wizardPanel.ts').includes("vscode.Uri.joinPath(dist, 'wizard.js')"), 'the panel loads the built script');
});

test('The panel loads only its own folders and keeps no page in memory when hidden', () => {
  const panel = read('extension/src/wizardPanel.ts');
  assert.match(panel, /localResourceRoots: \[vscode\.Uri\.joinPath\(context\.extensionUri, 'dist'\), vscode\.Uri\.joinPath\(context\.extensionUri, 'media'\)\]/);
  assert.match(panel, /enableScripts: true/);
  assert.match(panel, /retainContextWhenHidden: false/);
  assert.ok(!panel.includes('enableCommandUris'), 'the page cannot run commands');
  assert.match(panel, /parseToHost\(raw\)/, 'every message is parsed before it is used');
});
