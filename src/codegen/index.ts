/**
 * Code that sends a request: the request as it would go out, written for cURL, JavaScript (fetch, axios), Python, Go, C#, PHP, Java and
 * PowerShell. Pure text: nothing is run, and everything that comes from the request (an address, a header, a body) goes into the code as
 * a string of the language, escaped for it, never as code, so that pasting the result into a terminal or a file runs what it says and nothing
 * the data could add.
 */
export type CodeBody =
  | { kind: 'text'; text: string }
  /** application/x-www-form-urlencoded: the pairs, not yet encoded. */
  | { kind: 'form'; fields: [string, string][] }
  | { kind: 'multipart'; parts: CodePart[] }
  /** A file that is sent as it is. */
  | { kind: 'file'; path: string }
  /** Bytes that are not text. */
  | { kind: 'binary'; size: number };

export interface CodePart {
  name: string;
  /** A text field. */
  value?: string;
  /** A file field: its path as the person wrote it. */
  file?: string;
  filename?: string;
  contentType?: string;
}

export interface CodeRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: CodeBody;
}

export type EditorLanguage = 'shell' | 'javascript' | 'python' | 'go' | 'csharp' | 'php' | 'java' | 'powershell';

export interface CodeTarget {
  id: string;
  label: string;
  /** For the highlighting of the viewer. */
  language: EditorLanguage;
  generate(request: CodeRequest): string;
}

// ---- strings of each language ----

/** The line and paragraph separators: valid in JSON, not in a string of JavaScript. */
const SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2029)}]`, 'g');
/** The quotes that PowerShell reads as a single quote: the plain one and the typographic ones. */
const SINGLE_QUOTES = new RegExp(`['${String.fromCodePoint(0x2018)}${String.fromCodePoint(0x2019)}${String.fromCodePoint(0x201a)}${String.fromCodePoint(0x201b)}]`, 'g');

/** A string of JavaScript, JSON, Python, Go, Java and C#: the JSON form is a valid string in each of them, with every control character and every separator escaped. */
export function jsonString(text: string): string {
  return JSON.stringify(text).replace(SEPARATORS, char => `\\u${char.charCodeAt(0).toString(16)}`);
}

/** A string for a POSIX shell: in single quotes, where nothing means anything; a single quote ends them, is written as `\'`, and they begin again. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** A string for PHP in single quotes: only the quote and the backslash mean something. */
export function phpQuote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A string for PowerShell in single quotes: only the quote means something, and it is doubled (and the typographic quotes, which PowerShell reads as quotes too). */
export function powershellQuote(text: string): string {
  return `'${text.replace(SINGLE_QUOTES, match => match + match)}'`;
}

/** The text with its line ends as `\n`, for the places where a body is written on lines. */
export const lf = (text: string): string => text.replace(/\r\n?/g, '\n');

/** The headers that the code of a language adds by itself for a body that it describes (the content type of a form or of a multipart body). */
export function headerValue(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

export const withoutHeader = (headers: readonly (readonly [string, string])[], names: readonly string[]): [string, string][] =>
  headers.filter(([key]) => !names.includes(key.toLowerCase())).map(([name, value]) => [name, value]);
