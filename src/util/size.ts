/** The number of bytes `text` takes in UTF-8, without making a copy of it. A lone surrogate counts as 3 (it is written as U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
