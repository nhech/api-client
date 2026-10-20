import { MULTIPART_BOUNDARY } from '../convert/body';
import { graphqlBodyText } from '../convert/graphql';
import { mapLiteral, oneLine } from '../convert/text';
import type { ImpBody } from '../model/ir';

/**
 * The text of a request body as it goes below the headers of a .http file (spec 5.4). Pure: the same body always gives the
 * same text, with `\n` line ends.
 */

const encode = (text: string): string => {
  try { return encodeURIComponent(text); } catch { return '?'; }
};

/** A name or value of a form: encoded as a form needs it, `{{variables}}` left alone. */
export const encodeForm = (text: string): string => mapLiteral(text, encode);

const quoted = (text: string): string => oneLine(text).text.replaceAll('"', '%22');
/** A path to an attached file as the .http file should say it: a relative path starts with `./` and uses `/`; an absolute one is kept. */
export const filePathRef = (path: string): string => {
  const clean = oneLine(path).text.trim();
  if (/^(?:[A-Za-z]:|[\\/]|~)/.test(clean)) return clean;
  const slashed = clean.replaceAll('\\', '/');
  return /^\.{1,2}\//.test(slashed) ? slashed : `./${slashed}`;
};
const baseName = (path: string): string => path.split(/[\\/]/).filter(part => part !== '').pop() ?? path;

/**
 * The body text, or undefined when there is nothing to send (no enabled field, no part). `saveValue` stores the value of a
 * multipart text part that cannot stand inside the file (see needsExternalBody) and returns the path to read it from.
 */
export function renderBody(body: ImpBody, saveValue?: (text: string) => string): string | undefined {
  switch (body.kind) {
    case 'text': {
      const text = body.text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      return text === '' ? undefined : text;
    }
    case 'form': {
      const fields = body.fields.filter(field => field.enabled);
      return fields.length === 0 ? undefined : fields.map(field => `${encodeForm(oneLine(field.name).text)}=${encodeForm(field.value.replace(/\r\n?/g, '\n'))}`).join('&');
    }
    case 'multipart': {
      const parts = body.parts.filter(part => part.enabled);
      if (parts.length === 0) return undefined;
      const lines: string[] = [];
      for (const part of parts) {
        lines.push(`--${MULTIPART_BOUNDARY}`);
        if (part.filePath !== undefined) {
          lines.push(`Content-Disposition: form-data; name="${quoted(part.name)}"; filename="${quoted(baseName(part.filePath))}"`, 'Content-Type: application/octet-stream', '', `< ${filePathRef(part.filePath)}`);
        } else {
          const value = (part.value ?? '').replace(/\r\n?/g, '\n');
          lines.push(`Content-Disposition: form-data; name="${quoted(part.name)}"`, '', saveValue !== undefined && needsExternalBody(value) ? `< ${saveValue(value)}` : value);
        }
      }
      lines.push(`--${MULTIPART_BOUNDARY}--`);
      return lines.join('\n');
    }
    case 'graphql':
      return graphqlBodyText(body.query, body.variables ?? '');
  }
}

/** Comment lines for the fields and parts that are switched off. */
export function disabledBodyLines(body: ImpBody): string[] {
  if (body.kind === 'form') return body.fields.filter(field => !field.enabled).map(field => `# [disabled form field] ${oneLine(field.name).text}=${oneLine(field.value).text}`);
  if (body.kind === 'multipart') {
    return body.parts.filter(part => !part.enabled).map(part => `# [disabled form field] ${oneLine(part.name).text}=${oneLine(part.filePath !== undefined ? `< ${part.filePath}` : (part.value ?? '')).text}`);
  }
  return [];
}

/**
 * True when a line of the body would be read by a .http tool as something else than body text:
 *  - `#` (`###` starts the next request) and `//` are comments, and REST Client (tried for real, 0.25.1) drops such a line from
 *    the body without a word;
 *  - `< path` includes a file and `<> path`, `> path`, `>> path`, `> {% ... %}` are response handlers: data must never be able
 *    to read a file of the person's disk into a request, or run a handler.
 * A line like `<root>` or `</a>` is XML and is fine; a lone `<` or `>` is taken as risky because it costs only a file.
 */
export const needsExternalBody = (text: string): boolean => /(?:^|\n)(?:#|\/\/|<(?:\s|>|$)|>(?:\s|>|\{|$))/.test(text);
