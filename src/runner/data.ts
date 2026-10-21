/**
 * The data file of a run: one row for each pass. A CSV file (the first row names the columns; commas, semicolons or tabs; quoted fields with
 * doubled quotes and line breaks) or a JSON file (a list of objects). Every value is text: it becomes a variable for the requests of that pass
 * and `pm.iterationData` for its scripts. The text is data: nothing in it is evaluated, and the sizes are bounded.
 */
export const DATA_LIMITS = { rows: 10_000, columns: 200, cellChars: 64 * 1024, nameChars: 100 } as const;

export type DataRow = Record<string, string>;
export type DataResult = { ok: true; rows: DataRow[]; columns: string[]; warnings: string[] } | { ok: false; error: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const DELIMITERS = [',', ';', '\t'] as const;

const clean = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The delimiter that the first line uses most, outside quotes. */
function delimiterOf(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map(delimiter => [delimiter, 0]));
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best = ',';
  let most = 0;
  for (const [delimiter, count] of counts) if (count > most) { best = delimiter; most = count; }
  return best;
}

/** The records of a CSV text: a list of lists of fields. One pass; a quote that never closes ends at the end of the text. */
function records(text: string, delimiter: string, limit: number): { rows: string[][]; cut: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  /** The next character starts a field: a quote there opens a quoted field. */
  let atStart = true;
  const endRow = (): void => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    atStart = true;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') { field += '"'; index++; } else quoted = false;
    } else if (char === '"' && atStart) { quoted = true; atStart = false; }
    else if (char === delimiter) { row.push(field); field = ''; atStart = true; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      endRow();
      if (rows.length > limit) return { rows, cut: true };
    } else { field += char; atStart = false; }
  }
  if (row.length > 0 || field !== '') endRow();
  return { rows, cut: rows.length > limit };
}

export function parseCsv(input: string): DataResult {
  const text = clean(input);
  const { rows: all, cut } = records(text, delimiterOf(text), DATA_LIMITS.rows + 1);
  const [head, ...body] = all;
  if (head === undefined) return { ok: false, error: 'The file has no rows.' };
  if (head.length > DATA_LIMITS.columns) return { ok: false, error: `The file has more than ${DATA_LIMITS.columns} columns.` };
  const columns = head.map(name => name.trim());
  const warnings: string[] = [];
  for (const name of columns) if (!NAME.test(name) || name.length > DATA_LIMITS.nameChars) return { ok: false, error: `"${name.slice(0, 40)}" in the first row is not a name a variable can have (letters, digits, _ . -, not starting with a digit).` };
  if (new Set(columns).size !== columns.length) return { ok: false, error: 'Two columns have the same name.' };
  if (body.length === 0) return { ok: false, error: 'The file has a row of names and no data.' };
  if (cut || body.length > DATA_LIMITS.rows) { warnings.push(`Only the first ${DATA_LIMITS.rows} rows are used.`); }
  const rows: DataRow[] = [];
  for (const line of body.slice(0, DATA_LIMITS.rows)) {
    const row: DataRow = Object.create(null) as DataRow;
    columns.forEach((name, index) => { row[name] = (line[index] ?? '').slice(0, DATA_LIMITS.cellChars); });
    rows.push(row);
  }
  return { ok: true, rows, columns, warnings };
}

export function parseJsonData(text: string): DataResult {
  let raw: unknown;
  try { raw = JSON.parse(clean(text)); } catch { return { ok: false, error: 'The file is not JSON.' }; }
  if (!Array.isArray(raw)) return { ok: false, error: 'The file has to be a list of objects: [ { "name": "value" }, ... ].' };
  if (raw.length === 0) return { ok: false, error: 'The list is empty.' };
  const warnings: string[] = [];
  if (raw.length > DATA_LIMITS.rows) warnings.push(`Only the first ${DATA_LIMITS.rows} rows are used.`);
  const columns: string[] = [];
  const rows: DataRow[] = [];
  const skipped = new Set<string>();
  for (const item of raw.slice(0, DATA_LIMITS.rows)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false, error: 'Every item of the list has to be an object.' };
    const row: DataRow = Object.create(null) as DataRow;
    for (const [name, value] of Object.entries(item as Record<string, unknown>)) {
      if (!NAME.test(name) || name.length > DATA_LIMITS.nameChars) { skipped.add(name.slice(0, 40)); continue; }
      if (!columns.includes(name)) { if (columns.length >= DATA_LIMITS.columns) return { ok: false, error: `The file has more than ${DATA_LIMITS.columns} columns.` }; columns.push(name); }
      const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      row[name] = text.slice(0, DATA_LIMITS.cellChars);
    }
    rows.push(row);
  }
  if (skipped.size > 0) warnings.push(`These names are not names a variable can have, so they are not used: ${[...skipped].slice(0, 5).join(', ')}.`);
  return columns.length === 0 ? { ok: false, error: 'No object has a name that a variable can have.' } : { ok: true, rows, columns, warnings };
}

/** A data file by its name (and, when the name does not say, by its first character). */
export function parseDataFile(text: string, fileName: string): DataResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return parseJsonData(text);
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) return parseCsv(text);
  const first = clean(text).trimStart()[0];
  return first === '[' || first === '{' ? parseJsonData(text) : parseCsv(text);
}
