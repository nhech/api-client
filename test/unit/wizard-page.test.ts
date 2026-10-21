import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

test('The manifest, the code and the package agree: every command, view and menu entry has its counterpart, and nothing runs by itself', () => {
  interface Manifest {
    activationEvents: string[]; icon: string;
    contributes: {
      commands: { command: string }[]; views: Record<string, { id: string }[]>; viewsWelcome: { view: string; contents: string }[];
      viewsContainers: { activitybar: { id: string; icon: string }[] }; menus: Record<string, { command: string }[]>;
    };
  }
  const manifest = JSON.parse(read('extension/package.json')) as Manifest;
  const sources = readdirSync(join(root, 'extension', 'src'), { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.ts')).map(name => read('extension/src/' + name.replaceAll('\\', '/')));
  const code = sources.join('\n');
  const constants = new Map<string, string>([...code.matchAll(/(?:export )?const ([A-Z_]+) = '([^']+)'/g)].map(match => [match[1] as string, match[2] as string]));
  const resolve = (literal: string | undefined, constant: string | undefined): string | undefined => literal ?? (constant === undefined ? undefined : constants.get(constant));
  const registered = new Set([...code.matchAll(/(?:registerCommand|register)\(\s*(?:'([^']+)'|([A-Z_]+))/g)].map(match => resolve(match[1], match[2])).filter((id): id is string => id !== undefined && id.startsWith('apiClient.')));
  const declared = manifest.contributes.commands.map(entry => entry.command);
  assert.deepEqual([...registered].sort(), [...declared].sort(), 'the commands in the manifest are the ones the code registers, and the other way round');

  const created = new Set([...code.matchAll(/(?:createTreeView|registerTreeDataProvider)(?:<[^>]*>)?\(\s*(?:'([^']+)'|([A-Z_]+))/g)].map(match => resolve(match[1], match[2])));
  const views = Object.values(manifest.contributes.views).flat().map(view => view.id);
  assert.deepEqual([...created].filter((id): id is string => id !== undefined).sort(), [...views].sort(), 'every view of the manifest is created, and nothing else is');

  const menuCommands = Object.values(manifest.contributes.menus).flat().map(entry => entry.command);
  for (const id of menuCommands) assert.ok(declared.includes(id) || /^(?:workbench|revealInExplorer)\./.test(id), 'a menu entry for a command that does not exist: ' + id);
  for (const welcome of manifest.contributes.viewsWelcome) {
    assert.ok(views.includes(welcome.view), 'a welcome text for a view that does not exist: ' + welcome.view);
    for (const match of welcome.contents.matchAll(/\(command:([^)]+)\)/g)) assert.ok(declared.includes(match[1] as string) || /^workbench\./.test(match[1] as string), 'a welcome button for a command that does not exist: ' + match[1]);
  }
  assert.deepEqual(manifest.activationEvents, [], 'no activation event of its own');
  assert.ok(existsSync(join(root, 'extension', ...manifest.icon.split('/'))), 'the icon is there');
  for (const container of manifest.contributes.viewsContainers.activitybar) assert.ok(existsSync(join(root, 'extension', ...container.icon.split('/'))), 'the icon of the side bar is there');
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
