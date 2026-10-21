// Builds the VS Code package of the extension from the current tree and checks what is in it. No dependencies.
//   node scripts/package-extension.cjs                 run the checks of the project, build, verify, write .artifacts/api-client-<version>.vsix
//   node scripts/package-extension.cjs --allow-dirty   package a tree that has uncommitted changes (a release is built from a clean one)
//   node scripts/package-extension.cjs --skip-check    do not run `npm run check` first
//   node scripts/package-extension.cjs --verify <file> only verify an existing package
// Prints a JSON summary and exits 1 on any failure.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extension');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const errors = [];
const fail = message => { errors.push(message); };

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited ${result.status}`);
}

/** The files of a zip, read without a library: the central directory lists them, each is stored or deflated. */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('Not a zip file.');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('Broken central directory.');
    const method = buffer.readUInt16LE(at + 10), compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32), local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// The files, the bundles and the size limit live in one place that the purity test reads as well.
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-rules.json'), 'utf8'));
const EXPECTED = [...rules.files].sort();

function verify(file) {
  const bytes = fs.readFileSync(file);
  const files = readZip(bytes);
  const names = [...files.keys()].sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) fail(`The package holds ${JSON.stringify(names)}; expected ${JSON.stringify(EXPECTED)}.`);
  const text = name => (files.get(name) ?? Buffer.alloc(0)).toString('utf8');

  const packed = JSON.parse(text('extension/package.json') || '{}');
  if (packed.publisher !== 'longtd') fail(`publisher is "${packed.publisher}", not longtd`);
  if (packed.name !== 'api-client') fail(`name is "${packed.name}"`);
  if (packed.private !== undefined) fail('the manifest is marked private');
  if (packed.preview !== true) fail('the manifest is not marked as a preview');
  if (packed.dependencies !== undefined || packed.devDependencies !== undefined) fail('the manifest lists dependencies');
  if (JSON.stringify(packed.activationEvents) !== '[]') fail('the extension has an activation event of its own');
  if (packed.icon !== 'media/icon.png') fail('the icon is not media/icon.png');
  if (!/^\d+\.\d+\.\d+$/.test(packed.version ?? '')) fail(`version "${packed.version}" is not major.minor.patch`);
  if (!(packed.keywords || []).length || packed.keywords.length > 30) fail('keywords must be 1 to 30');

  // The icon: a PNG of at least 128 x 128 pixels.
  const icon = files.get('extension/media/icon.png');
  if (icon === undefined || !icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || icon.readUInt32BE(16) < 128 || icon.readUInt32BE(20) < 128) fail('the icon is not a PNG of at least 128 x 128 pixels');

  // What the code may do: no process, no code from text, no network API of a page; each bundle requires exactly the modules its rule lists.
  const forbidden = { 'a child process': /child_process|\bspawn\(|\bexecSync\(|\bexecFile\(/, 'a network API': /\bfetch\(|XMLHttpRequest|new WebSocket\(/, 'code from text': /\beval\(|new Function\(/, 'a source map': /sourceMappingURL/ };
  for (const [name, rule] of Object.entries(rules.bundles)) {
    const code = text(name);
    if (code === '') fail(`${name} is empty or missing`);
    for (const [what, pattern] of Object.entries(forbidden)) if (pattern.test(code)) fail(`${name} has ${what}`);
    if (/[A-Z]:\\\\(?:Users|Workspaces)|\/home\/|localaccount|LOCALA~1/.test(code)) fail(`${name} holds a path of the machine that built it`);
    if (rule.kind === 'page') {
      if (/\brequire\s*\(|\bimport\s*\(|importScripts/.test(code)) fail(`${name} loads something`);
      if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code)) fail(`${name} puts HTML in the page`);
    } else {
      const required = [...new Set([...code.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map(match => match[1]))].sort();
      if (JSON.stringify(required) !== JSON.stringify([...rule.requires].sort())) fail(`${name} requires ${JSON.stringify(required)}; its rule lists ${JSON.stringify(rule.requires)}`);
    }
  }

  // The README and the changelog: images only from https, none an SVG, no link relative to the repository.
  for (const name of ['extension/readme.md', 'extension/changelog.md']) {
    for (const match of text(name).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const url = match[1];
      if (!/^https:\/\//.test(url)) fail(`${name}: image ${url} is not an https address`);
      if (/\.svg(?:$|\?)/i.test(url)) fail(`${name}: image ${url} is an SVG`);
      const local = /^https:\/\/raw\.githubusercontent\.com\/nhech\/api-client\/main\/(docs\/images\/[\w.-]+)$/.exec(url);
      if (!local) fail(`${name}: image ${url} is not one of the repository's docs/images`);
      else if (!fs.existsSync(path.join(root, ...local[1].split('/')))) fail(`${name}: ${local[1]} does not exist in the repository`);
    }
    for (const match of text(name).matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)) if (!/^(?:https:\/\/|#)/.test(match[1])) fail(`${name}: link ${match[1]} is not an https address`);
  }
  if (bytes.length > rules.maxPackageBytes) fail(`the package is ${bytes.length} bytes; the limit in scripts/package-rules.json is ${rules.maxPackageBytes}`);
  return { bytes: bytes.length, files: names.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), version: packed.version };
}

function main() {
  const verifyIndex = args.indexOf('--verify');
  if (verifyIndex >= 0) return { file: path.resolve(args[verifyIndex + 1]), ...verify(path.resolve(args[verifyIndex + 1])) };
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', shell: true });
  const dirty = status.status === 0 && status.stdout.trim() !== '';
  if (dirty && !flag('--allow-dirty')) throw new Error('The working tree has uncommitted changes: a release is built from a clean checkout of the release commit. Commit first, or pass --allow-dirty for a trial package.');
  if (!flag('--skip-check')) run('npm', ['run', 'check'], root);
  run('npm', ['run', 'package'], extensionRoot);
  const built = path.join(root, '.artifacts', 'api-client.vsix');
  const result = verify(built);
  const named = path.join(root, '.artifacts', `api-client-${result.version}${dirty ? '-trial' : ''}.vsix`);
  fs.copyFileSync(built, named);
  return { file: path.relative(root, named), dirty, ...result };
}

let summary;
try { summary = main(); } catch (error) { fail(error.message); }
console.log(JSON.stringify({ passed: errors.length === 0, ...summary, errors }, null, 2));
if (errors.length) process.exitCode = 1;
