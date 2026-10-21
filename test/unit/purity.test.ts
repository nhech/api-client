import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static guards for the constraints of the spec: the core is pure and offline (C2, C4), reads data without ever running it
 * (8.2), and its output depends on the data alone (6.3, P1).
 */
const root = join(__dirname, '..', '..', '..', 'src');
const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter(file => file.endsWith('.ts'))
  .map(file => ({ file: file.replaceAll('\\', '/'), text: readFileSync(join(root, file), 'utf8') }));

/** Source without comments; module names in import statements are still there. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** Source without comments and without the text of string literals, so a message that mentions "WebSocket" is not a call. */
const bare = (text: string) => code(text).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
const scan = (files: typeof sources, pattern: RegExp, view: (text: string) => string = code) => files.filter(({ text }) => pattern.test(view(text))).map(({ file }) => file);

test('There are sources to guard', () => {
  assert.ok(sources.length >= 10, `only ${sources.length} files under src/`);
});

test('The core never imports VS Code, the network, a child process or a code evaluator (C2, C4, 8.2)', () => {
  assert.deepEqual(scan(sources, /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/), [], 'vscode');
  assert.deepEqual(scan(sources, /(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?(?:http|https|http2|net|tls|dns|dgram|child_process|cluster|worker_threads|vm)['"]/), [], 'network or process module');
  assert.deepEqual(scan(sources, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, bare), [], 'network call');
  assert.deepEqual(scan(sources, /\beval\s*\(|\bnew\s+Function\b/, bare), [], 'code evaluation');
});

test('The stages that decide the output cannot depend on time, randomness, the machine or the locale (6.3, P1)', () => {
  const deciding = sources.filter(({ file }) => /^(?:normalize|convert|emit|model)\//.test(file));
  assert.ok(deciding.length >= 4);
  assert.deepEqual(scan(deciding, /\bDate\b|Math\.random|performance\.now|process\.(?:env|hrtime|platform|cwd)|\bIntl\./, bare), [], 'time, randomness or machine');
  assert.deepEqual(scan(deciding, /localeCompare|toLocale\w*/, bare), [], 'locale-dependent comparison');
  assert.deepEqual(scan(deciding, /['"](?:node:)?(?:os|fs|path)['"]/), [], 'disk or machine access in a pure stage');
});

// ---- the VS Code layer and the bundle that ships ----

const extensionRoot = join(__dirname, '..', '..', '..', 'extension');
const extensionSources = readdirSync(join(extensionRoot, 'src'), { recursive: true, encoding: 'utf8' })
  .filter(file => file.endsWith('.ts'))
  .map(file => ({ file: `extension/src/${file.replaceAll('\\', '/')}`, text: readFileSync(join(extensionRoot, 'src', file), 'utf8') }));

test('The VS Code layer has no network, child process or code evaluation either', () => {
  assert.ok(extensionSources.length >= 2);
  assert.deepEqual(scan(extensionSources, /(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?(?:http|https|http2|net|tls|dns|dgram|child_process|cluster|worker_threads|vm)['"]/), [], 'network or process module');
  assert.deepEqual(scan(extensionSources, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\beval\s*\(|\bnew\s+Function\b/, bare), [], 'network call or evaluation');
});

test('The built extension (when it has been built) imports only what the core needs, and no network or child process module', () => {
  const bundle = join(extensionRoot, 'dist', 'extension.js');
  let text: string;
  try { text = readFileSync(bundle, 'utf8'); } catch { return; }
  const modules = new Set([...text.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map(match => match[1]));
  // node:crypto is there for the random nonce of the panel's page; nothing else beyond files, paths and the home folder.
  assert.deepEqual([...modules].sort(), ['node:crypto', 'node:fs', 'node:os', 'node:path', 'vscode']);
});

test('The built script of the panel loads nothing: it requires no module at all', () => {
  let text: string;
  try { text = readFileSync(join(extensionRoot, 'dist', 'wizard.js'), 'utf8'); } catch { return; }
  assert.ok(!/\brequire\s*\(/.test(text), 'no require in a script that runs in a page');
  assert.ok(!/\bimport\s*\(/.test(text) && !/\bimportScripts\b/.test(text), 'no dynamic import');
});
