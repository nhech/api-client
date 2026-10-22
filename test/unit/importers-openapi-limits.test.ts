import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENAPI_LIMITS, parseOpenApi } from '../../src/importers/openapi';
import { importedChars, requestChars, type Imported, type ImportedFolder } from '../../src/importers/types';

/** What a description can do to the machine of whoever imports it: more work, and more text, than its size says. */

const parse = (value: unknown): Imported => {
  const result = parseOpenApi(typeof value === 'string' ? value : JSON.stringify(value));
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.imported;
};
const noteTexts = (imported: Imported): string[] => imported.notes.map(note => note.message);
const requestsOf = (imported: Imported): ImportedFolder['requests'] => {
  const all: ImportedFolder['requests'] = [];
  const visit = (folder: ImportedFolder): void => { all.push(...folder.requests); folder.folders.forEach(visit); };
  imported.collections.forEach(visit);
  return all;
};
const shared = (count: number, operation: unknown, extra: Record<string, unknown> = {}) => {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < count; index++) paths[`/p${index}`] = { $ref: '#/x-op' };
  return { openapi: '3.0.3', info: { title: 'Shared' }, 'x-op': operation, paths, ...extra };
};

test('A reference is followed once and its text is not cut apart again and again; one that is not a pointer is not followed', () => {
  const long = `#/missing${'/a'.repeat(128 * 1024)}`;
  const operation = { get: { parameters: Array.from({ length: 200 }, () => ({ $ref: '#/components/parameters/P' })), responses: {} } };
  const started = Date.now();
  const imported = parse(shared(50, operation, { components: { parameters: { P: { $ref: long } } } }));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(requestsOf(imported).length, 50, 'the operations are still imported');
  assert.ok(noteTexts(imported).some(note => new RegExp(`longer than ${OPENAPI_LIMITS.refChars} characters`).test(note)), noteTexts(imported).join('\n'));
  // A reference that is short is followed, and the answer for it is the same wherever it is met.
  const same = parse(shared(3, { get: { parameters: [{ $ref: '#/components/parameters/Q' }], responses: {} } }, { components: { parameters: { Q: { name: 'q', in: 'query', example: 'yes' } } } }));
  assert.deepEqual(requestsOf(same).map(request => request.query.map(row => `${row.name}=${row.value}`)), [['q=yes'], ['q=yes'], ['q=yes']]);
});

test('An example that many operations share is written out once; one that cannot fit in a body is measured, not written', () => {
  const example = { items: Array.from({ length: 60_000 }, (_, index) => ({ id: index, name: `name ${index}` })) };
  const operation = { post: { requestBody: { content: { 'application/json': { schema: { type: 'object' }, example }, 'application/xml': { schema: { type: 'object' }, example } } }, responses: {} } };
  const started = Date.now();
  const imported = parse(shared(300, operation));
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.equal(requestsOf(imported).length, 300);
  assert.deepEqual(requestsOf(imported)[0]?.body, { kind: 'json', text: '' }, 'an example of megabytes does not become a body');
  const xml = parse(shared(300, { post: { requestBody: { content: { 'application/xml': { schema: { type: 'object' }, example } } }, responses: {} } }));
  assert.deepEqual(requestsOf(xml)[0]?.body, { kind: 'xml', text: '' });
  // An example nested deeper than a body is refused instead of walked.
  let deep: unknown = 'leaf';
  for (let level = 0; level < 500; level++) deep = { next: deep };
  const nested = parse(shared(3, { post: { requestBody: { content: { 'application/json': { schema: {}, example: deep } } }, responses: {} } }));
  assert.deepEqual(requestsOf(nested)[0]?.body, { kind: 'json', text: '' });
});

test('Operations that share a body get their own copy of it, with the notes that belong to each', () => {
  const operation = { post: { requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, label: { type: 'string' } } } } } }, responses: {} } };
  const imported = parse(shared(3, operation));
  const [first, second, third] = requestsOf(imported);
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  assert.deepEqual(first.body, second.body);
  assert.notEqual(first.body, second.body, 'two requests never hold the same object');
  if (first.body.kind === 'multipart') first.body.parts.length = 0;
  assert.equal(second.body.kind === 'multipart' ? second.body.parts.length : -1, 2, 'changing one does not change the other');
  const files = imported.notes.filter(note => /files of the form/.test(note.message));
  assert.equal(files.length, 3, 'each operation is told about its file');
  assert.deepEqual(files.map(note => note.where).sort(), ['GET /p0', 'GET /p1', 'GET /p2'].map(item => item.replace('GET', 'POST')));
});

test('Operations that share long lists of parameters stop at the size that an import may write, and it is said', () => {
  const parameters = Array.from({ length: 200 }, (_, index) => ({ name: `p${index}`, in: 'query', required: true, example: 'v'.repeat(1000), description: 'd'.repeat(190) }));
  const started = Date.now();
  const imported = parse(shared(3000, { get: { parameters, responses: {} } }));
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
  const requests = requestsOf(imported);
  assert.ok(requests.length > 0 && requests.length < 3000, `${requests.length} requests`);
  assert.ok(importedChars(imported) <= OPENAPI_LIMITS.outputChars + 2 * requestChars(requests[0] as never), 'about the limit, and not more than one request over it');
  assert.ok(noteTexts(imported).some(note => new RegExp(`Only the first ${requests.length} operations were imported: their files would hold more than 32 MB`).test(note)), noteTexts(imported).join('\n'));
});

test('A description that is large and real is imported in full: many operations, bodies from shared schemas, parameters by reference', () => {
  const schemas: Record<string, unknown> = {};
  for (let index = 0; index < 150; index++) {
    const properties: Record<string, unknown> = {};
    for (let field = 0; field < 30; field++) properties[`f${field}`] = field % 5 === 0 ? { $ref: `#/components/schemas/S${(index + field + 1) % 150}` } : { type: field % 2 === 0 ? 'string' : 'integer' };
    schemas[`S${index}`] = { type: 'object', required: ['f1'], properties };
  }
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < 4000; index++) {
    paths[`/r${index}/{id}`] = {
      parameters: [{ $ref: '#/components/parameters/Id' }],
      post: { tags: [`T${index % 40}`], summary: `Make ${index}`, parameters: [{ $ref: '#/components/parameters/Page' }, { $ref: '#/components/parameters/Limit' }], requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/S${index % 150}` } } } }, responses: { 201: { description: 'made' } } }
    };
  }
  const started = Date.now();
  const imported = parse({
    openapi: '3.0.3', info: { title: 'Large' }, paths,
    components: { schemas, parameters: { Id: { name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, Page: { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } }, Limit: { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } } } }
  });
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
  assert.equal(requestsOf(imported).length, 4000);
  assert.ok(!noteTexts(imported).some(note => /Only the first/.test(note)), noteTexts(imported).join('\n'));
});

test('A reference that thousands of operations share is walked once: its answer is kept', () => {
  // A reference just under the limit, to something that is not there: cutting its text apart costs about a thousand pieces, a million times without the cache.
  const ref = `#/missing${'/a'.repeat(Math.floor((OPENAPI_LIMITS.refChars - 20) / 2))}`;
  const operation = { get: { parameters: Array.from({ length: 200 }, () => ({ $ref: '#/components/parameters/P' })), responses: {} } };
  const started = Date.now();
  const imported = parse(shared(3000, operation, { components: { parameters: { P: { $ref: ref } } } }));
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.equal(requestsOf(imported).length, 3000);
  assert.ok(noteTexts(imported).some(note => /points? at nothing in the file/.test(note)), noteTexts(imported).join('\n'));
});

test('Past the limit of steps no more operations are taken, and the notes say how many were', () => {
  // A chain of 20 references for each of 400 parameters of each operation: about 8,000 steps for an operation, and the limit is 10 million.
  const parameters: Record<string, unknown> = { P19: { name: 'q', in: 'query', example: 'v' } };
  for (let index = 0; index < 19; index++) parameters[`P${index}`] = { $ref: `#/components/parameters/P${index + 1}` };
  const list = Array.from({ length: 200 }, () => ({ $ref: '#/components/parameters/P0' }));
  const imported = parse(shared(2500, { parameters: list, get: { parameters: list, responses: {} } }, { components: { parameters } }));
  const count = requestsOf(imported).length;
  assert.ok(count > 100 && count < 2500, `${count} operations`);
  assert.ok(noteTexts(imported).some(note => new RegExp(`Only the first ${count} operations were imported: the references of the description lead to far more work`).test(note)), noteTexts(imported).join('\n'));
});

test('A value nested deeper than a body can be is not written out, one just inside the limit is', () => {
  const nested = (levels: number): unknown => { let value: unknown = 'leaf'; for (let level = 0; level < levels; level++) value = { next: value }; return value; };
  const body = (example: unknown) => requestsOf(parse(shared(1, { post: { requestBody: { content: { 'application/json': { schema: {}, example } } }, responses: {} } })))[0]?.body;
  const inside = body(nested(50));
  assert.ok(inside?.kind === 'json' && inside.text.includes('leaf'), 'fifty levels are written');
  assert.deepEqual(body(nested(70)), { kind: 'json', text: '' }, 'seventy are not');
});
