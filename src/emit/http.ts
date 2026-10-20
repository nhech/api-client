import { cleanLine, mapLiteral, oneLine, variableSpans } from '../convert/text';
import type { ImpAssertion, ImpCapture, ImpRequest } from '../model/ir';
import { disabledBodyLines, needsExternalBody, renderBody } from './body';

/**
 * One request as a block of a .http file (spec 6.2). The order of the lines is fixed:
 *
 *   ### title
 *   # @name unique-name
 *   # docs ...
 *   # @capture ...        # @assert ...
 *   # [disabled] ...      # notes, script blocks
 *   METHOD URL
 *   Header: value
 *
 *   body
 *
 * Nothing from the data can add a line, a directive or a request to the file: values that go on one line have no line break,
 * documentation and scripts are comments whose text can never start a directive, and a body that has a line starting with
 * `###` goes to a separate file that the request reads with `< path`.
 */
export interface RenderedRequest {
  text: string;
  /** The body was saved to a separate file (TC-BODY-EXTERNAL). */
  externalBody: boolean;
}

const TITLE_MAX = 200;

const title = (request: ImpRequest): string => {
  const text = cleanLine(request.name).text;
  const chosen = text === '' ? '(unnamed)' : text;
  const points = Array.from(chosen);
  return points.length <= TITLE_MAX ? chosen : `${points.slice(0, TITLE_MAX - 3).join('')}...`;
};

export const lines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** A comment line with free text. A text that starts with "@" would be read as a directive, so it gets a bullet first. */
export const comment = (text: string): string => {
  const clean = oneLine(text).text;
  const body = clean.trimStart().startsWith('@') ? `- ${clean}` : clean;
  return body === '' ? '#' : `# ${body}`;
};

/**
 * A header name written as a line of its own. Only the characters an HTTP header name may have (RFC 9110 "token") stay, so that
 * no name can look like a comment (`#`, `//`), a file variable (`@x=1`) or a second header; `{{variables}}` are kept.
 */
const NOT_TOKEN = /[^!#$%&'*+.^_`|~0-9A-Za-z-]+/g;
export const headerName = (name: string): string => {
  const safe = mapLiteral(oneLine(name).text, literal => literal.replace(NOT_TOKEN, '-'));
  return safe.startsWith('#') ? `_${safe.slice(1)}` : safe;
};

function assertLine(assertion: ImpAssertion): string {
  const subject = assertion.target === 'status' ? 'status'
    : assertion.target === 'time' ? 'duration'
    : assertion.target === 'body' ? 'body'
    : assertion.target === 'header' ? `header ${oneLine(assertion.name ?? '').text}`
    : `json ${oneLine(assertion.name ?? '$').text}`;
  const expected = oneLine(assertion.expected).text.trim();
  return `# @assert ${subject} ${assertion.op}${expected === '' ? '' : ` ${expected}`}`;
}

function captureLine(capture: ImpCapture): string {
  return `# @capture ${capture.scope === 'active' ? '' : `${capture.scope}:`}${oneLine(capture.variable).text} = ${oneLine(capture.source).text}`;
}

/** `atName` is the unique name of the request in its file; `saveBody` stores a body in a separate file and returns the path to read it from. */
export function renderRequest(request: ImpRequest, atName: string, saveBody: (text: string) => string): RenderedRequest {
  const out: string[] = [`### ${title(request)}`, `# @name ${atName}`];

  if (request.docs !== undefined) for (const line of lines(request.docs)) out.push(comment(line));
  for (const capture of request.captures) out.push(captureLine(capture));
  for (const assertion of request.assertions) out.push(assertLine(assertion));
  for (const header of request.headers) if (!header.enabled) out.push(`# [disabled] ${headerName(header.name)}: ${oneLine(header.value).text}`);
  for (const entry of request.query) if (!entry.enabled) out.push(`# [disabled query] ${oneLine(entry.name).text}=${oneLine(entry.value).text}`);
  if (request.body !== undefined) out.push(...disabledBodyLines(request.body));
  for (const note of request.notes) out.push(comment(note));
  // A body line that a tool would read as a separator, a comment, a file include or a handler (see needsExternalBody) cannot
  // stand in the file: such a body, or for a multipart body such a part, goes to a file that the request reads as it is.
  let external = false;
  let variablesInFile = false;
  const save = (text: string): string => {
    external = true;
    variablesInFile ||= variableSpans(text).length > 0;
    return saveBody(text);
  };
  const wholeFile = request.body !== undefined && request.body.kind !== 'multipart';
  const body = request.body === undefined ? undefined : renderBody(request.body, save);
  const bodyText = body !== undefined && wholeFile && needsExternalBody(body) ? save(body) : undefined;
  if (variablesInFile) out.push('# [part of the body is in a file; some tools do not replace {{variables}} inside a file]');
  for (const script of request.skippedScripts) {
    out.push(`# [script not imported: ${script.phase}${script.from === undefined ? '' : `, from ${oneLine(script.from).text}`}]`);
    for (const line of script.lines.flatMap(lines)) out.push(`# | ${oneLine(line).text}`);
  }

  out.push(`${oneLine(request.method).text} ${oneLine(request.url).text}`.trimEnd());
  for (const header of request.headers) if (header.enabled) out.push(`${headerName(header.name)}: ${oneLine(header.value).text}`);
  if (request.auth?.kind === 'bearer') out.push(`Authorization: Bearer ${oneLine(request.auth.token.value).text}`);
  else if (request.auth?.kind === 'basic') {
    // "Basic user password" is what REST Client, JetBrains and httpYac all encode. "Basic user:password" is encoded by REST Client
    // only (JetBrains sends it as it is, or garbles it when a variable follows the colon; tried for real), so the colon form is
    // kept just for a user name with a space, which the other form cannot say.
    const user = oneLine(request.auth.username.value).text;
    out.push(`Authorization: Basic ${user}${/\s/.test(user) ? ':' : ' '}${oneLine(request.auth.password.value).text}`);
  }

  if (body !== undefined) {
    out.push('');
    if (bodyText !== undefined) out.push(`< ${bodyText}`);
    else out.push(...body.split('\n'));
  }
  return { text: out.join('\n'), externalBody: external };
}
