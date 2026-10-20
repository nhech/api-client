/**
 * Checks of the size of a JSON value (spec 8.1). The depth is checked on the text, before parsing, and the strings on the
 * parsed value; both walk iteratively, so a hostile file costs neither deep recursion nor a large allocation.
 */

/** True when arrays and objects nest deeper than `max`. Counts brackets outside strings, in one pass over the text. */
export function exceedsDepth(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true; // backslash
      else if (code === 0x22) inString = false; // closing quote
      continue;
    }
    if (code === 0x22) inString = true;
    else if (code === 0x7b || code === 0x5b) { if (++depth > max) return true; } // { [
    else if (code === 0x7d || code === 0x5d) depth = Math.max(0, depth - 1); // } ]
  }
  return false;
}

/** True when a string value or an object key is longer than `maxBytes` as UTF-8. */
export function hasOversizedString(value: unknown, maxBytes: number): boolean {
  const stack: unknown[] = [value];
  const tooLong = (text: string): boolean => text.length > maxBytes / 3 && Buffer.byteLength(text, 'utf8') > maxBytes;
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (tooLong(current)) return true;
    } else if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (typeof current === 'object' && current !== null) {
      for (const key of Object.keys(current)) {
        if (tooLong(key)) return true;
        stack.push((current as Record<string, unknown>)[key]);
      }
    }
  }
  return false;
}
