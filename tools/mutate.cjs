#!/usr/bin/env node
'use strict';
/*
 * Mutation check: breaks the code on purpose, one rule at a time, and demands that the test suite notices.
 *
 * For each mutation the file is changed in place, `npm test` is run, and the file is put back (also when the run is
 * interrupted). A mutation is KILLED when the tests fail, SURVIVED when they still pass (a rule no test protects), and INVALID
 * when the broken code does not even compile (the mutation itself is wrong). The exit code is 1 if any mutation survived or
 * is invalid.
 *
 *   node tools/mutate.cjs            all mutations
 *   node tools/mutate.cjs M3 M7      only these
 *
 * Not part of `npm run check`: it runs the whole suite once per mutation.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

const MUTATIONS = [
  { id: 'M1', rule: 'N15 the nearest base URL wins', file: 'src/convert/inherit.ts', find: 'for (const level of levels) {\n    const options = level.settings?.options;', replace: 'for (const level of [...levels].reverse()) {\n    const options = level.settings?.options;' },
  { id: 'M2', rule: 'N16 "none" on a level stops the search', file: 'src/convert/inherit.ts', find: "if (type === 'none') return { source: 'none', auth: undefined };", replace: "if (type === 'none') continue;" },
  { id: 'M3', rule: 'N16 a request keeps its own "none"', file: 'src/convert/inherit.ts', find: "if (authType(own) !== 'inherit') return { source: 'own', auth: own };", replace: "if (authType(own) !== 'inherit' && authType(own) !== 'none') return { source: 'own', auth: own };" },
  { id: 'M4', rule: 'N17 a header the request already has is not added again', file: 'src/convert/inherit.ts', find: 'if (enabled.has(name)) continue;', replace: '' },
  { id: 'M5', rule: 'N18 a test the request already has is not added again', file: 'src/convert/inherit.ts', find: 'if (exists) continue;', replace: 'if (exists && Date.now() < 0) continue;' },
  { id: 'M6', rule: '8.3 secrets are moved (not left in the file)', file: 'src/convert/secrets.ts', find: 'if (!this.moveSecrets) return', replace: 'if (!this.moveSecrets || this.moveSecrets) return' },
  { id: 'M7', rule: '8.3 a header with "key" in its name is a secret', file: 'src/convert/secrets.ts', find: '|apikey|key)', replace: '|apikey)' },
  { id: 'M8', rule: 'an explicit Authorization header wins over the authentication', file: 'src/convert/request.ts', find: "    report('TC-AUTH-HEADER-CONFLICT');\n    auth = undefined;", replace: "    report('TC-AUTH-HEADER-CONFLICT');" },
  { id: 'M9', rule: 'a one-line value never carries a line break', file: 'src/convert/text.ts', find: "lineBreak = true; return ' ';", replace: 'lineBreak = true; return char;' },
  { id: 'M10', rule: 'a body with a ### line goes to a separate file', file: 'src/emit/body.ts', find: '(text: string): boolean => /(?:^|', replace: '(text: string): boolean => Date.now() < 0 && /(?:^|' },
  { id: 'M11', rule: 'names that differ only in letter case are told apart', file: 'src/emit/names.ts', find: 'some(entry => used.has(entry.toLowerCase()))', replace: 'some(entry => used.has(entry))' },
  { id: 'M12', rule: 'free text in a comment can never start a directive', file: 'src/emit/http.ts', find: "const body = clean.trimStart().startsWith('@') ? `- ${clean}` : clean;", replace: 'const body = clean;' },
  { id: 'M13', rule: 'a header name cannot look like a comment or a variable definition', file: 'src/emit/http.ts', find: "literal.replace(NOT_TOKEN, '-')", replace: 'literal' },
  { id: 'M14', rule: '6.4 .gitignore names the private file', file: 'src/write/writer.ts', find: "if (plan.gitignore !== 'not-needed') undo.push(await updateGitignore(root, privateFilesWritten(plan.files)));", replace: '' },
  { id: 'M15', rule: '6.4 a name that ends with a dot or a space is refused', file: 'src/write/paths.ts', find: 'if (/[. ]$/.test(segment)) return', replace: 'if (/ $/.test(segment)) return' },
  { id: 'M16', rule: '6.5 secret variables go to the private file only', file: 'src/emit/env.ts', find: 'if (variable.secret) { closed.set(variable.name, variable.value); open.delete(variable.name); }', replace: 'if (variable.secret) { open.set(variable.name, variable.value); }' },
  { id: 'M17', rule: '8.2 a link is not followed by the writer', file: 'src/write/writer.ts', find: 'if (stats.isSymbolicLink()) throw', replace: 'if (stats.isSymbolicLink() && Date.now() < 0) throw' },
  { id: 'M18', rule: 'the report escapes names', file: 'src/emit/report.ts', find: 'export const escapeMarkdown = (text: string): string => ', replace: 'export const escapeMarkdown = (text: string): string => displayLabel(text, 200); const unusedEscape = (text: string): string => ' },
  { id: 'M19', rule: 'N4 case-only duplicate headers keep the request\'s own', file: 'src/convert/headers.ts', find: 'const winner = ownIndexes.length > 0 ? (ownIndexes[ownIndexes.length - 1] as number) : (indexes[0] as number);', replace: 'const winner = indexes[indexes.length - 1] as number;' },
  { id: 'M21', rule: '5.7a code-looking text between {{ }} is made harmless', file: 'src/convert/expressions.ts', find: 'export const isPlainVariable = (inner: string): boolean => !NOT_A_NAME.test(inner) || THUNDER_DYNAMIC.test(inner);', replace: 'export const isPlainVariable = (inner: string): boolean => inner !== undefined;' },
  { id: 'M22', rule: '5.7a a {{ that is never closed is made harmless too', file: 'src/convert/expressions.ts', find: "{ out += \"{ \"; count++; continue; }", replace: '{ out += "{"; continue; }' },
  { id: 'M23', rule: 'variableSpans pairs braces in one pass (no quadratic scan)', file: 'src/convert/text.ts', find: 'if (code === 0x7b) open.push(k);', replace: 'if (code === 0x7b) { open.push(k); for (let z = 0; z < open.length; z++) { if (z < 0) break; } }' },
  { id: 'M24', rule: 'Basic auth is written as "user password" (the form all three tools encode)', file: 'src/emit/http.ts', find: "${/\\s/.test(user) ? ':' : ' '}", replace: "${':'}" },
  { id: 'M25', rule: 'a Thunder number includes its upper end: written as b + 1', file: 'src/convert/sysvars.ts', find: 'spelling.integer(range.min, range.max + 1)', replace: 'spelling.integer(range.min, range.max)' },
  { id: 'M26', rule: 'JetBrains gets its own spelling of a guid', file: 'src/convert/sysvars.ts', find: "jetbrains: { guid: '{{$uuid}}'", replace: "jetbrains: { guid: '{{$guid}}'" },
  { id: 'M27', rule: 'Thunder takes a start of 990000 or more as 1', file: 'src/convert/sysvars.ts', find: 'Number(a) >= SAFE_MIN_LIMIT ? 1 : Number(a)', replace: 'Number(a)' },
  { id: 'M28', rule: 'REST Client secrets are never in the shareable settings file', file: 'src/emit/env.ts', find: 'files.push({ path: REST_CLIENT_SETTINGS_FILE, content: toSettings(publicFile) });', replace: 'files.push({ path: REST_CLIENT_SETTINGS_FILE, content: toSettings(new Map([...publicFile].map(([k, v]) => [k, new Map([...v, ...(privateFile.get(k) ?? [])])] as const))) });' },
  { id: 'M29', rule: 'the private REST Client settings file is kept out of Git', file: 'src/write/gitignore.ts', find: "export const PRIVATE_PATTERNS: readonly string[] = [PRIVATE_PATTERN, 'rest-client.private.settings.json'];", replace: 'export const PRIVATE_PATTERNS: readonly string[] = [PRIVATE_PATTERN];' },
  { id: 'M30', rule: 'the private REST Client settings file is private (0600)', file: 'src/emit/env.ts', find: "content: toSettings(privateFile), mode: 0o600 });", replace: 'content: toSettings(privateFile) });' },
  { id: 'M31', rule: 'settings merge: a value the person already has is kept', file: 'src/settings-merge.ts', find: 'else if (own(present, name) !== value) kept.push(`${environment}.${name}`);', replace: 'else if (own(present, name) !== value) { put(present, name, value); kept.push(`${environment}.${name}`); }' },
  { id: 'M32', rule: 'settings merge: a secret is never read into the shareable settings', file: 'src/settings-merge.ts', find: 'return { shareable, secrets };', replace: 'return { shareable: { ...shareable, ...(secrets ?? {}) }, secrets };' },
  { id: 'M33', rule: 'settings merge: a __proto__ key from the data cannot reach the prototype', file: 'src/settings-merge.ts', find: 'const own = <T>(source: Record<string, T>, key: string): T | undefined => (Object.hasOwn(source, key) ? source[key] : undefined);', replace: 'const own = <T>(source: Record<string, T>, key: string): T | undefined => source[key];' },
  { id: 'M34', rule: '8.3 a raw body (JSON, XML, query string) is searched for secrets by name', file: 'src/convert/request.ts', find: 'text: protectBodyText(vars(body.text), bodySecret)', replace: 'text: vars(body.text)' },
  { id: 'M35', rule: '8.3 GraphQL arguments and variables are searched for secrets', file: 'src/convert/request.ts', find: 'query: protectGraphqlQuery(vars(body.query), bodySecret)', replace: 'query: vars(body.query)' },
  { id: 'M36', rule: '8.3 the password before the "@" of a URL is a secret', file: 'src/convert/url.ts', find: 'base = protectUserinfo(base, safe);', replace: '' },
  { id: 'M37', rule: '8.3 the pairs of a URL fragment are protected like a query', file: 'src/convert/url.ts', find: 'fragment = protectFragment(fragment, safe);', replace: '' },
  { id: 'M38', rule: '8.3 a path parameter with a secret name is protected', file: 'src/convert/url.ts', find: "pathValues.set(param.name, safe(param.name, param.value, 'pathparam'))", replace: 'pathValues.set(param.name, param.value)' },
  { id: 'M39', rule: 'the line and paragraph separators are hidden characters', file: 'src/util/chars.ts', find: '[0x2028, 0x2029],', replace: '[0x2028, 0x2027],' },
  { id: 'M40', rule: 'panel: only the script that carries the nonce may run', file: 'src/wizard/html.ts', find: "`script-src 'nonce-${nonce}'`", replace: "`script-src 'unsafe-inline'`" },
  { id: 'M41', rule: 'panel: a message is read from its own properties only', file: 'src/wizard/protocol.ts', find: 'Object.hasOwn(record, key) ? record[key] : undefined', replace: 'record[key]' },
  { id: 'M42', rule: 'panel: a path is shortened to ~ only at a folder boundary', file: 'src/util/display-path.ts', find: "next === '' || next === '/' || next === '\\\\'", replace: 'true' },
  { id: 'M43', rule: 'panel: pressing Import with no folder open says so', file: 'src/wizard/session.ts', find: "text: 'Open a folder first: the imported files are written inside it.'", replace: "text: 'x'" },
  { id: 'M44', rule: 'panel: Import writes only the plan that was shown (it plans again and compares)', file: 'src/wizard/session.ts', find: 'if (JSON.stringify(fresh) !== JSON.stringify(shown)) {', replace: 'if (JSON.stringify(fresh) === JSON.stringify(fresh) && false) {' },
  { id: 'M45', rule: 'panel: the REST Client settings are filled in only when the secrets were moved', file: 'src/wizard/session.ts', find: "options.applyRestClientSettings && options.moveSecrets) {", replace: 'options.applyRestClientSettings) {' },
  { id: 'M46', rule: 'the invisible tag characters are hidden characters', file: 'src/util/chars.ts', find: '[0xe0000, 0xe007f]', replace: '[0xe0000, 0xdffff]' },
  { id: 'M47', rule: 'the panel page cannot set a base address or submit a form', file: 'src/wizard/html.ts', find: `"base-uri 'none'",`, replace: '' },
  { id: 'M48', rule: 'a repeated request name is numbered from where the last one stopped, not from 2 again', file: 'src/emit/names.ts', find: 'let n = next.get(key) ?? 2;\n    let collided = false;', replace: 'let n = 2;\n    let collided = false;' },
  { id: 'M49', rule: 'a test the request already has is not inherited again (one set of keys)', file: 'src/convert/inherit.ts', find: 'key !== undefined && present.has(key);', replace: 'false;' },
  { id: 'M50', rule: 'the table of written folders in the report is cut', file: 'src/emit/report.ts', find: 'if (input.collections.length > ROWS_PER_LIST) out.push(', replace: 'if (false) out.push(' },
  { id: 'M20', rule: 'staging: nothing is left behind when a write fails', file: 'src/write/writer.ts', find: 'for (const step of undo.reverse()) {', replace: 'for (const step of [] as (() => Promise<void>)[]) {' }
];

function run(mutation) {
  const target = path.join(root, mutation.file);
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(mutation.find)) return { status: 'STALE', detail: 'the text to change is not in the file any more' };
  fs.writeFileSync(target, original.replace(mutation.find, () => mutation.replace));
  try {
    const result = spawnSync('npm', ['test'], { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout}\n${result.stderr}`;
    if (/error TS\d+/.test(output)) return { status: 'INVALID', detail: 'does not compile' };
    if (result.status === 0) return { status: 'SURVIVED', detail: 'all tests still pass' };
    const failed = (output.match(new RegExp(`^${String.fromCodePoint(0x2716)} .+$`, 'gm')) || []).filter((line, index, all) => all.indexOf(line) === index && !/failing tests/.test(line));
    return { status: 'KILLED', detail: failed.slice(0, 2).join(' | ') };
  } finally {
    fs.writeFileSync(target, original);
  }
}

const wanted = process.argv.slice(2);
const chosen = wanted.length === 0 ? MUTATIONS : MUTATIONS.filter(m => wanted.includes(m.id));
let bad = 0;
const lines = [];
for (const mutation of chosen) {
  const outcome = run(mutation);
  if (outcome.status !== 'KILLED') bad++;
  lines.push(`${mutation.id.padEnd(4)} ${outcome.status.padEnd(8)} ${mutation.rule}${outcome.status === 'KILLED' ? '' : `  [${outcome.detail}]`}`);
  process.stdout.write(`${lines[lines.length - 1]}\n`);
}
process.stdout.write(`\n${chosen.length - bad} of ${chosen.length} mutations killed.\n`);
process.exitCode = bad === 0 ? 0 : 1;
