import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No invisible or direction-changing character may sit in the code ("Trojan source"): one was once written into a regular
 * expression by a tool that turns \u escapes into characters. Such characters are built from numbers instead
 * (String.fromCodePoint). Documentation may use any text.
 */
const project = join(__dirname, '..', '..', '..');
const roots = ['src', 'test', 'tools', 'extension/src', 'extension/test'];
const files = roots.flatMap(dir => readdirSync(join(project, dir), { recursive: true, encoding: 'utf8' })
  .filter(file => /\.(?:ts|cjs|mjs)$/.test(file))
  .map(file => join(dir, file)));
files.push('eslint.config.mjs', 'package.json', 'tsconfig.json', 'tsconfig.test.json', 'extension/package.json', 'extension/tsconfig.json', 'extension/esbuild.mjs');

const isHidden = (code: number) => (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  || code === 0xfeff || (code >= 0x7f && code <= 0x9f) || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d);

test('The code holds no hidden, direction-changing or control characters', () => {
  assert.ok(files.length >= 15, `only ${files.length} files scanned`);
  const found: string[] = [];
  for (const file of files) {
    let line = 1;
    for (const char of readFileSync(join(project, file), 'utf8')) {
      const code = char.codePointAt(0) ?? 0;
      if (char === '\n') line++;
      else if (isHidden(code)) found.push(`${file.replaceAll('\\', '/')}:${line} U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  assert.deepEqual(found, []);
});

test('The code is plain ASCII except where a name needs more', () => {
  const nonAscii: string[] = [];
  for (const file of files) {
    for (const char of readFileSync(join(project, file), 'utf8')) if ((char.codePointAt(0) ?? 0) > 0x7e) { nonAscii.push(file.replaceAll('\\', '/')); break; }
  }
  assert.deepEqual(nonAscii, [], 'build such characters with String.fromCodePoint, or write them in documentation instead');
});
