import type { ImpAuth, ImpBody, ImpHeader, ImpRequest, ImpSkipped } from '../model/ir';
import type { TcSettings } from '../model/source';
import type { Target } from '../model/target';
import { Coercions } from '../normalize/coerce';
import { isRecord } from '../normalize/guards';
import type { FindingSink } from '../normalize/sink';
import { readText } from '../normalize/text';
import type { TreeRequest } from '../normalize/tree';
import { displayLabel } from '../util/chars';
import { convertAuth } from './auth';
import { convertBody, token } from './body';
import type { Issue } from './body';
import { combineHeaders, ensureContentType, readHeaders } from './headers';
import { applyBaseUrl, collectScripts, InheritBudget, inheritedBaseUrl, inheritHeaders, inheritTests, MAX_INHERIT_LEVELS, resolveAuth, settingsLevels } from './inherit';
import { SECRET_VARIABLE, SecretStore } from './secrets';
import { neutralizeExpressions } from './expressions';
import { mapSystemVariables } from './sysvars';
import { convertTests } from './tests';
import { cleanLine, hasLiteral } from './text';
import { convertUrl } from './url';
import type { ParamInput } from './url';

/**
 * One request of the tree becomes one request of the intermediate model: the rules N2 to N4, N8, N9, N15 to N19 and
 * sections 5.2 to 5.9 of the spec, then the protection of secrets (8.3). The state of the collection being converted is
 * passed in; everything that is counted for a whole collection is reported once, by `flushCollection`.
 */
export interface ConvertState {
  /** The collection's name as it is shown. */
  label: string;
  /** The collection's own name and settings, the last level of every request's inheritance chain. */
  collection: { name: string; settings: TcSettings | undefined };
  /** The tool the files are written for. */
  target: Target;
  coerce: Coercions;
  sink: FindingSink;
  secrets: SecretStore;
  budget: InheritBudget;
  skipped: ImpSkipped[];
  counts: {
    requests: number;
    defaultHeaders: number;
    inheritedHeaders: number;
    inheritedAuth: number;
    inheritedBaseUrl: number;
    inheritedTests: number;
    settingsDropped: number;
    secretsMoved: number;
    truncated: boolean;
    budgetReported: boolean;
    unmapped: Set<string>;
    /** Spans of {{ }} that looked like code and were made harmless (spec 5.7a). */
    neutralized: number;
  };
}

export function newState(label: string, collection: ConvertState['collection'], shared: { target: Target; sink: FindingSink; secrets: SecretStore; budget: InheritBudget; skipped: ImpSkipped[] }): ConvertState {
  return {
    label, collection, coerce: new Coercions(), ...shared,
    counts: { requests: 0, defaultHeaders: 0, inheritedHeaders: 0, inheritedAuth: 0, inheritedBaseUrl: 0, inheritedTests: 0, settingsDropped: 0, neutralized: 0, secretsMoved: 0, truncated: false, budgetReported: false, unmapped: new Set<string>() }
  };
}

const METHOD = /^[A-Z][A-Z0-9_-]{0,31}$/;

function readParams(list: unknown, coerce: Coercions): ParamInput[] {
  const params: ParamInput[] = [];
  if (!Array.isArray(list)) return params;
  for (const item of list) {
    if (!isRecord(item)) continue;
    params.push({ name: coerce.string(item['name']), value: coerce.string(item['value']), enabled: !coerce.flag(item['isDisabled']), isPath: coerce.flag(item['isPath']) });
  }
  return params;
}

export function convertRequest(item: TreeRequest, state: ConvertState): ImpRequest | undefined {
  const { sink, secrets, coerce, counts } = state;
  const request = item.request;
  const name = coerce.string(request.name);
  const where = `${state.label} / ${displayLabel(name)}`;
  const report = (code: Issue['code'], message?: string): void => sink.add(state.label, code, where, message);

  // N9: the kind of request
  const reqType = request.reqType === undefined ? '' : coerce.string(request.reqType);
  if (reqType !== '' && reqType !== 'http' && reqType !== 'graphql') {
    report('TC-REQTYPE-UNSUPPORTED', `A ${token(reqType)} request cannot be converted and was skipped.`);
    state.skipped.push({ collection: state.label, request: displayLabel(name), reason: `${token(reqType)} request` });
    return undefined;
  }
  counts.requests++;

  // N8: the method
  let method = coerce.string(request.method).trim().toUpperCase();
  if (method === '') method = 'GET';
  else if (!METHOD.test(method)) { report('TC-METHOD-INVALID'); method = 'GET'; }

  // N15 to N19: what the folders and the collection above add
  const { levels, truncated } = settingsLevels(item.ancestry, state.collection, MAX_INHERIT_LEVELS);
  if (truncated && !counts.truncated) {
    counts.truncated = true;
    sink.add(state.label, 'TC-DEPTH', state.label, `Settings inherited from folders more than ${MAX_INHERIT_LEVELS} levels above a request were ignored.`);
  }
  let lineBreak = false;
  const line = (text: string): string => { const clean = cleanLine(text); lineBreak ||= clean.lineBreak; return clean.text; };
  // Text that looks like code between {{ }} is made harmless first (httpYac runs it); then Thunder's dynamic variables are mapped.
  const vars = (text: string): string => {
    const safe = neutralizeExpressions(text);
    counts.neutralized += safe.count;
    return mapSystemVariables(safe.text, counts.unmapped, state.target);
  };

  // Protection of secrets: what is literal and sensitive goes to the private file (or stays and is reported).
  const protect = (label: string, value: string, kind: 'header' | 'value'): { text: string; literal: boolean } => {
    const result = kind === 'header' ? secrets.protectHeader(state.label, label, value) : secrets.protect(state.label, label, value);
    if (result.moved) counts.secretsMoved++;
    return { text: result.text, literal: result.literal };
  };
  const literalSecrets: string[] = [];
  const protectNamed = (name: string, value: string, prefix: string): string => {
    if (!SECRET_VARIABLE.test(name) || !hasLiteral(value)) return value;
    const result = protect(`${prefix}_${name}`, value, 'value');
    if (result.literal) literalSecrets.push(name);
    return result.text;
  };

  // The URL: base URL (N15), then the query and the path parameters (N2, N3)
  let rawUrl = coerce.string(request.url);
  const base = inheritedBaseUrl(levels);
  if (base !== undefined) {
    const prefixed = applyBaseUrl(rawUrl, base.value);
    if (prefixed !== rawUrl) { counts.inheritedBaseUrl++; rawUrl = prefixed; }
  }
  const converted = convertUrl(vars(rawUrl), readParams(request.params, coerce).map(param => ({ ...param, name: vars(param.name), value: vars(param.value) })), (paramName, value) => protectNamed(paramName, value, 'query'));
  if (converted.appended > 0) report('TC-PARAM-NOT-IN-URL', `${converted.appended} enabled query ${converted.appended === 1 ? 'parameter was' : 'parameters were'} missing from the URL and ${converted.appended === 1 ? 'was' : 'were'} appended.`);
  if (converted.emptyPathParams > 0) report('TC-PATHPARAM-EMPTY');
  lineBreak ||= converted.lineBreak;

  // Headers (N17, N4), the body, and the Content-Type the body needs
  const own = readHeaders(request.headers, coerce);
  const combined = combineHeaders(own, inheritHeaders(own, levels, state.budget));
  counts.defaultHeaders += combined.defaultsDropped > 0 ? 1 : 0;
  counts.inheritedHeaders += combined.inherited > 0 ? 1 : 0;
  if (combined.caseDuplicates > 0) report('TC-HEADER-DUP');

  const bodyResult = convertBody(request.body, coerce);
  for (const issue of bodyResult.issues) report(issue.code, issue.message);
  let headers: ImpHeader[] = bodyResult.contentType === undefined ? combined.headers : ensureContentType(combined.headers, bodyResult.contentType);

  // Authentication (N16) and its conflict with an explicit Authorization header
  const resolved = resolveAuth(request.auth, levels);
  if (resolved.source === 'inherited') counts.inheritedAuth++;
  const authResult = convertAuth(resolved.auth, coerce);
  if (authResult.issue !== undefined) report(authResult.issue.code, authResult.issue.message);
  let auth: ImpAuth | undefined = authResult.auth;
  if ((auth?.kind === 'bearer' || auth?.kind === 'basic') && headers.some(header => header.enabled && header.name.toLowerCase() === 'authorization')) {
    report('TC-AUTH-HEADER-CONFLICT');
    auth = undefined;
  }
  if (auth?.kind === 'bearer') {
    const result = protect('bearer_token', vars(auth.token.value), 'value');
    if (result.literal) literalSecrets.push('bearer token');
    auth = { kind: 'bearer', token: { value: line(result.text), secret: result.literal } };
  } else if (auth?.kind === 'basic') {
    const result = protect('basic_password', vars(auth.password.value), 'value');
    if (result.literal) literalSecrets.push('basic password');
    auth = { kind: 'basic', username: { value: line(vars(auth.username.value)), secret: false }, password: { value: line(result.text), secret: result.literal } };
  }

  // Header values: dynamic variables, one line, secrets (a disabled header is a comment in the file, so it is protected too)
  headers = headers.map(header => {
    const value = line(vars(header.value));
    const result = protect(header.name, value, 'header');
    if (result.literal) literalSecrets.push(header.name);
    return { name: line(vars(header.name)), value: result.text, enabled: header.enabled, secret: result.literal };
  });

  let body: ImpBody | undefined = bodyResult.body;
  if (body?.kind === 'text') body = { ...body, text: vars(body.text) };
  else if (body?.kind === 'graphql') body = { kind: 'graphql', query: vars(body.query), ...(body.variables === undefined ? {} : { variables: vars(body.variables) }) };
  else if (body?.kind === 'form') body = { kind: 'form', fields: body.fields.map(field => ({ name: vars(field.name), value: protectNamed(field.name, vars(field.value), 'form'), enabled: field.enabled })) };
  else if (body?.kind === 'multipart') {
    body = { kind: 'multipart', parts: body.parts.map(part => (part.filePath !== undefined ? { name: vars(part.name), filePath: vars(part.filePath), enabled: part.enabled } : { name: vars(part.name), value: protectNamed(part.name, vars(part.value ?? ''), 'form'), enabled: part.enabled })) };
  }

  // Tests (N18) become assertions and captures
  const ownTests = Array.isArray(request.tests) ? request.tests : [];
  const inheritedTests = inheritTests(ownTests, levels, state.budget);
  if (inheritedTests.length > 0) counts.inheritedTests++;
  const tests = convertTests([...ownTests, ...inheritedTests.map(entry => entry.test)], coerce);
  for (const text of tests.unsupported) report('TC-TEST-UNSUPPORTED', `A ${text} test has no equivalent and was left out.`);
  if (tests.jsonPathGuesses > 0) report('TC-JSONPATH-GUESS');

  // Scripts (N19) are kept as comments, never run
  const scripts = collectScripts(request, levels);
  const skippedScripts = [...scripts.pre.map(block => ({ phase: 'pre' as const, ...block })), ...scripts.post.map(block => ({ phase: 'post' as const, ...block }))];
  if (skippedScripts.length > 0) {
    const n = skippedScripts.length;
    report('TC-SCRIPT-SKIPPED', `${n} ${n === 1 ? 'script was' : 'scripts were'} not imported and ${n === 1 ? 'is' : 'are'} kept as comments; review ${n === 1 ? 'it' : 'them'} for secrets.${scripts.skipRequest ? ' This request only runs scripts.' : ''}`);
  }
  if (scripts.runRequests) report('TC-PREREQ-RUN');

  if (literalSecrets.length > 0) report('TC-SECRET-LITERAL', `A literal credential stays in ${[...new Set(literalSecrets)].map(displayLabel).join(', ')}.`);
  if (lineBreak) report('TC-LINEBREAK-REPLACED');

  // Cookies and the request's own settings (timeout, redirects...) have no place in a .http file.
  if ((Array.isArray(request.cookies) && request.cookies.length > 0) || (isRecord(request.settings) && Object.keys(request.settings).length > 0)) counts.settingsDropped++;

  const docs = readText(request.docs);
  if (docs.coerced) coerce.count++;
  const notes = [...(authResult.note === undefined ? [] : [authResult.note]), ...bodyResult.notes];

  return {
    sourceId: coerce.string(request._id),
    name,
    ...(docs.text.trim() === '' ? {} : { docs: docs.text }),
    method,
    url: converted.url,
    query: converted.query,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(auth === undefined ? {} : { auth }),
    assertions: tests.assertions.map(a => ({ ...a, ...(a.name === undefined ? {} : { name: line(vars(a.name)) }), expected: line(vars(a.expected)) })),
    captures: tests.captures.map(c => ({ variable: line(vars(c.variable)), scope: c.scope, source: line(vars(c.source)) })),
    notes,
    skippedScripts
  };
}

/** What was counted over the whole collection, reported once each. */
export function flushCollection(state: ConvertState): void {
  const { sink, label, counts, coerce } = state;
  const add = (code: Parameters<FindingSink['add']>[1], message: string): void => sink.add(label, code, label, message);
  const requests = (n: number): string => `${n} ${n === 1 ? 'request' : 'requests'}`;
  if (counts.defaultHeaders > 0) add('TC-HEADER-DEFAULT-DROPPED', `Thunder's default headers were dropped from ${requests(counts.defaultHeaders)}.`);
  if (counts.inheritedHeaders > 0) add('TC-INHERIT-HEADERS', `${requests(counts.inheritedHeaders)} received headers from a folder or the collection.`);
  if (counts.inheritedAuth > 0) add('TC-INHERIT-AUTH', `${requests(counts.inheritedAuth)} use authentication set on a folder or the collection.`);
  if (counts.inheritedBaseUrl > 0) add('TC-INHERIT-BASEURL', `${requests(counts.inheritedBaseUrl)} got a base URL from a folder or the collection.`);
  if (counts.inheritedTests > 0) add('TC-INHERIT-TESTS', `${requests(counts.inheritedTests)} received tests from a folder or the collection.`);
  if (counts.neutralized > 0) add('TC-EXPRESSION-NEUTRALIZED', `${counts.neutralized} ${counts.neutralized === 1 ? 'piece' : 'pieces'} of text between {{ }} looked like code or a path, not a variable name; the braces were separated so that no tool runs or reads it.`);
  if (counts.settingsDropped > 0) add('TC-SETTINGS-DROPPED', `${requests(counts.settingsDropped)} had cookies or settings (timeout, redirects...) with no equivalent; they were dropped.`);
  if (counts.unmapped.size > 0) add('TC-SYSVAR-UNMAPPED', `Dynamic variables with no equivalent were left as they are: ${[...counts.unmapped].sort().join(', ')}.`);
  if (counts.secretsMoved > 0) add('TC-SECRET-MOVED', `${counts.secretsMoved} literal ${counts.secretsMoved === 1 ? 'secret was' : 'secrets were'} moved to the private environment file.`);
  if (coerce.count > 0) add('TC-VALUE-COERCED', `${coerce.count} values of the wrong type were converted.`);
  if (state.budget.exhausted && !counts.budgetReported) {
    counts.budgetReported = true;
    sink.add(label, 'TC-TOO-LARGE', label, 'Inheritance made the output too large; requests after this point received no inherited settings.');
  }
}
