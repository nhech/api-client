import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, slugify, sortBySourceOrder, uniqueSlugs } from '../../src';
import { importSource } from '../../src/import';
import { identifier, uniqueIdentifiers, uniqueNames } from '../../src/emit/names';
import { InheritBudget, inheritTests } from '../../src/convert/inherit';
import type { Level } from '../../src/convert/inherit';
import { isPlainVariable, neutralizeExpressions } from '../../src/convert/expressions';
import { renderEnvironments } from '../../src/emit/env';
import { FindingSink } from '../../src/normalize/sink';
import { displayLabel } from '../../src/util/chars';
import type { ImpEnvironment } from '../../src/model/ir';
import { file, req, source, v4 } from '../support/source';
import { random } from '../support/source';

/**
 * Time limits for the inputs that made the importer slow in a measured audit: a name or a string that a stranger can choose, within the
 * limits of the reader, must cost a pass over it and not more. Each limit is many times what the code takes, so a slow machine does not
 * fail it, and many times less than what the earlier code took (minutes to hours).
 */
const within = (label: string, limitMs: number, run: () => void): void => {
  const started = Date.now();
  run();
  const took = Date.now() - started;
  assert.ok(took < limitMs, `${label}: ${took} ms (limit ${limitMs} ms)`);
};

test('A dynamic variable that cannot match is rejected in one pass: 36 bytes used to take a minute', () => {
  within('18 repeats', 200, () => assert.equal(isPlainVariable(`#a${', '.repeat(18)}!`), false));
  within('40 repeats', 200, () => assert.equal(isPlainVariable(`#a${', '.repeat(40)}!`), false));
  within('100,000 repeats', 500, () => assert.equal(isPlainVariable(`#a${', '.repeat(100_000)}!`), false));
  within('spaces after a comma', 500, () => assert.equal(isPlainVariable(`#a,${' '.repeat(100_000)}!`), false));
  within('in a text', 500, () => assert.equal(neutralizeExpressions(`{{#a${', '.repeat(100_000)}!}}`).count, 1));
});

test('The dynamic variables of Thunder Client are still recognised, and code is still not', () => {
  for (const inner of ['#guid', ' #number, 1, 9 ', '#number,1,9', '#date', '#enum, a, b', '#number, -5, 1.5', '#a,']) assert.equal(isPlainVariable(inner), true, inner);
  for (const inner of ['#a, 1;2', '#a(', '#a!', '#a, $x', '#a b', '#', '#1', 'a.b', "#a, 'x'", '#a, {x}']) assert.equal(isPlainVariable(inner), false, inner);
});

const referenceIdentifiers = (names: readonly string[]): string[] => {
  const used = new Set<string>();
  return names.map(original => {
    const base = identifier(original);
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base}_${n}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
};

const referenceNames = (names: readonly string[]): { name: string; collided: boolean }[] => {
  const used = new Set<string>();
  return names.map(original => {
    let name = original === '' ? 'Environment' : original;
    let collided = false;
    for (let n = 2; used.has(name); n++) { collided = true; name = `${original === '' ? 'Environment' : original}-${n}`; }
    used.add(name);
    return { name, collided };
  });
};

const referenceSlugs = (names: readonly string[], max: number = LIMITS.maxSlugChars): string[] => {
  const used = new Set<string>();
  const cut = (text: string, length: number): string => Array.from(text).slice(0, Math.max(0, length)).join('');
  return names.map(name => {
    const { slug } = slugify(name, max);
    let candidate = slug;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      const suffix = `-${n}`;
      candidate = cut(slug, max - suffix.length).replace(/^[.\s]+|[.\s]+$/g, '') + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
};

test('Unique names are the same as when every repeat counted up from 2, including names that already look like a suffix', () => {
  const pool = ['A', 'a', 'A-2', 'a-2', 'A_2', 'a_2', 'B', 'New Request', 'New Request-2', 'x.y', ' ', '', 'Env', 'A-3', 'A-', 'a_3', String.fromCodePoint(0xdc, 0x6e, 0xef), 'x'.repeat(120)];
  for (let seed = 1; seed <= 60; seed++) {
    const next = random(seed);
    const names = Array.from({ length: 5 + Math.floor(next() * 60) }, () => pool[Math.floor(next() * pool.length)] ?? 'A');
    assert.deepEqual(uniqueIdentifiers(names), referenceIdentifiers(names), `identifiers, seed ${seed}`);
    assert.deepEqual(uniqueNames(names), referenceNames(names), `names, seed ${seed}`);
    assert.deepEqual(uniqueSlugs(names).map(entry => entry.slug), referenceSlugs(names), `slugs, seed ${seed}`);
  }
});

test('50,000 requests with the same name take a moment: they used to take four minutes', () => {
  const same = Array.from({ length: 50_000 }, () => 'New Request');
  within('identifiers', 2000, () => {
    const result = uniqueIdentifiers(same);
    assert.deepEqual([result[0], result[1], result[2], result[49_999]], ['New_Request', 'New_Request_2', 'New_Request_3', 'New_Request_50000']);
    assert.equal(new Set(result.map(item => item.toLowerCase())).size, 50_000);
  });
  within('slugs', 2000, () => {
    const result = uniqueSlugs(same);
    assert.deepEqual([result[0]?.slug, result[1]?.slug, result[49_999]?.slug], ['New Request', 'New Request-2', 'New Request-50000']);
  });
  within('keys', 2000, () => assert.equal(uniqueNames(same)[49_999]?.name, 'New Request-50000'));
});

test('A name that is one long run of spaces, dots or underscores is cleaned in one pass', () => {
  within('spaces', 500, () => assert.equal(slugify(`a${' '.repeat(300_000)}b`).slug.length <= 100, true));
  within('dots', 500, () => assert.equal(slugify(`.${'.'.repeat(300_000)}x`).slug, 'x'));
  within('edges', 500, () => assert.equal(slugify(`${' '.repeat(300_000)}x${' '.repeat(300_000)}`).slug, 'x'));
  within('underscores', 500, () => assert.equal(identifier(`a${'_'.repeat(300_000)}!`), 'a'));
  within('a name of megabytes', 500, () => assert.equal(displayLabel('n'.repeat(5 * 1024 * 1024)).length, 80));
});

test('Tests inherited from a level are added in one pass, and a test the request already has is still not added again', () => {
  const tests = Array.from({ length: 30_000 }, (_, index) => ({ type: 'json-query', custom: `json.field${index}`, action: 'equal', value: '1' }));
  const levels: Level[] = [{ kind: 'collection', name: 'C', settings: { tests } }];
  within('30,000 tests', 1000, () => assert.equal(inheritTests([], levels, new InheritBudget()).length, 30_000));
  const own = [{ type: 'json-query', custom: 'json.field5', action: 'equal', value: 'other' }, null as never];
  const added = inheritTests(own, levels, new InheritBudget());
  assert.equal(added.length, 29_999, 'the one the request had is not added again, a null entry does not matter');
  assert.ok(!added.some(item => item.test.custom === 'json.field5'));
  const repeated: Level[] = [{ kind: 'folder', name: 'F', settings: { tests: [tests[0] as never, tests[0] as never] } }, { kind: 'collection', name: 'C', settings: { tests: [tests[0] as never] } }];
  assert.equal(inheritTests([], repeated, new InheritBudget()).length, 1, 'the same test on two levels counts once');
  const notDeduped = { type: 'res-body', custom: '', action: 'contains', value: 'x' };
  assert.equal(inheritTests([], [{ kind: 'collection', name: 'C', settings: { tests: [notDeduped, notDeduped] } }], new InheritBudget()).length, 2, 'only some actions are compared');
});

test('Items that tie in every field are put in order without writing each one out at every comparison', () => {
  const big = 'x'.repeat(2000);
  const items = Array.from({ length: 20_000 }, (_, index) => ({ name: 'same', sortNum: 1, created: 'c', _id: 'i', payload: `${big}${index % 997}` }));
  within('20,000 tied items', 3000, () => assert.equal(sortBySourceOrder(items).length, 20_000));
});

test('Environments that would go over the output limit are not built: 800 environments sharing 10,000 variables', () => {
  const variables = Array.from({ length: 10_000 }, (_, index) => ({ name: `variable_${index}`, value: `value-${index}-${'x'.repeat(20)}`, secret: false, needsReentry: false }));
  const environments: ImpEnvironment[] = [{ name: 'shared', kind: 'shared', isDefault: false, variables }];
  for (let index = 0; index < 800; index++) environments.push({ name: `env${index}`, kind: 'named', isDefault: false, variables: [{ name: 'own', value: '1', secret: false, needsReentry: false }] });
  const sink = new FindingSink();
  within('800 environments', 500, () => {
    const result = renderEnvironments(environments, sink, { restClient: true, maxBytes: 64 * 1024 * 1024 });
    assert.deepEqual(result.files, []);
  });
  assert.ok(sink.flush().some(finding => finding.code === 'TC-TOO-LARGE'));
  // Within the limit they are written as before.
  const small = renderEnvironments(environments.slice(0, 3), new FindingSink(), { restClient: true, maxBytes: 64 * 1024 * 1024 });
  assert.equal(small.files.length > 0, true);
});

test('Many findings of one kind are counted, not all written out: the report stays small', () => {
  const files = Array.from({ length: 2000 }, (_, index) => file(`collections/tc_col_${index}.json`, 'v4-collection', v4(`C${index}`, [], Array.from({ length: 8 }, (_, n) => req(`ws${n}`, '', { reqType: 'ws' })))));
  const outcome: { report: string } = { report: '' };
  within('2,000 collections', 15_000, () => { outcome.report = importSource(source(...files)).files.find(item => item.path === 'IMPORT_REPORT.md')?.content ?? ''; });
  const report = outcome.report;
  assert.ok(report.length > 0 && report.length < 100_000, `the report is ${report.length} characters`);
  assert.match(report, /\| \.\.\. and 1800 more \| \| \|/, 'the table of written folders is cut, with a count');
  assert.match(report, /- \.\.\. and \d+ more/, 'a list of places is cut, with a count');
});

test('A request with tens of thousands of different variables that have no value is put together in one pass: 80,000 names took 9 seconds', async () => {
  const { resolveText } = await import('../../src/core/vars');
  const { buildWire } = await import('../../src/engine/build');
  const { newRequest } = await import('../../src/core/model');
  const { effectiveRequest } = await import('../../src/core/inherit');
  const clock = { now: () => 0, random: () => 0 };
  const text = Array.from({ length: 80_000 }, (_, index) => `{{v${index}}}`).join(',');
  within('resolveText', 2000, () => { const result = resolveText(text, [], { clock }); assert.equal(result.unresolved.length, 80_000); assert.equal(result.unresolved[0], 'v0'); assert.equal(result.unresolved[79_999], 'v79999'); });
  const request = { ...newRequest('R', 'many'), url: 'https://x.test/a', headers: [{ name: 'X-Many', value: text, enabled: true, description: '' }, { name: 'X-Many-2', value: text, enabled: true, description: '' }] };
  within('buildWire', 4000, () => {
    const built = buildWire({ request, effective: effectiveRequest(request, [], {}), scopes: [], clock, resolveFile: () => undefined });
    assert.equal(built.unresolved.length, 80_000, 'the same names in two headers are noted once');
  });
});
