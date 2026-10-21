import type { YMap, YValue } from '../yaml';

/** Something wrong or odd in a file. An error means the file cannot be used as it is; a warning means something was ignored. */
export interface Finding {
  /** Where, as `headers[2].name`; empty for the whole file. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/** Collects the findings of one file while it is read. */
export class Reader {
  readonly findings: Finding[] = [];

  error(path: string, message: string): void {
    this.findings.push({ path, message, severity: 'error' });
  }

  warn(path: string, message: string): void {
    this.findings.push({ path, message, severity: 'warning' });
  }

  get failed(): boolean {
    return this.findings.some(finding => finding.severity === 'error');
  }

  /** The mapping at `path`, or undefined (with an error) when the value is something else. */
  mapping(value: YValue, path: string): Fields | undefined {
    if (value instanceof Map) return new Fields(this, value, path);
    this.error(path, 'expected a mapping of keys to values');
    return undefined;
  }
}

/** The keys of one mapping, read one by one; the ones nobody asked for are reported by `rest()` or `finish()`. */
export class Fields {
  private readonly asked = new Set<string>();

  constructor(readonly reader: Reader, readonly map: YMap, readonly path: string) {}

  private at(key: string): string {
    return join(this.path, key);
  }

  raw(key: string): YValue | undefined {
    this.asked.add(key);
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Text; a mapping or a list where text should be is an error. */
  str(key: string, fallback = ''): string {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    if (typeof value === 'string') return value;
    this.reader.error(this.at(key), 'expected text');
    return fallback;
  }

  bool(key: string, fallback: boolean): boolean {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    this.reader.error(this.at(key), 'expected true or false');
    return fallback;
  }

  optionalBool(key: string): boolean | undefined {
    const value = this.raw(key);
    if (value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    this.reader.error(this.at(key), 'expected true or false');
    return undefined;
  }

  /** A whole number in [min, max]. */
  int(key: string, fallback: number, min: number, max: number): number {
    return this.optionalInt(key, min, max) ?? fallback;
  }

  optionalInt(key: string, min: number, max: number): number | undefined {
    const value = this.raw(key);
    if (value === undefined) return undefined;
    if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) {
      const number = Number(value);
      if (number >= min && number <= max) return number;
      this.reader.error(this.at(key), `expected a number from ${min} to ${max}`);
      return undefined;
    }
    this.reader.error(this.at(key), 'expected a whole number');
    return undefined;
  }

  oneOf<T extends string>(key: string, values: readonly T[], fallback: T): T {
    return this.optionalOneOf(key, values) ?? fallback;
  }

  optionalOneOf<T extends string>(key: string, values: readonly T[]): T | undefined {
    const value = this.raw(key);
    if (value === undefined) return undefined;
    if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
    this.reader.error(this.at(key), `expected one of ${values.join(', ')}`);
    return undefined;
  }

  /** A list of mappings, each read by `item`; a list of anything else, or a mapping, is an error. */
  list<T>(key: string, item: (fields: Fields, index: number) => T): T[] {
    const value = this.raw(key);
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.reader.error(this.at(key), 'expected a list');
      return [];
    }
    const out: T[] = [];
    value.forEach((entry, index) => {
      const fields = this.reader.mapping(entry, `${this.at(key)}[${index}]`);
      if (fields !== undefined) {
        out.push(item(fields, index));
        fields.finish();
      }
    });
    return out;
  }

  /** A list of text values. */
  strings(key: string): string[] {
    const value = this.raw(key);
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.reader.error(this.at(key), 'expected a list');
      return [];
    }
    const out: string[] = [];
    value.forEach((entry, index) => {
      if (typeof entry === 'string') out.push(entry);
      else this.reader.error(`${this.at(key)}[${index}]`, 'expected text');
    });
    return out;
  }

  /** A nested mapping, or undefined when the key is absent (an error when it is something else). */
  child(key: string): Fields | undefined {
    const value = this.raw(key);
    return value === undefined ? undefined : this.reader.mapping(value, this.at(key));
  }

  /** The keys nobody asked for, in file order. */
  rest(): YMap {
    const unknown: YMap = new Map();
    for (const [key, value] of this.map) if (!this.asked.has(key)) unknown.set(key, value);
    return unknown;
  }

  /** In a nested mapping an unknown key is a warning: it would be lost the next time the file is written. */
  finish(): void {
    for (const key of this.rest().keys()) this.reader.warn(this.at(key), 'unknown key; it is ignored and will not be written back');
  }
}

/** Builds a mapping in the order of the file format, leaving out what has its default value so that files stay short. */
export class Out {
  readonly map: YMap = new Map();

  put(key: string, value: YValue): this {
    this.map.set(key, value);
    return this;
  }

  /** Text, unless it is the default. */
  text(key: string, value: string, fallback = ''): this {
    if (value !== fallback) this.map.set(key, value);
    return this;
  }

  bool(key: string, value: boolean, fallback: boolean): this {
    // Only a real boolean is written: a value of another type from an edit is refused here and not read as true.
    if (typeof value !== 'boolean') throw new TypeError(`${key} must be true or false`);
    if (value !== fallback) this.map.set(key, value ? 'true' : 'false');
    return this;
  }

  int(key: string, value: number | undefined): this {
    if (value !== undefined) this.map.set(key, String(value));
    return this;
  }

  /** A list, unless it is empty. */
  list(key: string, items: YValue[]): this {
    if (items.length > 0) this.map.set(key, items);
    return this;
  }

  /** A nested mapping, unless it is empty. */
  nested(key: string, value: YMap): this {
    if (value.size > 0) this.map.set(key, value);
    return this;
  }

  /** Keys the schema does not know, after the known ones, as they were. */
  extras(extra: YMap | undefined): this {
    if (extra !== undefined) for (const [key, value] of extra) if (!this.map.has(key)) this.map.set(key, value);
    return this;
  }
}
