import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FINDING_CATALOG, FINDING_CODES, finding } from '../../src';

const specPath = join(__dirname, '..', '..', '..', 'docs', 'SPEC.vi.md');
const CODE = /TC-[A-Z0-9]+(?:-[A-Z0-9]+)*/g;

test('The finding catalog and the codes of the spec are the same set, so neither can drift', () => {
  const inSpec = new Set(readFileSync(specPath, 'utf8').match(CODE) ?? []);
  const inCatalog = new Set<string>(FINDING_CODES);
  assert.deepEqual([...inSpec].filter(code => !inCatalog.has(code)).sort(), [], 'codes in the spec that the catalog lacks');
  assert.deepEqual([...inCatalog].filter(code => !inSpec.has(code)).sort(), [], 'codes in the catalog that the spec never mentions');
});

test('Each catalog entry has a severity and a summary a person can read', () => {
  for (const [code, entry] of Object.entries(FINDING_CATALOG)) {
    assert.match(code, /^TC-[A-Z0-9-]+$/);
    assert.ok(['info', 'warn', 'error'].includes(entry.severity), code);
    assert.ok(entry.summary.length >= 10 && entry.summary.endsWith('.'), `${code}: ${entry.summary}`);
  }
});

test('finding() takes the catalog severity and summary unless the caller says otherwise', () => {
  assert.deepEqual(finding('TC-LAYOUT-BOTH', 'collections/'), { code: 'TC-LAYOUT-BOTH', severity: 'warn', where: 'collections/', message: FINDING_CATALOG['TC-LAYOUT-BOTH'].summary });
  assert.equal(finding('TC-PARSE-ERROR', 'a.json', 'Not JSON.', 'info').severity, 'info');
  assert.equal(finding('TC-PARSE-ERROR', 'a.json', 'Not JSON.').message, 'Not JSON.');
});
