import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { importSource } from '../../src/import';
import { relativePathProblem } from '../../src/write/paths';
import type { ImportResult } from '../../src';
import { CANARIES, CANARY, CASES } from '../fixtures/cases';
import { parseHttp } from '../support/http-parser';

/**
 * Whole-pipeline fixtures (spec 10.1). Each case is converted and every output file is compared byte for byte with the file in
 * test/fixtures/golden/<case>/. The goldens are read by a person before they are accepted. To rewrite them after a change you
 * mean: UPDATE_GOLDEN=1 npm test, then read the diff.
 */
const goldenRoot = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'golden');
const update = process.env['UPDATE_GOLDEN'] === '1';

const FINDINGS_FILE = 'findings.txt';
const findingsText = (result: ImportResult): string => `${result.findings.map(f => `${f.severity} ${f.code} @ ${f.where}: ${f.message}`).join('\n')}\n`;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full); else out.push(relative(dir, full).replaceAll('\\', '/'));
    }
  };
  try { walk(dir); } catch { /* no golden folder yet */ }
  return out;
}

for (const fixture of CASES) {
  test(fixture.title, () => {
    const result = importSource(fixture.build(), fixture.options);
    const actual = new Map<string, string>(result.files.map(f => [f.path, f.content]));
    actual.set(FINDINGS_FILE, findingsText(result));

    // P3: no path leaves the target folder, and every file path is a name the writer accepts.
    for (const f of result.files) assert.equal(relativePathProblem(f.path), undefined, `${fixture.id}: ${f.path}`);
    // The files are what the reference reader understands.
    for (const f of result.files.filter(item => item.path.endsWith('.http'))) assert.equal(parseHttp(f.content).empty, 0, `${fixture.id}: ${f.path}`);

    const dir = join(goldenRoot, fixture.id);
    if (update) {
      rmSync(dir, { recursive: true, force: true });
      for (const [path, content] of actual) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
      return;
    }
    const expected = listFiles(dir);
    assert.deepEqual([...actual.keys()].sort(), expected.sort(), `${fixture.id}: the list of files (UPDATE_GOLDEN=1 to rewrite)`);
    for (const path of expected) assert.equal(actual.get(path), readFileSync(join(dir, path), 'utf8'), `${fixture.id}: ${path}`);
  });
}

test('P4: no canary is in a shared file or the report; they are all in the private file (F10)', () => {
  const fixture = CASES.find(item => item.id === 'f10-secrets');
  assert.ok(fixture);
  const result = importSource(fixture.build());
  const priv = result.files.find(f => f.path === 'http-client.private.env.json')?.content ?? '';
  for (const f of result.files) {
    if (f.path.includes('.private.')) continue;
    for (const canary of CANARIES) assert.ok(!f.content.includes(canary), `${canary} in ${f.path}`);
  }
  for (const finding of result.findings) for (const canary of CANARIES) assert.ok(!`${finding.where} ${finding.message}`.includes(canary));
  for (const canary of [CANARY.bearer, CANARY.basicPassword, CANARY.authorizationHeader, CANARY.apiKeyHeader, CANARY.disabledHeader, CANARY.queryKey, CANARY.formPassword, CANARY.envVariable]) {
    assert.ok(priv.includes(canary), `${canary} should be in the private file`);
  }
});

test('P4: with moving switched off the canaries stay where they were, and every one is reported (F10)', () => {
  const fixture = CASES.find(item => item.id === 'f10-secrets');
  assert.ok(fixture);
  const result = importSource(fixture.build(), { moveSecrets: false });
  assert.ok(result.findings.some(f => f.code === 'TC-SECRET-LITERAL'));
  assert.equal(result.files.find(f => f.path === 'http-client.private.env.json')?.content.includes(CANARY.bearer) ?? false, false);
  for (const finding of result.findings) for (const canary of CANARIES) assert.ok(!`${finding.where} ${finding.message}`.includes(canary), 'a finding never carries a value');
});

test('F9: every unsupported request is reported once and is not in a file', () => {
  const fixture = CASES.find(item => item.id === 'f09-unsupported');
  assert.ok(fixture);
  const result = importSource(fixture.build());
  const codes = result.findings.map(f => f.code);
  assert.equal(codes.filter(code => code === 'TC-REQTYPE-UNSUPPORTED').length, 3);
  assert.deepEqual(result.model.skipped.map(item => item.request), ['events', 'rpc', 'socket']);
  const http = result.files.filter(f => f.path.endsWith('.http')).map(f => f.content).join('\n');
  for (const name of ['socket', 'events', 'rpc']) assert.ok(!new RegExp(`^### ${name}$`, 'm').test(http), name);
  assert.equal(parseHttp(http).requests.length, 7);
  assert.ok(codes.includes('TC-AUTH-UNSUPPORTED') && codes.includes('TC-AUTH-OAUTH2') && codes.includes('TC-BODY-UNSUPPORTED') && codes.includes('TC-SCRIPT-SKIPPED') && codes.includes('TC-TEST-UNSUPPORTED'));
  assert.ok(!http.includes('not shown'), 'a value of an unsupported authentication is never copied');
});
