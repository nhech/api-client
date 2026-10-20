/**
 * N10: a value of the wrong type is converted, and counted so that one TC-VALUE-COERCED can say how many.
 * A missing value is empty and is not a coercion.
 */
export class Coercions {
  count = 0;

  /** A string from a field that should hold one. */
  string(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return '';
    this.count++;
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  }

  /** A true/false from a field that should hold one; anything else is false. */
  flag(value: unknown): boolean {
    if (value === true) return true;
    if (value === undefined || value === false) return false;
    this.count++;
    return false;
  }
}
