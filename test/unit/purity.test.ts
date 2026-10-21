import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { BANNED_EVERYWHERE, ZONES, type Zone } from '../support/zones';

/**
 * Static guards for the constraints of the spec and of the client plan: the pure core cannot touch the machine, every other
 * zone imports only the modules it was given, nothing evaluates text as code, and the output of the deciding stages depends
 * on the data alone (6.3, P1). The zones are listed in test/support/zones.ts.
 */
const repository = join(__dirname, '..', '..', '..');
const walk = (directory: string): string[] =>
  readdirSync(join(repository, directory), { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts')).map(file => `${directory}/${file.replaceAll('\\', '/')}`);
const sources = [...walk('src'), ...walk('extension/src')].map(file => ({ file, text: readFileSync(join(repository, ...file.split('/')), 'utf8') }));

/** Source without comments; module names in import statements are still there. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** Source without comments and without the text of string literals, so a message that mentions "WebSocket" is not a call. */
const bare = (text: string) => code(text).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
const scan = (files: typeof sources, pattern: RegExp, view: (text: string) => string = code) => files.filter(({ text }) => pattern.test(view(text))).map(({ file }) => file);

const zoneOf = (file: string): Zone | undefined => {
  let best: { zone: Zone; length: number } | undefined;
  for (const zone of ZONES) for (const path of zone.paths) {
    if ((path.endsWith('/') ? file.startsWith(path) : file === path) && (best === undefined || path.length > best.length)) best = { zone, length: path.length };
  }
  return best?.zone;
};

interface Import { specifier: string; typeOnly: boolean; dynamic: boolean }
/** The modules a file names: static imports and re-exports, require() and import(); `import type` and `export type` are marked. */
function importsOf(text: string): Import[] {
  const source = code(text);
  const found: Import[] = [];
  // Where each import or export statement starts, and whether it says `type` right after the keyword.
  const starts = [...source.matchAll(/(?:^|[;}\n])\s*(?:import|export)\s+(type\s+)?/g)].map(match => ({ at: match.index ?? 0, typeOnly: match[1] !== undefined }));
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    const own = starts.filter(start => start.at <= (match.index ?? 0)).at(-1);
    found.push({ specifier: match[1] ?? '', typeOnly: own?.typeOnly ?? false, dynamic: false });
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push({ specifier: match[1] ?? '', typeOnly: false, dynamic: false });
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ specifier: match[1] ?? '', typeOnly: false, dynamic: false });
  for (const match of source.matchAll(/\bimport\(\s*([^)]*)\)/g)) {
    const literal = /^['"]([^'"]+)['"]$/.exec((match[1] ?? '').trim());
    found.push({ specifier: literal?.[1] ?? '<computed>', typeOnly: false, dynamic: true });
  }
  return found;
}
const normalizeModule = (specifier: string): string => (builtinModules.includes(specifier) ? `node:${specifier}` : specifier);
const resolveRelative = (file: string, specifier: string): string | undefined => {
  const target = posix.normalize(posix.join(dirname(file), specifier));
  return [`${target}.ts`, `${target}/index.ts`].find(candidate => existsSync(join(repository, ...candidate.split('/'))));
};

test('There are sources to guard', () => {
  assert.ok(sources.length >= 20, `only ${sources.length} files under src/ and extension/src/`);
});

test('Every source file belongs to a zone and every path of a zone exists', () => {
  assert.deepEqual(sources.filter(({ file }) => zoneOf(file) === undefined).map(({ file }) => file), [], 'a file outside every zone: add its directory to test/support/zones.ts');
  for (const zone of ZONES) for (const path of zone.paths) assert.ok(existsSync(join(repository, ...path.split('/'))), `${zone.name}: ${path} does not exist`);
  for (const zone of ZONES) for (const used of zone.uses) assert.ok(ZONES.some(other => other.name === used), `${zone.name} uses an unknown zone ${used}`);
  assert.deepEqual(ZONES.flatMap(zone => zone.modules).filter(name => BANNED_EVERYWHERE.includes(name)), [], 'a zone lists a module that is banned everywhere');
});

test('Each zone imports only the modules it was given, and nothing imports a computed module name', () => {
  const violations: string[] = [];
  for (const { file, text } of sources) {
    const zone = zoneOf(file);
    if (zone === undefined) continue;
    for (const { specifier } of importsOf(text)) {
      if (specifier === '<computed>') { violations.push(`${file}: import() of a computed name`); continue; }
      if (specifier.startsWith('.')) continue;
      const name = normalizeModule(specifier);
      if (BANNED_EVERYWHERE.includes(name) || !zone.modules.includes(name)) violations.push(`${file} (${zone.name}) imports ${name}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('A zone reaches another zone at run time only when it was given that zone', () => {
  const violations: string[] = [];
  for (const { file, text } of sources) {
    const zone = zoneOf(file);
    if (zone === undefined) continue;
    for (const { specifier, typeOnly } of importsOf(text)) {
      if (!specifier.startsWith('.') || typeOnly) continue;
      const target = resolveRelative(file, specifier);
      if (target === undefined) { violations.push(`${file}: ${specifier} does not resolve to a source file`); continue; }
      const other = zoneOf(target);
      if (other === undefined) violations.push(`${file}: ${target} is in no zone`);
      else if (other.name !== zone.name && !zone.uses.includes(other.name)) violations.push(`${file} (${zone.name}) imports ${target} (${other.name})`);
    }
  }
  assert.deepEqual(violations, []);
});

test('Nothing evaluates text as code or calls a network API of the page, in any zone', () => {
  assert.deepEqual(scan(sources, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, bare), [], 'network call');
  assert.deepEqual(scan(sources, /\beval\s*\(|\bnew\s+Function\b/, bare), [], 'code evaluation');
});

test('The stages that decide the output cannot depend on time, randomness, the machine or the locale (6.3, P1)', () => {
  const deciding = sources.filter(({ file }) => zoneOf(file)?.deterministic === true);
  assert.ok(deciding.length >= 20, `only ${deciding.length} deciding files`);
  assert.deepEqual(scan(deciding, /\bDate\b|Math\.random|performance\.now|process\.(?:env|hrtime|platform|cwd)|\bIntl\./, bare), [], 'time, randomness or machine');
  assert.deepEqual(scan(deciding, /localeCompare|toLocale\w*/, bare), [], 'locale-dependent comparison');
  assert.deepEqual(scan(deciding, /(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?(?:os|fs|path)['"]/), [], 'disk or machine access in a pure stage');
});

// ---- the bundles that ship, from the same rules the package script checks ----

interface PackageRules { bundles: Record<string, { kind: 'host' | 'page' | 'worker'; requires?: string[] }> }
const rules = JSON.parse(readFileSync(join(repository, 'scripts', 'package-rules.json'), 'utf8')) as PackageRules;

test('A built bundle (when it has been built) requires exactly the modules its rule lists; a page script loads nothing', () => {
  for (const [name, rule] of Object.entries(rules.bundles)) {
    let text: string;
    try { text = readFileSync(join(repository, ...name.split('/')), 'utf8'); } catch { continue; }
    if (rule.kind === 'page') {
      assert.ok(!/\brequire\s*\(/.test(text), `${name}: no require in a script that runs in a page`);
      assert.ok(!/\bimport\s*\(/.test(text) && !/\bimportScripts\b/.test(text), `${name}: no dynamic import`);
    } else {
      const modules = new Set([...text.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map(match => match[1]));
      assert.deepEqual([...modules].sort(), [...(rule.requires ?? [])].sort(), name);
    }
  }
});
