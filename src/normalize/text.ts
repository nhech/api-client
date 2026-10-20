/**
 * N1 and N10: a text field is a string in some files and an array of lines in others. Anything else is converted and flagged,
 * so the caller can report TC-VALUE-COERCED once per file.
 */
export interface TextResult {
  text: string;
  /** The value was not a string, an array of strings or missing. */
  coerced: boolean;
}

export function readText(value: unknown): TextResult {
  if (value === undefined) return { text: '', coerced: false };
  if (typeof value === 'string') return { text: value, coerced: false };
  if (Array.isArray(value)) {
    let coerced = false;
    const lines = value.map(line => {
      if (typeof line === 'string') return line;
      coerced = true;
      return typeof line === 'number' || typeof line === 'boolean' ? String(line) : '';
    });
    return { text: lines.join('\n'), coerced };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), coerced: true };
  return { text: '', coerced: true };
}
