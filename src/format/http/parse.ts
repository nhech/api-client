/**
 * A reader of the `.http` files that this program writes (the `.http` file next to a request, and the files of the importer). It knows what
 * REST Client, JetBrains and httpYac agree on, plus the three directives of the grammar, and nothing else:
 *
 *   - a line that starts with `###` begins the next request;
 *   - before the request line, a line that starts with `#` or `//` is a comment (and maybe a directive), a blank line is skipped;
 *   - the first other line is the request line, the lines after it up to a blank line are headers, the rest is the body.
 *
 * What it reads is data: nothing in it is run, no file it names is opened, and the size of the result is bounded by the size of the text.
 */
export interface ParsedRequest {
  title: string;
  name?: string;
  captures: string[];
  asserts: string[];
  /** Directive-looking comments that are not part of the grammar. */
  unknownDirectives: string[];
  comments: string[];
  method: string;
  url: string;
  headers: [string, string][];
  /** The body lines joined with `\n`, trailing blank lines removed. */
  body: string | undefined;
  /** The path of a body that is only `< path`. */
  bodyFile: string | undefined;
}

export interface ParsedFile {
  preamble: string[];
  requests: ParsedRequest[];
  /** Blocks with no request line. */
  empty: number;
}

const DIRECTIVE = /^(?:#|\/\/)\s*@(\w+)\b\s*(.*)$/;
const isComment = (line: string): boolean => line.startsWith('#') || line.startsWith('//');

export function parseHttp(text: string): ParsedFile {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const preamble: string[] = [];
  const blocks: { title: string; lines: string[] }[] = [];
  for (const line of lines) {
    if (line.startsWith('###')) blocks.push({ title: line.slice(3).trim(), lines: [] });
    else if (blocks.length === 0) preamble.push(line);
    else blocks[blocks.length - 1]?.lines.push(line);
  }
  while (preamble.length > 0 && preamble[preamble.length - 1]?.trim() === '') preamble.pop();

  const requests: ParsedRequest[] = [];
  let empty = 0;
  for (const block of blocks) {
    const request: ParsedRequest = { title: block.title, captures: [], asserts: [], unknownDirectives: [], comments: [], method: '', url: '', headers: [], body: undefined, bodyFile: undefined };
    let state: 'meta' | 'headers' | 'body' = 'meta';
    const body: string[] = [];
    for (const line of block.lines) {
      if (state === 'meta') {
        if (line.trim() === '') continue;
        if (isComment(line)) {
          const directive = DIRECTIVE.exec(line);
          if (directive === null) request.comments.push(line);
          else if (directive[1] === 'name') request.name = directive[2] ?? '';
          else if (directive[1] === 'capture') request.captures.push(directive[2] ?? '');
          else if (directive[1] === 'assert') request.asserts.push(directive[2] ?? '');
          else request.unknownDirectives.push(line);
          continue;
        }
        const space = line.indexOf(' ');
        request.method = space === -1 ? line : line.slice(0, space);
        request.url = space === -1 ? '' : line.slice(space + 1).trim();
        state = 'headers';
      } else if (state === 'headers') {
        if (line.trim() === '') state = 'body';
        else if (!isComment(line)) {
          const colon = line.indexOf(':');
          request.headers.push(colon === -1 ? [line, ''] : [line.slice(0, colon), line.slice(colon + 1).trim()]);
        }
      } else body.push(line);
    }
    if (state === 'meta') { empty++; continue; }
    while (body.length > 0 && body[body.length - 1]?.trim() === '') body.pop();
    if (body.length > 0) {
      request.body = body.join('\n');
      if (body.length === 1 && request.body.startsWith('< ')) request.bodyFile = request.body.slice(2).trim();
    }
    requests.push(request);
  }
  return { preamble, requests, empty };
}
