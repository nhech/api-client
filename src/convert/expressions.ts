import { variableSpans } from './text';

/**
 * Text between `{{` and `}}` is a variable in Thunder Client, and nothing more. In the tools that read the .http file it can be
 * much more: httpYac runs it as JavaScript (tried for real, 6.16.7: an expression in a body, a header or a URL ran and wrote a
 * file), and `{{$processEnv NAME}}` of REST Client and httpYac reads an environment variable into the request. So the data of a
 * collection that somebody else made could run code, or leak the environment, when the person presses Send.
 *
 * A span is left alone only if what is between the braces is a plain name: no dot (a chain such as `process.env.X` is read as a
 * path), no parenthesis, quote, operator or `$`. Anything else is made harmless by separating the braces: `{ {` and `} }` are
 * ordinary text in every tool. Thunder's own dynamic variables (`{{#guid}}`, `{{#number, 1, 9}}`) are kept for the conversion
 * that comes next (spec 5.7), which writes the two it can map as the safe forms of the target and leaves the rest as they are;
 * a `#` is not valid JavaScript at that place, so nothing runs.
 */
const NOT_A_NAME = /[.(){}[\];=+*/\\'"`<>!|&^%~?,:$#@]/;
// `#name` and then arguments after commas. Every repeat starts with a comma that the argument text cannot contain, so there is only one way to
// match and the test takes one pass (an earlier form let spaces belong to two places at once: 36 bytes of ", , , ... !" took a minute).
const THUNDER_DYNAMIC = /^\s*#[A-Za-z]+\s*(?:,[\s\w.-]*)*$/;

/** True when the text between the braces is a plain variable name (or a Thunder dynamic variable, which is handled apart). */
export const isPlainVariable = (inner: string): boolean => !NOT_A_NAME.test(inner) || THUNDER_DYNAMIC.test(inner);

export interface Neutralized {
  text: string;
  /** How many spans (and unclosed `{{`) were made harmless. */
  count: number;
}

const MAX_PASSES = 16;

/** `plain` says which spans are left alone: the plain variables of the conversion by default; the mirror of a request passes the words of the client. */
export function neutralizeExpressions(text: string, plain: (inner: string) => boolean = isPlainVariable): Neutralized {
  if (!text.includes('{{')) return { text, count: 0 };
  let current = text;
  let count = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const spans = variableSpans(current).filter(([start, end]) => !plain(current.slice(start + 2, end - 2)));
    if (spans.length === 0) break;
    let out = '';
    let at = 0;
    for (const [start, end] of spans) {
      out += `${current.slice(at, start)}{ {${current.slice(start + 2, end - 2)}} }`;
      at = end;
    }
    current = out + current.slice(at);
    count += spans.length;
    if (pass === MAX_PASSES - 1) return { text: current.replaceAll('{{', '{ {').replaceAll('}}', '} }'), count: count + 1 };
  }

  // A `{{` that is never closed is plain text to us, but httpYac starts a script at it that can run on into later lines.
  const spans = variableSpans(current);
  let out = '';
  let next = 0;
  for (let i = 0; i < current.length; i++) {
    while (next < spans.length && (spans[next]?.[1] ?? 0) <= i) next++;
    const span = spans[next];
    if (span !== undefined && i >= span[0] && i < span[1]) { out += current.slice(i, span[1]); i = span[1] - 1; continue; }
    if (current.charCodeAt(i) === 0x7b && current.charCodeAt(i + 1) === 0x7b) { out += "{ "; count++; continue; }
    out += current[i];
  }
  return { text: out, count };
}
