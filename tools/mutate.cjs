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
  { id: 'M20', rule: 'staging: nothing is left behind when a write fails', file: 'src/write/writer.ts', find: 'for (const step of undo.reverse()) {', replace: 'for (const step of [] as (() => Promise<void>)[]) {' },
  { id: "M51", rule: "YAML: a key that appears twice is refused", file: "src/format/yaml/parse.ts", find: "if (map.has(entry.key)) this.fail(line, 0, `the key \"${entry.key}\" appears twice`);", replace: "" },
  { id: "M52", rule: "YAML: anchors are refused", file: "src/format/yaml/parse.ts", find: "if (first === '&') return 'anchors are not supported';", replace: "" },
  { id: "M53", rule: "YAML: aliases are refused", file: "src/format/yaml/parse.ts", find: "if (first === '*') return 'aliases are not supported';", replace: "" },
  { id: "M54", rule: "YAML: tags are refused", file: "src/format/yaml/parse.ts", find: "if (first === '!') return 'tags are not supported';", replace: "" },
  { id: "M55", rule: "YAML: flow collections are refused", file: "src/format/yaml/parse.ts", find: "if (first === '[' || first === '{') return 'flow", replace: "if (first === 'Z') return 'flow" },
  { id: "M56", rule: "YAML: a tab cannot indent a line", file: "src/format/yaml/parse.ts", find: "if (line.text.charCodeAt(0) === 9) this.fail(line, 0, 'a tab cannot indent a line; use spaces');", replace: "" },
  { id: "M57", rule: "YAML: the size limit counts bytes, not units", file: "src/format/yaml/parse.ts", find: "new TextEncoder().encode(text).length > limits.maxBytes", replace: "false" },
  { id: "M58", rule: "YAML: the nesting limit holds", file: "src/format/yaml/parse.ts", find: "if (depth > this.limits.maxDepth) this.fail", replace: "if (depth > this.limits.maxDepth * 100) this.fail" },
  { id: "M59", rule: "YAML: the limit on the number of nodes holds", file: "src/format/yaml/parse.ts", find: "if (++this.nodes > this.limits.maxNodes) this.fail", replace: "if (++this.nodes > this.limits.maxNodes * 100) this.fail" },
  { id: "M60", rule: "YAML: a block scalar needs content indented more than its key", file: "src/format/yaml/parse.ts", find: "if (head === undefined || head.indent <= indent) {", replace: "if (head === undefined || head.indent < indent) {" },
  { id: "M61", rule: "YAML: a list may sit at the indentation of its key", file: "src/format/yaml/parse.ts", find: "if (next !== undefined && next.indent === indent && isSequenceEntry(next.text)) return this.sequence(indent, depth + 1);", replace: "" },
  { id: "M62", rule: "YAML: control characters are refused", file: "src/format/yaml/parse.ts", find: "const control = CONTROL.exec(raw);", replace: "const control = /\\u0001/.exec(raw);" },
  { id: "M63", rule: "YAML: |+ keeps every trailing line break", file: "src/format/yaml/parse.ts", find: "return chomp === '+' ? `${text}\\n${'\\n'.repeat(trailing)}` : `${text}\\n`;", replace: "return chomp === '+' ? `${text}\\n${'\\n'.repeat(trailing + 1)}` : `${text}\\n`;" },
  { id: "M64", rule: "YAML: |- strips the last line break", file: "src/format/yaml/parse.ts", find: "if (chomp === '-') return text;", replace: "if (chomp === '-') return `${text}\\n`;" },
  { id: "M65", rule: "YAML: a value with \": \" inside is quoted when written", file: "src/format/yaml/emit.ts", find: "text.includes(': ') || text.includes(' #') || text.endsWith(':')", replace: "text.includes(' #') || text.endsWith(':')" },
  { id: "M66", rule: "YAML: a value with spaces around it is quoted when written", file: "src/format/yaml/emit.ts", find: "text !== text.trim() ||", replace: "" },
  { id: "M67", rule: "YAML: a lone surrogate is escaped when written (it cannot be UTF-8)", file: "src/format/yaml/emit.ts", find: "|| isLoneSurrogate(char);", replace: "|| false;" },
  { id: "M68", rule: "YAML: the block header tells how many line breaks end the string", file: "src/format/yaml/emit.ts", find: "const header = trailing === 0 ? '|-' : trailing === 1 ? '|' : '|+';", replace: "const header = trailing === 0 ? '|' : trailing === 1 ? '|-' : '|+';" },
  { id: "M69", rule: "YAML: true, false and whole numbers are written plain", file: "src/format/yaml/emit.ts", find: "return READABLE.test(text) ||", replace: "return false ||" },
  { id: "M70", rule: "YAML: a string that looks like a date is quoted when written", file: "src/format/yaml/emit.ts", find: "  /^\\d{4}-\\d\\d?-\\d\\d?(?:[Tt ].*)?$/,\n", replace: "" },
  { id: "M71", rule: "YAML: a value that starts with a brace is quoted when written", file: "src/format/yaml/emit.ts", find: "const PLAIN_START = /^[\\p{L}\\p{N}_$/.]/u;", replace: "const PLAIN_START = /^[\\p{L}\\p{N}_$/.{\\[]/u;" },
  { id: "M72", rule: "Core: the nearest base URL wins", file: "src/core/inherit.ts", find: "baseUrlFrom = level.name; break; }", replace: "baseUrlFrom = level.name; }" },
  { id: "M73", rule: "Core: the nearest authentication that was chosen wins", file: "src/core/inherit.ts", find: "authFrom = level.name; break; }", replace: "authFrom = level.name; }" },
  { id: "M74", rule: "Core: header names are compared without regard to case", file: "src/core/inherit.ts", find: "const named = new Set(rows.map(row => row.name.toLowerCase()));", replace: "const named = new Set(rows.map(row => row.name));" },
  { id: "M75", rule: "Core: a disabled nearer header removes the inherited one", file: "src/core/inherit.ts", find: "const named = new Set(rows.map(row => row.name.toLowerCase()));", replace: "const named = new Set(rows.filter(row => row.enabled).map(row => row.name.toLowerCase()));" },
  { id: "M76", rule: "Core: an assertion that an outer level already has is not added again", file: "src/core/inherit.ts", find: "|| seen.has(line.expr)", replace: "" },
  { id: "M77", rule: "Core: only the nearest levels count", file: "src/core/inherit.ts", find: "const levels = truncated ? chain.slice(chain.length - MAX_LEVELS) : chain;", replace: "const levels = chain;" },
  { id: "M78", rule: "Core: the request's own settings are nearer than every level", file: "src/core/inherit.ts", find: "mergeSettings(workspace, ...levels.map(level => level.container.settings), request.settings)", replace: "mergeSettings(workspace, request.settings, ...levels.map(level => level.container.settings))" },
  { id: "M79", rule: "Core: a URL that starts with a variable is not given a base URL", file: "src/core/inherit.ts", find: "|| url.startsWith('{{')", replace: "" },
  { id: "M80", rule: "Schema: a file of a newer version is refused", file: "src/format/schema/document.ts", find: "if (version > current) {", replace: "if (version > current + 100) {" },
  { id: "M81", rule: "Schema: an unknown key inside a nested mapping is reported", file: "src/format/schema/read.ts", find: "for (const key of this.rest().keys()) this.reader.warn(", replace: "for (const key of ([] as string[])) this.reader.warn(" },
  { id: "M82", rule: "Schema: an enabled row is written without the switch", file: "src/format/schema/common.ts", find: ".bool('enabled', row.enabled, true)", replace: ".bool('enabled', row.enabled, false)" },
  { id: "M83", rule: "Schema: a request has a parallel .http file unless it says otherwise", file: "src/format/schema/files.ts", find: "mirror: fields.bool('mirror', true)", replace: "mirror: fields.bool('mirror', false)" },
  { id: "M84", rule: "Schema: a request needs a name", file: "src/format/schema/files.ts", find: "if (name.trim() === '') fields.reader.error('name',", replace: "if (name.trim() === '' && false) fields.reader.error('name'," },
  { id: "M85", rule: "Core: an identifier sorts by time", file: "src/core/clock.ts", find: "CROCKFORD[time % 32]", replace: "CROCKFORD[time % 31]" },
  { id: "M86", rule: "Vars: the strongest scope is searched first", file: "src/core/vars.ts", find: "for (const scope of scopes) {", replace: "for (const scope of [...scopes].reverse()) {" },
  { id: "M87", rule: "Vars: a name that leads back to itself is a cycle", file: "src/core/vars.ts", find: "if (stack.includes(token.name)) note(cycles, token.name);", replace: "if (false) note(cycles, token.name);" },
  { id: "M88", rule: "Vars: variables nested too deeply are left alone", file: "src/core/vars.ts", find: "else if (depth >= maxDepth) truncated = true;", replace: "else if (false) truncated = true;" },
  { id: "M89", rule: "Vars: the size of the result is limited", file: "src/core/vars.ts", find: "if (size > maxBytes || replacements <= 0)", replace: "if (replacements <= 0)" },
  { id: "M90", rule: "Vars: the secret variables that were used are reported", file: "src/core/vars.ts", find: "if (found.secret) note(secrets, token.name);", replace: "" },
  { id: "M91", rule: "Vars: a guid is version 4", file: "src/core/vars.ts", find: "index === 12 ? '4'", replace: "index === 12 ? '5'" },
  { id: "M92", rule: "Vars: a timestamp is in whole seconds", file: "src/core/vars.ts", find: "String(Math.floor((clock.now() + offset) / 1000))", replace: "String((clock.now() + offset) / 1000)" },
  { id: "M93", rule: "Vars: a random integer can be the upper bound", file: "src/core/vars.ts", find: "Math.floor(clock.random() * (max - min + 1))", replace: "Math.floor(clock.random() * (max - min))" },
  { id: "M94", rule: "Vars: an unclosed {{ is plain text, found in one pass", file: "src/core/vars.ts", find: "if (open < 0 || open + 2 > lastClose) break;", replace: "if (open < 0) break;" },
  { id: "M95", rule: "Vars: text between braces that is not a name is not a variable", file: "src/core/vars.ts", find: "NAME.test(name) ? 'variable' : 'invalid'", replace: "'variable'" },
  { id: "M96", rule: "Vars: a disabled variable has no value", file: "src/core/vars.ts", find: "if (variable.enabled && variable.name !== '') scope.set(", replace: "if (variable.name !== '') scope.set(" },
  { id: "M97", rule: "Vars: the nearest folder's variables come before its parents'", file: "src/core/vars.ts", find: "for (let index = input.levels.length - 1; index >= 0; index--) scopes.push(", replace: "for (let index = 0; index < input.levels.length; index++) scopes.push(" },
  { id: "M98", rule: "Vars: the civil date arithmetic is right", file: "src/core/vars.ts", find: "monthIndex < 10 ? monthIndex + 3 : monthIndex - 9", replace: "monthIndex < 10 ? monthIndex + 4 : monthIndex - 9" },
  { id: "M99", rule: "Vars: a day is 86400000 ms in a time offset", file: "src/core/vars.ts", find: "d: 86_400_000", replace: "d: 86_000_000" },
  { id: "M100", rule: "Storage: a file name is the name in lower case with hyphens", file: "src/storage/store.ts", find: "name.toLowerCase().replace(/\\s+/g, '-')", replace: "name.replace(/\\s+/g, '-')" },
  { id: "M101", rule: "Storage: folders come before requests when nothing says otherwise", file: "src/storage/store.ts", find: "(a.kind === 'request' ? 1 : 0) - (b.kind === 'request' ? 1 : 0) ||", replace: "" },
  { id: "M102", rule: "Storage: an entry named twice in the order is shown once", file: "src/storage/store.ts", find: "if (node !== undefined && !placed.has(slug)) {", replace: "if (node !== undefined) {" },
  { id: "M103", rule: "Storage: the value of a secret variable stays out of the shared file", file: "src/storage/secrets.ts", find: "return { ...variable, value: '' };", replace: "return variable;" },
  { id: "M104", rule: "Storage: only secret variables are split off", file: "src/storage/secrets.ts", find: "if (!variable.secret) return variable;\n    if (variable.value !== '') secrets[variable.name]", replace: "if (false) return variable;\n    if (variable.value !== '') secrets[variable.name]" },
  { id: "M105", rule: "Storage: the file of secrets is private", file: "src/storage/store.ts", find: "const LOCAL_FILE_MODE = 0o600;", replace: "const LOCAL_FILE_MODE = 0o644;" },
  { id: "M106", rule: "Storage: the file of secrets is kept out of Git", file: "src/storage/store.ts", find: "const GITIGNORE_LINES = ['*.local.yml', '.runs/'];", replace: "const GITIGNORE_LINES = ['.runs/'];" },
  { id: "M107", rule: "Storage: a folder cannot be moved into itself", file: "src/storage/store.ts", find: "(targetDir === node.path || targetDir.startsWith(`${node.path}/`))", replace: "(targetDir === node.path)" },
  { id: "M108", rule: "Storage: a collection cannot be moved", file: "src/storage/store.ts", find: "if (node.kind === 'collection') throw new StoreError('A collection cannot be moved into another one.');", replace: "" },
  { id: "M109", rule: "Storage: a removed entry leaves the order of its folder", file: "src/storage/store.ts", find: "else if (node.kind !== 'collection') await this.removeFromOrder(parentPath(node.path), node.slug);", replace: "" },
  { id: "M110", rule: "Storage: a folder nested too deeply is left out", file: "src/storage/store.ts", find: "if (depth > STORAGE_LIMITS.maxDepth) {", replace: "if (depth > STORAGE_LIMITS.maxDepth + 100) {" },
  { id: "M111", rule: "Storage: a folder with too many entries is cut", file: "src/storage/store.ts", find: "if (entries.length <= STORAGE_LIMITS.maxEntriesPerFolder) return entries;", replace: "if (entries.length <= STORAGE_LIMITS.maxEntriesPerFolder * 100) return entries;" },
  { id: "M112", rule: "Storage: a folder of attachments is not a folder of requests", file: "src/storage/store.ts", find: "if (implicit && children.length === 0) return undefined;", replace: "" },
  { id: "M113", rule: "Storage: a folder under collections without collection.yml is not a collection", file: "src/storage/store.ts", find: "} else if (kind === 'collection') {", replace: "} else if (false) {" },
  { id: "M114", rule: "NodeFs: a file is never read through a link in a folder above it", file: "src/storage/node-fs.ts", find: "const { absolute, segments } = this.resolve(path);\n    await this.checkAncestors(segments);\n    let stats;", replace: "const { absolute, segments } = this.resolve(path);\n    void segments;\n    let stats;" },
  { id: "M115", rule: "NodeFs: a target that is a folder or a link is not replaced", file: "src/storage/node-fs.ts", find: "if (!existing.isFile()) throw new Error('the target is a link or a folder: it is not replaced');", replace: "" },
  { id: "M116", rule: "NodeFs: the root of the workspace is not removed", file: "src/storage/node-fs.ts", find: "if (segments.length === 0) throw new Error('the root of the workspace is not removed');", replace: "" },
  { id: "M117", rule: "NodeFs: a rename does not replace what exists", file: "src/storage/node-fs.ts", find: "if (await this.exists(to)) throw new Error(`${to} exists already`);", replace: "" },
  { id: "M118", rule: "NodeFs: a file over the size limit is refused", file: "src/storage/node-fs.ts", find: "stats.size > STORAGE_LIMITS.maxFileBytes", replace: "stats.size > STORAGE_LIMITS.maxFileBytes * 1000" },
  { id: "M119", rule: "NodeFs: a name that is not allowed is refused", file: "src/storage/node-fs.ts", find: "if (problem !== undefined) throw new Error(`the name \"${segment}\" is not allowed: ${problem}`);", replace: "" },
  { id: "M120", rule: "NodeFs: a link to a folder is not listed", file: "src/storage/node-fs.ts", find: "if (segments.length > 0 && !(await disk.lstat(absolute)).isDirectory()) return [];", replace: "" },
  { id: "M121", rule: "Engine: a redirect from https to http is not followed", file: "src/engine/redirect.ts", find: "if (from.protocol === 'https:' && to.protocol === 'http:' && !policy.allowDowngrade) return { follow: false", replace: "if (false) return { follow: false" },
  { id: "M122", rule: "Engine: a redirect from a public address to this machine is not followed", file: "src/engine/redirect.ts", find: "if (isLocalHost(to.hostname) && !isLocalHost(from.hostname) && !policy.allowLocal) return { follow: false", replace: "if (false) return { follow: false" },
  { id: "M123", rule: "Engine: the same origin keeps its credentials on a redirect", file: "src/engine/redirect.ts", find: "const crossOrigin = originOf(from) !== originOf(to);", replace: "const crossOrigin = true;" },
  { id: "M124", rule: "Engine: a header with a secret name does not cross to another origin", file: "src/engine/redirect.ts", find: "headers: without(current.headers, dropped, crossOrigin)", replace: "headers: without(current.headers, dropped, false)" },
  { id: "M125", rule: "Engine: a 303 turns the request into a GET", file: "src/engine/redirect.ts", find: "status === 303 ? current.method.toUpperCase() !== 'HEAD' :", replace: "status === 303 ? false :" },
  { id: "M126", rule: "Engine: a 307 and a 308 send the body again", file: "src/engine/redirect.ts", find: "if (!dropBody && current.body !== undefined) request.body = current.body;", replace: "" },
  { id: "M127", rule: "Engine: a redirect to a scheme other than http and https is not followed", file: "src/engine/redirect.ts", find: "if (to.protocol !== 'http:' && to.protocol !== 'https:') return", replace: "if (false) return" },
  { id: "M128", rule: "Engine: a link-local address is a local address", file: "src/engine/redirect.ts", find: "return v4[1] === '127' || (v4[1] === '169' && v4[2] === '254');", replace: "return v4[1] === '127';" },
  { id: "M129", rule: "Engine: the number of redirects is limited", file: "src/engine/send.ts", find: "if (redirects.length >= options.maxRedirects) throw", replace: "if (redirects.length > options.maxRedirects) throw" },
  { id: "M130", rule: "Engine: the cookie of the person is kept when the jar adds its own", file: "src/engine/send.ts", find: "`${headers[own]?.[1] ?? ''}; ${header}`", replace: "header" },
  { id: "M131", rule: "Engine: a header the person wrote is not given a default", file: "src/engine/send.ts", find: "if (!hasHeader(headers, 'user-agent'))", replace: "if (true)" },
  { id: "M132", rule: "Engine: a redirect starts from the request without the jar's cookies", file: "src/engine/send.ts", find: "nextHop(current, status, location, policy)", replace: "nextHop(attempt, status, location, policy)" },
  { id: "M133", rule: "Engine: a body over the memory limit is cut", file: "src/engine/transport.ts", find: "this.size + chunk.length <= this.limit", replace: "this.size + chunk.length <= this.limit * 100" },
  { id: "M134", rule: "Engine: a server that sends nothing for a while times out", file: "src/engine/transport.ts", find: "req.setTimeout(options.idleTimeoutMs, () =>", replace: "req.setTimeout(options.idleTimeoutMs * 1000, () =>" },
  { id: "M135", rule: "Engine: certificates are checked unless the request says otherwise", file: "src/engine/transport.ts", find: "requestOptions.rejectUnauthorized = options.tls.rejectUnauthorized;", replace: "requestOptions.rejectUnauthorized = false;" },
  { id: "M136", rule: "Engine: a decompression bomb is stopped by its ratio", file: "src/engine/decode.ts", find: "this.bytes > this.limits.maxRatio * Math.max(1, this.wire.bytes)", replace: "this.bytes > this.limits.maxRatio * 1e12" },
  { id: "M137", rule: "Engine: the decoded size is limited", file: "src/engine/decode.ts", find: "if (this.bytes > this.limits.maxBytes) {", replace: "if (this.bytes > this.limits.maxBytes * 1000) {" },
  { id: "M138", rule: "Engine: loopback addresses go direct unless asked", file: "src/engine/proxy.ts", find: "if (isLoopback(host) && config.proxyLoopback !== true) return undefined;", replace: "" },
  { id: "M139", rule: "Engine: a no-proxy domain matches its subdomains and not a name that merely ends the same", file: "src/engine/proxy.ts", find: "name === entry || name.endsWith(`.${entry}`)", replace: "name === entry || name.endsWith(entry)" },
  { id: "M140", rule: "Engine: only http proxies are accepted", file: "src/engine/proxy.ts", find: "if (url.protocol !== 'http:') throw", replace: "if (false) throw" },
  { id: "M141", rule: "Engine: an Authorization header the person wrote wins", file: "src/engine/build.ts", find: "if (explicitAuthorization) {", replace: "if (false) {" },
  { id: "M142", rule: "Engine: the fragment is not sent", file: "src/engine/build.ts", find: ".replace(/#.*$/s, '')", replace: "" },
  { id: "M143", rule: "Engine: a path parameter is encoded", file: "src/engine/build.ts", find: "encodeURIComponent(values.get(name) as string)", replace: "(values.get(name) as string)" },
  { id: "M144", rule: "Engine: the multipart content type has the boundary that is used", file: "src/engine/build.ts", find: "if (existing >= 0) headers.splice(existing, 1);", replace: "" },
  { id: "M145", rule: "Engine: a form field space is a plus", file: "src/engine/build.ts", find: ".replace(/%20/g, '+')", replace: "" },
  { id: "M146", rule: "Cookies: a Secure cookie is not accepted over http", file: "src/core/cookies.ts", find: "if (secure && !secureOrigin) return;", replace: "" },
  { id: "M147", rule: "Cookies: a public suffix cannot be claimed", file: "src/core/cookies.ts", find: "|| PUBLIC_SUFFIXES.has(domain)", replace: "" },
  { id: "M148", rule: "Cookies: Max-Age wins over Expires", file: "src/core/cookies.ts", find: "const lifetime = maxAge !== undefined ? time + maxAge * 1000 : expires;", replace: "const lifetime = expires !== undefined ? expires : maxAge !== undefined ? time + maxAge * 1000 : undefined;" },
  { id: "M149", rule: "Cookies: __Host- cookies keep their promises", file: "src/core/cookies.ts", find: "if (name.startsWith('__Host-') && (!secure || domainAttribute !== '' || (pathAttribute !== '' && pathAttribute !== '/'))) return;", replace: "" },
  { id: "M150", rule: "Cookies: a path matches at a slash boundary", file: "src/core/cookies.ts", find: "return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';", replace: "return true;" },
  { id: "M151", rule: "Cookies: the longest path goes first", file: "src/core/cookies.ts", find: "b.path.length - a.path.length ||", replace: "" },
  { id: "M152", rule: "Cookies: a domain holds a limited number", file: "src/core/cookies.ts", find: "if (sameDomain.length > JAR_LIMITS.cookiesPerDomain) {", replace: "if (sameDomain.length > JAR_LIMITS.cookiesPerDomain * 1000) {" },
  { id: "M153", rule: "Redaction: a short value is not searched for in text", file: "src/core/redact.ts", find: "values = [...new Set(secrets.filter(value => value.length >= MIN_SECRET_LENGTH))]", replace: "values = [...new Set(secrets.filter(value => value.length >= 1))]" },
  { id: "M154", rule: "Redaction: the cookie is a credential that does not cross origins", file: "src/core/redact.ts", find: "['authorization', 'proxy-authorization', 'cookie']", replace: "['authorization', 'proxy-authorization']" },
  { id: "M155", rule: "View: a filter searches the address of a request too", file: "src/view/tree.ts", find: "[node.request.name, node.request.method, node.request.url].some(", replace: "[node.request.name, node.request.method].some(" },
  { id: "M156", rule: "View: a folder that matches by name shows everything in it", file: "src/view/tree.ts", find: "const sub = containerNode(child, own ? '' : filter);", replace: "const sub = containerNode(child, filter);" },
  { id: "M157", rule: "View: with a filter only the matches are shown, not the files that cannot be read", file: "src/view/tree.ts", find: "if (wanted === '') {\n    for (const broken", replace: "if (true) {\n    for (const broken" },
  { id: "M158", rule: "View: only the active environment is marked", file: "src/view/tree.ts", find: "const active = activeId !== undefined && node.environment.id === activeId;", replace: "const active = activeId !== undefined;" },
  { id: "M160", rule: "Edit: only the fields of a request can be edited", file: "src/view/edit.ts", find: "typeof first !== 'string' || !EDITABLE.has(first)", replace: "typeof first !== 'string'" },
  { id: "M161", rule: "Edit: a row that is not there cannot be set", file: "src/view/edit.ts", find: "if (typeof key !== 'number' || key >= parent.length) throw", replace: "if (typeof key !== 'number') throw" },
  { id: "M162", rule: "Edit: a list holds a limited number of rows", file: "src/view/edit.ts", find: "op.index > list.length || list.length >= MAX_ROWS", replace: "op.index > list.length" },
  { id: "M163", rule: "Edit: a row that is not there cannot be removed", file: "src/view/edit.ts", find: "if (op.index >= list.length) throw", replace: "if (op.index > list.length) throw" },
  { id: "M164", rule: "Edit: a row cannot be moved to a place beyond the list", file: "src/view/edit.ts", find: "op.from >= list.length || op.to >= list.length", replace: "op.from >= list.length" },
  { id: "M165", rule: "Edit: a request that has grown too large is refused", file: "src/view/edit.ts", find: "JSON.stringify(draft).length > MAX_VALUE_CHARS", replace: "JSON.stringify(draft).length > MAX_VALUE_CHARS * 1000" },
  { id: "M166", rule: "Edit: the lines before the change are kept", file: "src/view/edit.ts", find: "oldLines[prefix] === newLines[prefix]) prefix++;", replace: "false) prefix++;" },
  { id: "M167", rule: "Edit: the lines after the change are kept", file: "src/view/edit.ts", find: "suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&", replace: "suffix < 0 &&" },
  { id: "M169", rule: "Edit: lines followed by another line are replaced with their line break", file: "src/view/edit.ts", find: "if (endLine <= last) {", replace: "if (endLine < last) {" },
  { id: "M170", rule: "Edit: removing the last lines takes the line break before them", file: "src/view/edit.ts", find: "if (lines.length === 0 && startLine > 0) return", replace: "if (lines.length === 0 && startLine > 1) return" },
  { id: "M171", rule: "Protocol: a path cannot name a key that reaches the prototype", file: "src/view/request-protocol.ts", find: "part.length <= 64 && !FORBIDDEN_KEYS.has(part)", replace: "part.length <= 64" },
  { id: "M172", rule: "Protocol: a value cannot carry a key that reaches the prototype", file: "src/view/request-protocol.ts", find: "Object.keys(item).every(key => !FORBIDDEN_KEYS.has(key) && walk(", replace: "Object.keys(item).every(key => walk(" },
  { id: "M173", rule: "Protocol: a message holds a limited number of edits", file: "src/view/request-protocol.ts", find: "ops.length === 0 || ops.length > MAX_OPS", replace: "ops.length === 0 || ops.length > MAX_OPS * 100" },
  { id: "M174", rule: "Protocol: a path is short", file: "src/view/request-protocol.ts", find: "value.length === 0 || value.length > MAX_PATH_LENGTH", replace: "value.length === 0 || value.length > MAX_PATH_LENGTH * 100" },
  { id: "M175", rule: "Protocol: an index is a whole number", file: "src/view/request-protocol.ts", find: "typeof value === 'number' && Number.isInteger(value) && value >= 0", replace: "typeof value === 'number' && value >= 0" },
  { id: "M176", rule: "Page: the styles of the page need the nonce", file: "src/view/page.ts", find: "`style-src ${cspSource} 'nonce-${nonce}'`", replace: "`style-src ${cspSource} 'unsafe-inline'`" },
  { id: "M177", rule: "Page: everything not allowed is refused", file: "src/view/page.ts", find: "\"default-src 'none'\",", replace: "\"default-src 'self'\"," },
  { id: "M178", rule: "Page: a script runs only with the nonce", file: "src/view/page.ts", find: "`script-src 'nonce-${nonce}'`", replace: "`script-src ${cspSource} 'nonce-${nonce}'`" },
  { id: "M179", rule: "Response: JSON nests only so deep", file: "src/view/response.ts", find: "if (stack.length >= MAX_JSON_DEPTH) return undefined;", replace: "" },
  { id: "M180", rule: "Response: a JSON number has no leading zero", file: "src/view/response.ts", find: "/-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/y", replace: "/-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/y" },
  { id: "M181", rule: "Response: a JSON string has no raw control character", file: "src/view/response.ts", find: "if (c < 0x20) return false;", replace: "" },
  { id: "M182", rule: "Response: nothing may follow a JSON value", file: "src/view/response.ts", find: "return pos === n ? out.join('') : undefined;", replace: "return out.join('');" },
  { id: "M183", rule: "Response: XML closes the element it opened", file: "src/view/response.ts", find: "if (open.pop() !== nameOf(token)) return undefined;", replace: "open.pop();" },
  { id: "M184", rule: "Response: XML with an element left open is not formatted", file: "src/view/response.ts", find: "return open.length === 0 ? lines.join('\\n') : undefined;", replace: "return lines.join('\\n');" },
  { id: "M185", rule: "Response: half of a picture is not shown as a picture", file: "src/view/response.ts", find: "if (bytes.length === size && size <= IMAGE_LIMIT_BYTES) return", replace: "if (bytes.length > 0) return" },
  { id: "M186", rule: "Response: a zero byte makes a body binary", file: "src/view/response.ts", find: "if (bytes[index] === 0) return true;", replace: "if (bytes[index] === -1) return true;" },
  { id: "M187", rule: "Response: UTF-16 with a mark is text", file: "src/view/response.ts", find: "if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;", replace: "" },
  { id: "M188", rule: "Response: a cut does not split a pair", file: "src/view/response.ts", find: "if (last >= 0xd800 && last <= 0xdbff) end--;", replace: "" },
  { id: "M189", rule: "Response: a body that is cut is not formatted", file: "src/view/response.ts", find: "if (!cut) {", replace: "if (true) {" },
  { id: "M190", rule: "Response: the address sent is shown without its secrets", file: "src/view/response.ts", find: "url: printable(redactValues(wire.url, redactions)),", replace: "url: printable(wire.url)," },
  { id: "M191", rule: "Response: the headers sent are shown without their secrets", file: "src/view/response.ts", find: "printable(redactedValue(name, value, redactions))]),", replace: "printable(value)])," },
  { id: "M192", rule: "Response: a file sent is shown by its name, not its place", file: "src/view/response.ts", find: "printable(body.path.split(/[\\\\/]/).pop() ?? 'file')", replace: "printable(body.path)" },
  { id: "M193", rule: "Response: a long body sent is cut", file: "src/view/response.ts", find: "const more = body.bytes.length > SENT_BODY_LIMIT;", replace: "const more = false;" },
  { id: "M194", rule: "Response: the value of a form part with a secret name is hidden", file: "src/view/response.ts", find: "redactedValue(part.name, part.value ?? '', redactions)", replace: "part.value ?? ''" },
  { id: "M195", rule: "Response: sizes of 100 or more units have no decimal", file: "src/view/response.ts", find: "value >= 100 ? Math.round(value)", replace: "value >= 1000 ? Math.round(value)" },
  { id: "M196", rule: "Prepare: an address with no scheme gets http://", file: "src/engine/prepare.ts", find: "built.wire.url = `http://${url}`;", replace: "built.wire.url = url;" },
  { id: "M197", rule: "Prepare: a path with no host is a problem", file: "src/engine/prepare.ts", find: "url.startsWith('/') || url.startsWith('?')", replace: "url.startsWith('?')" },
  { id: "M198", rule: "Prepare: only the active environment is used", file: "src/engine/prepare.ts", find: "item.environment.id === input.environmentId", replace: "true" },
  { id: "M199", rule: "Prepare: variables that refer to themselves are a problem", file: "src/engine/prepare.ts", find: "if (built.cycles.length > 0) problems.push(", replace: "if (false) problems.push(" },
  { id: "M200", rule: "Prepare: files are looked for in the folder of the collection", file: "src/engine/prepare.ts", find: "input.resolveFile(located.collection.path, relative)", replace: "input.resolveFile('', relative)" },
  { id: "M201", rule: "Prepare: the folders above the request are part of what it inherits", file: "src/engine/prepare.ts", find: "const here = [...chain, container];", replace: "const here = [container];" },
  { id: "M202", rule: "Prepare: the settings of the workspace apply", file: "src/engine/prepare.ts", find: "effectiveRequest(input.request, levels, input.loaded.workspace.file.settings)", replace: "effectiveRequest(input.request, levels)" },
  { id: "M203", rule: "Prepare: what a run has set beats the files", file: "src/engine/prepare.ts", find: "...(input.runtime === undefined ? {} : { runtime: input.runtime })", replace: "" },
  { id: "M204", rule: "Files: a path with .. is refused", file: "src/engine/files.ts", find: "segments.includes('..')", replace: "false" },
  { id: "M205", rule: "Files: an absolute path or a drive is refused", file: "src/engine/files.ts", find: "if (/^[\\\\/]|^[A-Za-z]:/.test(relative)) return undefined;", replace: "" },
  { id: "M206", rule: "Files: a link on the way is refused", file: "src/engine/files.ts", find: "if (stats.isSymbolicLink()) return undefined;", replace: "" },
  { id: "M207", rule: "Files: only a plain file is sent", file: "src/engine/files.ts", find: "return stats !== undefined && stats.isFile() ? current : undefined;", replace: "return stats !== undefined ? current : undefined;" },
  { id: "M208", rule: "Files: a very long name is refused", file: "src/engine/files.ts", find: "relative.length > 1024", replace: "relative.length > 1024000" },
  { id: "M209", rule: "Inherit: spaces before an address do not make it relative", file: "src/core/inherit.ts", find: "const start = url.trimStart();", replace: "const start = url;" },
  { id: "M210", rule: "Cookies: a header that is too long is not a cookie", file: "src/core/cookies.ts", find: "if (header.length > JAR_LIMITS.headerBytes) return undefined;", replace: "" },
  { id: "M211", rule: "Protocol: a report of the policy is cut", file: "src/view/request-protocol.ts", find: "text: text.slice(0, 200)", replace: "text" },
  { id: "M212", rule: "Tabs: a request with a body opens on it", file: "src/view/tabs.ts", find: "if (request.body.kind !== 'none') return 'body';", replace: "" }
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
